import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
import { open, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type {
  EncryptOptions,
  FileNode,
  IgnorePreview,
  LogEvent,
  PackageOptions,
  Project,
  ProjectList,
  RuntimeStatus,
  Settings,
  Stage,
  StageEvent,
  StageOutcome,
  ToolProgress,
  ToolStatus,
} from "./types";

export const api = {
  listProjects: () => invoke<ProjectList>("list_projects"),
  loadProject: (id: string) => invoke<Project>("load_project", { id }),
  createProject: (name: string, exeFile: string, outputDir: string) =>
    invoke<Project>("create_project", { name, exeFile, outputDir }),
  saveProject: (project: Project) => invoke<void>("save_project", { project }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  runStage: (project: Project, stage: Stage) =>
    invoke<StageOutcome>("run_stage", { project, stage }),
  scanTree: (root: string) => invoke<FileNode>("scan_tree", { root }),
  exeVersion: (path: string) => invoke<string>("exe_version", { path }),
  toolStatus: () => invoke<ToolStatus>("tool_status"),
  /** 下载并安装一个外部工具，返回刷新后的工具状态 */
  downloadTool: (key: string) => invoke<ToolStatus>("download_tool", { key }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<ToolStatus>("save_settings", { settings }),
  environmentStatus: () => invoke<RuntimeStatus>("environment_status"),
  /** 由开关生成模板：模板只有一份定义，放在 Rust 侧 */
  renderEncryptConfig: (options: EncryptOptions) =>
    invoke<string>("render_encrypt_config", { options }),
  renderPackageScript: (options: PackageOptions) =>
    invoke<string>("render_package_script", { options }),
  /** 打包排除项的预览（自动项 / 自定义项 / 最终 Excludes 字符串） */
  projectIgnores: (project: Project) => invoke<IgnorePreview>("project_ignores", { project }),
  placeholders: () => invoke<[string, string][]>("placeholders"),
};

// ---------------------------------------------------------------- 窗口控制

/** 与 `@tauri-apps/api/window` 内部的 ResizeDirection 保持一致（该类型未对外导出）。 */
export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

/** 应用版本号（取自 tauri.conf.json 的 version，即打包版本）。 */
export async function appVersion(): Promise<string> {
  return getVersion();
}

export async function minimizeWindow(): Promise<void> {
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<boolean> {
  const win = getCurrentWindow();
  await win.toggleMaximize();
  return win.isMaximized();
}

export async function closeWindow(): Promise<void> {
  await getCurrentWindow().close();
}

export async function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

export async function onWindowResized(handler: () => void): Promise<UnlistenFn> {
  return getCurrentWindow().onResized(() => handler());
}

// ---------------------------------------------------------------- 桌面化

/**
 * 窗口以 `visible: false` 创建，等前端把皮肤写进根元素、首帧绘制完成后再显示，
 * 这样启动过程不会先闪一下原生白底。
 */
export async function showWindow(): Promise<void> {
  await getCurrentWindow().show();
}

/**
 * 同步窗口自身的底色。窗口缩放或最大化时新暴露的区域会先由窗口底色填充，
 * 若不同步就会在深色主题下闪出白边。
 */
export async function setWindowBackground(color: string): Promise<void> {
  try {
    await getCurrentWebviewWindow().setBackgroundColor(color);
  } catch {
    // 浏览器预览环境没有该 API，忽略
  }
}

/** Windows 上 Mica Alt 材质是否生效（生效后标题栏可用半透明底）。 */
export async function windowMaterial(): Promise<boolean> {
  try {
    return await invoke<boolean>("window_material");
  } catch {
    return false;
  }
}

/**
 * 无边框窗口下 `decorations: false` 会让 tao 去掉 `WS_THICKFRAME`，
 * 系统不再提供边缘拖拽缩放，因此由前端的热区主动发起缩放。
 */
export async function startResize(direction: ResizeDirection): Promise<void> {
  await getCurrentWindow().startResizeDragging(direction);
}

export function onLog(handler: (event: LogEvent) => void): Promise<UnlistenFn> {
  return listen<LogEvent>("pipeline:log", (e) => handler(e.payload));
}

export function onStage(handler: (event: StageEvent) => void): Promise<UnlistenFn> {
  return listen<StageEvent>("pipeline:stage", (e) => handler(e.payload));
}

/** 外部工具下载进度（下载 / 校验 / 解压 / 安装）。 */
export function onToolProgress(handler: (event: ToolProgress) => void): Promise<UnlistenFn> {
  return listen<ToolProgress>("tools:progress", (e) => handler(e.payload));
}

/**
 * 文件 / 目录选择框的统一入口。
 *
 * 底层是 tauri-plugin-dialog，失败原因通常是环境性的：插件没注册、
 * capability 里少了 `dialog:allow-open`、或者干脆跑在浏览器预览里（没有 Tauri IPC）。
 * 这些情况下 `invoke` 会 reject；调用方若不 catch，就变成一条无人处理的 Promise 拒绝，
 * 用户看到的现象是「点了浏览没反应」。所以这里统一包一层，把原因翻译成人话再抛。
 */
async function openPicker(options: OpenDialogOptions): Promise<string | null> {
  try {
    const picked = await open(options);
    return typeof picked === "string" ? picked : null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`无法打开系统文件选择框：${reason}`);
  }
}

/** 多选版本：取消返回空数组（而不是 null），调用方只需判断长度。 */
async function openPickerMany(options: OpenDialogOptions): Promise<string[]> {
  try {
    const picked = await open(options);
    if (Array.isArray(picked)) return picked;
    return typeof picked === "string" ? [picked] : [];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`无法打开系统文件选择框：${reason}`);
  }
}

export function pickExe(): Promise<string | null> {
  return openPicker({
    multiple: false,
    directory: false,
    title: "选择主程序文件",
    filters: [{ name: "可执行文件", extensions: ["exe"] }],
  });
}

export function pickToolExe(title: string): Promise<string | null> {
  return openPicker({
    multiple: false,
    directory: false,
    title,
    filters: [{ name: "可执行文件", extensions: ["exe"] }],
  });
}

export function pickDirectory(title: string): Promise<string | null> {
  return openPicker({ multiple: false, directory: true, title });
}

/** 多选文件（打包排除项用：一次挑几个文件，不必来回开对话框）。 */
export function pickFiles(title: string): Promise<string[]> {
  return openPickerMany({ multiple: true, directory: false, title });
}

/** 单选文件，可指定扩展名过滤（强名称密钥、证书等）。 */
export function pickFile(
  title: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  return openPicker({ multiple: false, directory: false, title, filters });
}

export async function reveal(path: string): Promise<void> {
  await revealItemInDir(path);
}
