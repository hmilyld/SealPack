import "./style.css";

import {
  api,
  appVersion,
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onLog,
  onStage,
  onWindowResized,
  pickDirectory,
  pickExe,
  pickFile,
  pickFiles,
  reveal,
  setWindowBackground,
  startResize,
  toggleMaximizeWindow,
  windowMaterial,
  type ResizeDirection,
} from "./api";
import { createFilePicker, type FilePickerHandle } from "./components/file-picker";
import { attachContextMenu, closeContextMenu, type MenuEntry } from "./components/context-menu";
import { createLogPanel, logPanelText } from "./components/log-panel";
import { confirmDialog, newProjectDialog, promptDialog } from "./components/modal";
import { settingsDialog } from "./components/settings-dialog";
import { toast } from "./components/toast";
import {
  installDesktopBehaviour,
  registerShortcut,
  revealWindowWhenReady,
  shortcutLabel,
} from "./desktop";
import { createDesignController, SKINS } from "./skin";
import { baseName, esc, isUnder, relativeTo } from "./util";
import {
  ENCRYPT_GROUPS,
  ENCRYPT_PRESETS,
  PACKAGE_GROUPS,
  STAGE_META,
  STEP_META,
  STEP_ORDER,
  type FileNode,
  type IgnorePreview,
  type OptField,
  type OptGroup,
  type Project,
  type RuntimeStatus,
  type Settings,
  type Stage,
  type StageStatus,
  type StepId,
  type ToolStatus,
} from "./types";

// ---------------------------------------------------------------- 常量

/** 版权署名。 */
const AUTHOR = "hmilyld.com";

const ICON_SHIELD = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 5v7c0 4.6 3.4 8.6 8 10 4.6-1.4 8-5.4 8-10V5l-8-3Zm0 5.2a2.4 2.4 0 0 1 1.3 4.4l.7 3.4h-4l.7-3.4A2.4 2.4 0 0 1 12 7.2Z"/></svg>`;

const ICON_MIN = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M3.5 8h9"/></svg>`;
const ICON_MAX = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3.8" y="3.8" width="8.4" height="8.4" rx="1"/></svg>`;
const ICON_RESTORE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="5.6" width="7.4" height="7.4" rx="1"/><path d="M5.6 5.6V4.4A1.4 1.4 0 0 1 7 3h4.6A1.4 1.4 0 0 1 13 4.4V9a1.4 1.4 0 0 1-1.4 1.4h-1.2"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

/** 阶段状态 → 样式类（.status 的修饰类由皮肤决定具体长相） */
const STATUS_CLASS: Record<StageStatus, string> = {
  idle: "",
  running: "is-running",
  ok: "is-done",
  skipped: "is-skipped",
  failed: "is-failed",
};

const STATUS_TEXT: Record<StageStatus, string> = {
  idle: "待执行",
  running: "执行中",
  ok: "已完成",
  skipped: "已跳过",
  failed: "失败",
};

// ---------------------------------------------------------------- 状态

const app = document.getElementById("app")!;

/** 设计（皮肤）切换的单一状态源：皮肤与主题都挂在根元素上，全窗口同步生效。 */
const design = createDesignController();

let projects: Project[] = [];
let current: Project | null = null;
let toolStatus: ToolStatus | null = null;
let appSettings: Settings = { ilmergePath: "", confuserPath: "", isccPath: "" };
let runtimeStatus: RuntimeStatus | null = null;
let placeholders: [string, string][] = [];
let statuses: Record<Stage, StageStatus> = { merge: "idle", encrypt: "idle", package: "idle" };
let artifacts: Partial<Record<Stage, string[]>> = {};
let busy = false;

/** 当前向导步骤。切换工程后保留在原来的步骤上，方便对比多个工程。 */
let step: StepId = "setup";

/** 目录扫描结果（合并步骤用）。为空表示还没扫过。 */
let treeNode: FileNode | null = null;
let treeError = "";
let scanning = false;
let picker: FilePickerHandle | null = null;

/** 打包排除项预览（自动带入 / 自定义 / 最终 Excludes 字符串） */
let ignores: IgnorePreview | null = null;

/** 高级区（模板编辑器）是否展开。默认收起 —— 绝大多数用户不需要看模板。 */
const advancedOpen: Record<"encrypt" | "package", boolean> = { encrypt: false, package: false };

let activeTextarea: HTMLTextAreaElement | null = null;

let saveTimer: number | undefined;
let ignoreTimer: number | undefined;
let saveState: "idle" | "dirty" | "saving" | "saved" | "error" = "idle";

/**
 * 异步请求的「代次」，用来作废在途的旧请求。
 *
 * `ensureTree` 与 `refreshIgnores` 都是异步的，而它们的写回目标
 * （`treeNode` / `ignores`）是全局的。切换工程或更换主程序之后，旧请求
 * 若晚于新请求返回，就会把上一个工程的扫描结果挂到当前工程上 ——
 * 合并页会拿 A 的目录树给 B 勾选，`picker.onChange` 把 A 的路径写进
 * B 的 `mergeDlls`。发起请求时递增，回来时对不上就直接丢弃。
 *
 * 两者分开计数：勾选文件会触发排除项刷新，若共用同一个计数器，
 * 「扫描进行中勾选文件」就会把自己的扫描结果作废掉。
 */
let scanEpoch = 0;
let ignoreEpoch = 0;

// ---------------------------------------------------------------- 骨架
//
// 标题栏只放品牌 + 视图命令 + 窗口控制（Fluent 的 CommandBar 位置），
// 工具链状态、版本号、版权都下沉到窗口底部的状态栏 —— 这是本地程序的惯例，
// 也是「看起来像网页」的主要修正在于：标题栏不该是一排状态胶囊。

app.innerHTML = `
<div class="app">
  <header class="titlebar" data-tauri-drag-region="deep">
    <div class="brand">
      <span class="brand-mark">${ICON_SHIELD}</span>
      <span class="brand-name">SealPack</span>
      <span class="brand-version" id="app-version" title="打包版本号">v—</span>
    </div>

    <span class="spacer"></span>

    <span class="credit" id="save-state"></span>

    <div class="skin-switch" id="skin-switch" role="group" aria-label="界面设计"></div>
    <button class="btn btn-quiet btn-sm" id="theme-toggle" type="button"></button>
    <button class="btn btn-quiet btn-sm" id="settings-btn" type="button">
      <span>设置</span><span class="kbd" id="settings-kbd"></span>
    </button>

    <div class="wincontrols">
      <button class="win-btn" id="win-min" type="button" title="最小化">${ICON_MIN}</button>
      <button class="win-btn" id="win-max" type="button" title="最大化">${ICON_MAX}</button>
      <button class="win-btn win-close" id="win-close" type="button" title="关闭">${ICON_CLOSE}</button>
    </div>
  </header>

  <div id="env-banner"></div>

  <div class="body">
    <aside class="rail">
      <div class="rail-head">
        <span class="rail-title">工程</span>
        <span class="count" id="project-count">0</span>
        <span class="spacer"></span>
        <button class="btn btn-primary btn-sm" id="new-project" type="button">新建</button>
      </div>
      <div class="projects" id="project-list"></div>
      <div class="rail-foot" id="rail-foot"></div>
    </aside>

    <main class="workspace" id="workspace"></main>
  </div>

  <div id="log-slot"></div>

  <footer class="statusbar">
    <div class="toolchain" id="toolchain"></div>
    <span class="spacer"></span>
    <span class="statusbar-item is-static" id="status-version" title="打包版本号">SealPack v—</span>
    <span class="statusbar-item is-static" id="status-copyright" title="版权信息">© ${new Date().getFullYear()} ${AUTHOR}</span>
  </footer>
</div>
`;

const workspace = document.getElementById("workspace") as HTMLElement;
const projectList = document.getElementById("project-list") as HTMLElement;
const projectCount = document.getElementById("project-count") as HTMLElement;
const toolchainHost = document.getElementById("toolchain") as HTMLElement;
const saveStateHost = document.getElementById("save-state") as HTMLElement;
const envBannerHost = document.getElementById("env-banner") as HTMLElement;
const skinSwitch = document.getElementById("skin-switch") as HTMLElement;
const themeToggle = document.getElementById("theme-toggle") as HTMLButtonElement;
const logPanel = createLogPanel({ onCopy: (text) => void copyText(text) });
(document.getElementById("log-slot") as HTMLElement).appendChild(logPanel.el);

// ---------------------------------------------------------------- 设计切换
//
// 切换器只改根元素上的 data-skin / data-theme，不重建任何 DOM：
// 两套设计共用同一套结构，差异全部由皮肤 CSS 表达，因此不存在
// 「切到一半、部分元素还是旧皮肤」的中间态；对话框、右键菜单与提示条挂在 body 上，
// 同样继承根元素的皮肤，不会出现局部串味。

function renderSkinSwitch() {
  skinSwitch.innerHTML = "";

  for (const meta of SKINS) {
    const btn = document.createElement("button");
    btn.className = "skin-opt";
    btn.type = "button";
    // 注意用 data-opt 而不是 data-skin：data-skin 是根元素皮肤的专属选择器，
    // 若按钮自己带上它会就地覆盖一套令牌，导致标签颜色错乱。
    btn.dataset.opt = meta.key;
    btn.title = `${meta.name}（手动模式下默认${meta.defaultTheme === "dark" ? "深色" : "浅色"}）`;
    btn.setAttribute("aria-pressed", "false");

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = meta.swatch;

    const label = document.createElement("span");
    label.textContent = meta.label;

    btn.append(swatch, label);
    btn.onclick = () => design.setSkin(meta.key);
    skinSwitch.appendChild(btn);
  }
}

/** 把控制器里的状态回灌到界面，保证按钮显示与实际皮肤永远一致。 */
function syncDesignUi() {
  const active = design.get().skin;
  skinSwitch.querySelectorAll<HTMLElement>(".skin-opt").forEach((btn) => {
    const on = btn.dataset.opt === active;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", String(on));
  });

  const mode = design.mode();
  const label = mode === "auto" ? "自动" : mode === "dark" ? "深色" : "浅色";
  const icon = mode === "auto" ? "◐" : mode === "dark" ? "☾" : "☀";
  const hasMenu = design.materialSupported();
  // 材质开关挂在右键菜单里，而「右键还有东西」这件事本身没有任何视觉线索 ——
  // 系统支持时补一个下拉指示，否则那个开关实际上等于不存在。
  themeToggle.textContent = hasMenu ? `${icon} ${label} ▾` : `${icon} ${label}`;
  if (hasMenu) themeToggle.setAttribute("aria-haspopup", "true");
  else themeToggle.removeAttribute("aria-haspopup");
  const themeHint =
    mode === "auto"
      ? "明暗跟随系统，点击改为固定深色"
      : `明暗固定为${label}，点击切换`;
  themeToggle.title = hasMenu
    ? `${themeHint}｜右键：窗口材质（当前${design.materialOn() ? "开" : "关"}）`
    : themeHint;
  themeToggle.setAttribute("aria-label", `明暗：${label}`);

  // 窗口自身的底色跟着主题走：缩放/最大化时新暴露的区域不会闪白边
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg) void setWindowBackground(bg);
  });
}

themeToggle.onclick = () => design.cycleTheme();

/* 窗口材质（Windows 11 Mica Alt）的显式开关。
   放在主题按钮的右键菜单里：它属于「外观」这一类决定，和明暗同源；
   系统不支持时置灰并说明原因，而不是假装能点。 */
attachContextMenu(themeToggle, () => {
  const supported = design.materialSupported();
  const on = design.materialOn();
  return [
    {
      label: `窗口材质（Mica Alt）：${on ? "开" : "关"}`,
      disabled: !supported,
      onSelect: () => design.toggleMaterial(),
    },
    "separator",
    {
      label: supported ? "半透明窗口基底，跟随系统桌面" : "本机不支持（需要 Windows 11）",
      disabled: true,
    },
  ];
});

design.subscribe(() => syncDesignUi());

// ---------------------------------------------------------------- 保存状态

function setSaveState(next: typeof saveState) {
  saveState = next;
  const map: Record<typeof saveState, string> = {
    idle: "",
    dirty: "有未保存的修改",
    saving: "保存中…",
    saved: "已保存",
    error: "保存失败",
  };
  saveStateHost.textContent = map[next];
  saveStateHost.className = `credit${next === "error" ? " is-error" : next === "saved" ? " is-ok" : ""}`;
}

function scheduleSave() {
  const proj = current;
  if (!proj) return;
  setSaveState("dirty");
  window.clearTimeout(saveTimer);
  // 回调里用捕获到的 proj 而不是重新读 current：万一在防抖窗口内切了工程，
  // 这次保存也必须落到「用户实际改过的那个工程」上。
  saveTimer = window.setTimeout(async () => {
    saveTimer = undefined;
    setSaveState("saving");
    try {
      await api.saveProject(proj);
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      toast(String(err), "error");
    }
  }, 600);
}

/** 丢掉待落盘的修改，不写盘（工程即将被删除时用）。 */
function discardPendingSave() {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
}

/**
 * 立刻结算待落盘的修改。
 *
 * 必须在替换 `current` **之前**调用：`scheduleSave` 是 600ms 防抖，
 * 若用户改完字段立刻切走工程，定时器会在切换之后才触发，那次修改
 * 既不会被保存、也不会留在界面上 —— 属于静默的数据丢失。
 */
async function flushPendingSave(): Promise<void> {
  if (saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  const proj = current;
  if (!proj || saveState !== "dirty") return;
  setSaveState("saving");
  try {
    await api.saveProject(proj);
    setSaveState("saved");
  } catch (err) {
    setSaveState("error");
    toast(String(err), "error");
  }
}

// ---------------------------------------------------------------- 工具链状态

function toolTip(item: ToolStatus["items"][number]): string {
  return [
    `${item.label}：${item.available ? "可用" : "未找到"}`,
    `路径：${item.path}`,
    item.overridden ? `内置默认：${item.defaultPath}` : "",
    item.needsDotnet ? "依赖 .NET Framework 运行时" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderToolchain() {
  const foot = document.getElementById("rail-foot");

  if (!toolStatus) {
    toolchainHost.innerHTML = "";
    if (foot) foot.textContent = "";
    return;
  }

  toolchainHost.innerHTML = toolStatus.items
    .map((item) => {
      const cls = [
        "statusbar-item",
        item.available ? "" : "is-missing",
        item.overridden ? "is-custom" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<button class="${cls}" type="button" data-tool="${esc(item.key)}" title="${esc(toolTip(item))}"><span class="dot"></span>${esc(item.label)}</button>`;
    })
    .join("");

  toolchainHost.querySelectorAll<HTMLElement>("[data-tool]").forEach((el) => {
    el.onclick = () => void openSettings();
  });

  if (foot) {
    foot.textContent = `内置工具 ${toolStatus.toolsDir}`;
    foot.title = toolStatus.toolsDir;
  }
}

// ---------------------------------------------------------------- 运行环境提示

function renderEnvBanner() {
  if (!runtimeStatus || runtimeStatus.dotnetAvailable) {
    envBannerHost.innerHTML = "";
    return;
  }

  const dependent = (toolStatus?.items ?? [])
    .filter((t) => t.needsDotnet)
    .map((t) => t.label)
    .join(" 与 ");

  envBannerHost.innerHTML = `
    <div class="banner">
      <span class="banner-icon">!</span>
      <p>
        未检测到 .NET Framework 4.x。${esc(dependent || "ILMerge 与 ConfuserEx")} 是 .NET Framework 程序，
        <b>「程序合并」与「程序加密」将无法执行</b>；安装包打包使用原生的 Inno Setup，不受影响。
        可安装 .NET Framework 4.8 后重启本程序，或在
        <button type="button" id="env-open-settings">设置</button>
        中改为指向其它替代工具。
      </p>
    </div>`;

  const link = document.getElementById("env-open-settings");
  if (link) link.onclick = () => void openSettings();
}

// ---------------------------------------------------------------- 设置

async function openSettings() {
  if (!toolStatus || !runtimeStatus) {
    toast("环境信息尚未就绪，请稍后再试", "error");
    return;
  }

  const next = await settingsDialog({
    settings: appSettings,
    status: toolStatus,
    runtime: runtimeStatus,
  });
  if (!next) {
    // 取消也可能不是白取消：设置里可以直接下载工具。
    // 下载会改变「哪个工具可用」，所以也得重新拉一次状态。
    try {
      toolStatus = await api.toolStatus();
      renderToolchain();
    } catch {
      // 拉不到就算了：界面仍然是刚才的样子，不至于影响用户继续操作
    }
    return;
  }

  try {
    toolStatus = await api.saveSettings(next);
    appSettings = next;
    renderToolchain();
    renderEnvBanner();
    const broken = toolStatus.items.filter((t) => !t.available);
    if (broken.length > 0) {
      toast(`以下工具路径无效：${broken.map((t) => t.label).join("、")}`, "error");
    } else {
      toast("设置已保存", "success");
    }
  } catch (err) {
    toast(String(err), "error");
  }
}

// ---------------------------------------------------------------- 版本信息

async function renderVersion() {
  const brandHost = document.getElementById("app-version");
  const statusHost = document.getElementById("status-version");
  try {
    const version = await appVersion();
    if (brandHost) {
      brandHost.textContent = `v${version}`;
      brandHost.title = `打包版本 ${version}`;
    }
    if (statusHost) {
      statusHost.textContent = `SealPack v${version}`;
      statusHost.title = `打包版本 ${version}`;
    }
  } catch {
    // 浏览器预览环境无 app API，保留占位
  }
}

// ---------------------------------------------------------------- 窗口控制

let windowMaximized = false;
let resizeZones: HTMLElement[] = [];
let resizeFrame: number | undefined;

// `decorations: false` 会让 tao 去掉 WS_THICKFRAME，系统不再提供边缘拖拽缩放，
// 因此用 8 个透明的固定定位热区接管四个边与四个角。
const RESIZE_ZONES: { dir: ResizeDirection; style: string }[] = [
  { dir: "North", style: "top:0;left:8px;right:8px;height:4px;cursor:ns-resize" },
  { dir: "South", style: "bottom:0;left:8px;right:8px;height:4px;cursor:ns-resize" },
  { dir: "West", style: "left:0;top:8px;bottom:8px;width:4px;cursor:ew-resize" },
  { dir: "East", style: "right:0;top:8px;bottom:8px;width:4px;cursor:ew-resize" },
  { dir: "NorthWest", style: "top:0;left:0;width:10px;height:10px;cursor:nwse-resize" },
  { dir: "NorthEast", style: "top:0;right:0;width:10px;height:10px;cursor:nesw-resize" },
  { dir: "SouthWest", style: "bottom:0;left:0;width:10px;height:10px;cursor:nesw-resize" },
  { dir: "SouthEast", style: "bottom:0;right:0;width:10px;height:10px;cursor:nwse-resize" },
];

function mountResizeZones() {
  resizeZones = RESIZE_ZONES.map((zone) => {
    const el = document.createElement("div");
    el.className = "fixed z-30";
    el.setAttribute("style", zone.style);
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || windowMaximized) return;
      e.preventDefault();
      void startResize(zone.dir).catch(() => {});
    });
    document.body.appendChild(el);
    return el;
  });
}

function setResizeZonesEnabled(enabled: boolean) {
  for (const el of resizeZones) el.style.display = enabled ? "" : "none";
}

async function refreshMaximizeIcon() {
  const btn = document.getElementById("win-max");
  if (!btn) return;
  try {
    const maximized = await isWindowMaximized();
    // 状态没变就不动 DOM：拖拽窗口边缘会以每帧数十次的频率触发 resize，
    // 每次都重写 innerHTML 纯属浪费（也会让按钮的过渡动画反复重放）。
    if (maximized === windowMaximized && btn.innerHTML) return;
    windowMaximized = maximized;
    btn.innerHTML = windowMaximized ? ICON_RESTORE : ICON_MAX;
    btn.title = windowMaximized ? "向下还原" : "最大化";
    setResizeZonesEnabled(!windowMaximized);
  } catch {
    // 浏览器预览环境无窗口 API，忽略
  }
}

/**
 * resize 事件在一帧里可能来很多次，用 rAF 合并成一次查询。
 * 不合并的话，拖拽过程中会持续向 Rust 发 IPC。
 */
function scheduleMaximizeIconRefresh() {
  if (resizeFrame !== undefined) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = undefined;
    void refreshMaximizeIcon();
  });
}

function toggleMaximize() {
  return toggleMaximizeWindow()
    .then(() => refreshMaximizeIcon())
    .catch(() => {});
}

function wireWindowControls() {
  document.getElementById("win-min")!.onclick = () => {
    void minimizeWindow().catch(() => {});
  };
  document.getElementById("win-max")!.onclick = () => void toggleMaximize();
  document.getElementById("win-close")!.onclick = () => {
    void closeWindow().catch(() => {});
  };

  // 双击标题栏空白处切换最大化（Windows 惯例）
  document.querySelector(".titlebar")?.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    void toggleMaximize();
  });

  mountResizeZones();
  void onWindowResized(() => scheduleMaximizeIconRefresh()).catch(() => {});
  void refreshMaximizeIcon();
}

// ---------------------------------------------------------------- 右键菜单
//
// 桌面程序右键一定有菜单。WebView2 的原生菜单被禁掉了，
// 所以这里按当前皮肤自绘一套，并保持键盘可达。

function attachLogMenu() {
  const body = logPanel.el.querySelector<HTMLElement>(".log-body");
  if (!body) return;
  attachContextMenu(logPanel.el, () => {
    const hasOutput = body.querySelector("[data-line]") !== null;
    return [
      {
        label: "复制全部输出",
        disabled: !hasOutput,
        onSelect: () => void copyText(logPanelText(logPanel.el)),
      },
      "separator",
      { label: "清空日志", disabled: !hasOutput, onSelect: () => logPanel.clear() },
    ];
  });
}

/**
 * 文件树区域的右键菜单。
 *
 * 树里现在有一个搜索框，所以要先判断右键落在哪儿：
 * 落在输入框上给文本菜单，落在树上才给勾选操作 ——
 * 否则在搜索框上右键会弹出「全选 / 全不选」，看着就错。
 */
function attachPickerMenu(host: HTMLElement) {
  attachContextMenu(host, (event): MenuEntry[] => {
    const target = event.target as HTMLElement | null;
    const field = target?.closest("input, textarea") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (field) return inputMenuEntries(field);

    return [
      { label: "勾选当前结果", disabled: !picker, onSelect: () => picker?.pickVisible() },
      { label: "全选", disabled: !picker, onSelect: () => picker?.setAll(true) },
      { label: "全不选", disabled: !picker, onSelect: () => picker?.setAll(false) },
      "separator",
      { label: "清空已选与筛选", disabled: !picker, onSelect: () => picker?.clear() },
      { label: "重新扫描目录", onSelect: () => void rescanTree() },
    ];
  });
}

function findField(el: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  return el.querySelector("input, textarea");
}

/** 文本编辑菜单的条目。输入框、文本域、代码编辑器共用一份。 */
function inputMenuEntries(
  field: HTMLInputElement | HTMLTextAreaElement | null,
): MenuEntry[] {
  const hasSelection = field ? field.selectionStart !== field.selectionEnd : false;
  const editable = field ? !field.readOnly && !field.disabled : false;

  const exec = (cmd: "cut" | "copy" | "paste" | "selectAll") => () => {
    if (!field) return;
    field.focus();
    const ok = document.execCommand(cmd);
    if (!ok && cmd === "paste") toast("请使用 Ctrl+V 粘贴", "info");
  };

  return [
    { label: "剪切", shortcut: "Ctrl+X", disabled: !hasSelection || !editable, onSelect: exec("cut") },
    { label: "复制", shortcut: "Ctrl+C", disabled: !hasSelection, onSelect: exec("copy") },
    { label: "粘贴", shortcut: "Ctrl+V", disabled: !editable, onSelect: exec("paste") },
    "separator",
    { label: "全选", shortcut: "Ctrl+A", disabled: !field, onSelect: exec("selectAll") },
  ];
}

function attachInputMenu(el: HTMLElement) {
  attachContextMenu(el, () => inputMenuEntries(findField(el)));
}

/** 复制文本，优先用异步剪贴板，失败时退回 execCommand。 */
async function copyText(text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板", "success");
    return;
  } catch {
    // 继续走回退方案
  }
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("style", "position:fixed;left:-9999px;top:0");
  document.body.appendChild(scratch);
  scratch.select();
  const ok = document.execCommand("copy");
  scratch.remove();
  toast(ok ? "已复制到剪贴板" : "复制失败", ok ? "success" : "error");
}

// ---------------------------------------------------------------- 工程列表

function attachProjectMenu(row: HTMLElement, id: string) {
  attachContextMenu(row, (): MenuEntry[] => {
    // 运行期间不许换/删工程：`runStage` 是长任务，中途换目标会让「正在跑的阶段」
    // 落到另一个工程上（见 runStage 的快照说明）。
    if (busy) return [{ label: "正在执行，暂不可操作", disabled: true }];
    const project = projects.find((p) => p.id === id);
    if (!project) return [];
    return [
      {
        label: "打开主程序目录",
        disabled: !project.rootPath,
        onSelect: () => void reveal(project.rootPath).catch(() => toast("无法打开目录", "error")),
      },
      {
        label: "打开输出目录",
        disabled: !project.outputDir,
        onSelect: () => void reveal(project.outputDir).catch(() => toast("无法打开目录", "error")),
      },
      "separator",
      {
        label: "删除工程",
        danger: true,
        onSelect: () => void removeProject(project),
      },
    ];
  });
}

/**
 * 运行期间锁住左侧工程列表。
 *
 * 只禁用「执行」按钮是不够的：`busy` 时点另一个工程会让 `current` 换人，
 * 而在跑的阶段仍按旧目标继续（或反过来，用新目标执行旧阶段）。
 * 重建列表（renderProjectList）之后必须重新应用，所以这里也由它调用。
 */
function applyBusyLock() {
  projectList.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.disabled = busy;
  });
  const create = document.getElementById("new-project") as HTMLButtonElement | null;
  if (create) create.disabled = busy;
  projectList.classList.toggle("is-busy", busy);
}

function renderProjectList() {
  projectCount.textContent = String(projects.length);

  if (projects.length === 0) {
    projectList.innerHTML = `
      <div class="rail-empty">
        还没有工程<br />点击上方「新建」开始
      </div>`;
    applyBusyLock();
    return;
  }

  projectList.innerHTML = projects
    .map((p) => {
      const active = current?.id === p.id;
      return `
      <div class="project${active ? " is-active" : ""}" data-id="${esc(p.id)}">
        <button class="project-main" type="button" data-select>
          <span class="project-name">${esc(p.name)}</span>
          <span class="project-path" title="${esc(p.exeFile)}">${esc(p.exeFile || "未设置主程序")}</span>
        </button>
        <button class="btn btn-quiet btn-xs project-del" type="button" data-delete title="删除工程">删除</button>
      </div>`;
    })
    .join("");

  projectList.querySelectorAll<HTMLElement>("[data-id]").forEach((row) => {
    const id = row.dataset.id!;
    row.querySelector<HTMLElement>("[data-select]")!.onclick = () => {
      if (busy || current?.id === id) return;
      void selectProject(id);
    };
    row.querySelector<HTMLElement>("[data-delete]")!.onclick = (e) => {
      e.stopPropagation();
      if (busy) return;
      const target = projects.find((p) => p.id === id);
      if (target) void removeProject(target);
    };
    attachProjectMenu(row, id);
  });

  applyBusyLock();
}

// ---------------------------------------------------------------- 工作区
//
// 界面结构从「一屏塞三块」改成 5 步向导：主程序 → 合并 → 加密 → 打包 → 执行。
//
// 为什么这样切：
//   1. 配置与执行分开。前三步是「看一遍、点几下」，最后一步是「等结果」，
//      混在一起时用户不知道该先看哪里，也不知道点了执行会发生什么。
//   2. 每一步只出现一件事。原来的三块操作区同时在场，视觉噪音大，
//      而且「主程序」这种全局前置条件被塞进了第一块的头部，容易被忽略。
//   3. 步骤条本身可点。跳步、回看、只跑某一步都不需要额外入口。
//
// 硬约束：**所有能力都必须点得到**。模板编辑器（.crproj / .iss）降级为
// 高级区里的可折叠项，开关与列表才是主入口；用户永远不需要打开模板。

function emptyStateHtml(): string {
  return `
  <div class="empty">
    <div class="empty-inner">
      <div class="empty-mark">${ICON_SHIELD}</div>
      <h2>选择或新建一个工程</h2>
      <p>工程保存主程序路径、待合并程序集、加密开关与打包排除项。五个步骤按顺序走一遍就能出安装包，中途可以跳步，也可以跳过不需要的步骤。</p>
      <button class="btn btn-primary" id="empty-new" type="button">新建工程</button>
    </div>
  </div>`;
}

// `relativeTo` / `baseName` / `esc` 已抽到 `src/util.ts`：
// 它们原本在这里和 file-picker 里各有一份，而 relativeTo 还必须与
// Rust 的 `model::relative_to` 同义，留两份必然会漂移。

/** 无 `key` 的字段（如只读的「主程序所在目录」）也需要唯一 id，这里递增生成。 */
let fieldSeq = 0;

function fieldHtml(opts: {
  key?: keyof Project;
  label: string;
  value?: string;
  placeholder?: string;
  readonly?: boolean;
  /** 口令类字段：用 password 类型渲染 */
  secret?: boolean;
  action?: { id: string; label: string };
}): string {
  const id = opts.key ? `field-${opts.key}` : `field-anon-${(fieldSeq += 1)}`;
  const attrs = [
    opts.key ? `data-field="${opts.key}"` : "",
    opts.readonly ? "readonly" : "",
    `id="${id}"`,
    `type="${opts.secret ? "password" : "text"}"`,
    `placeholder="${esc(opts.placeholder ?? "")}"`,
  ]
    .filter(Boolean)
    .join(" ");
  return `
  <div class="field">
    <label class="field-label" for="${id}">${esc(opts.label)}</label>
    <div class="field-row">
      <input class="input" ${attrs} value="${esc(opts.value ?? "")}" spellcheck="false" />
      ${
        opts.action
          ? `<button class="btn btn-quiet btn-sm" type="button" data-act="${opts.action.id}">${esc(opts.action.label)}</button>`
          : ""
      }
    </div>
  </div>`;
}

/**
 * 开关行：左侧文字说明，右侧一个真正的 checkbox（视觉由 CSS 画成滑块）。
 *
 * 每一行都带一枚「默认 X」的小标：用户改过之后它会变样，
 * 这样「这个值本来是开还是关」永远不需要去翻文档。
 */
function optRowHtml(opts: {
  key: string;
  label: string;
  hint: string;
  checked: boolean;
  badge?: string;
  meta?: string;
  /** 条件显示：只有主开关处于这些取值时才出现 */
  when?: { key: string; in: (string | number | boolean)[]; negate?: boolean };
  /** 该开关会往模板里写什么（悬停可见，让「点开关」和「看模板」对得上） */
  writes?: string;
}): string {
  const title = opts.writes ? ` title="将写入模板：${esc(opts.writes)}"` : "";
  return `
  <label class="opt" data-opt-row="${esc(opts.key)}"${whenAttrs(opts.when)}${title}>
    <span class="opt-text">
      <span class="opt-label">${esc(opts.label)}${
        opts.badge ? `<span class="opt-badge">${esc(opts.badge)}</span>` : ""
      }</span>
      <span class="opt-hint">${esc(opts.hint)}</span>
      ${opts.meta ?? ""}
    </span>
    <span class="switch">
      <input type="checkbox" data-opt="${esc(opts.key)}" ${opts.checked ? "checked" : ""} />
      <span class="switch-ui" aria-hidden="true"></span>
    </span>
  </label>`;
}

// ---------------------------------------------------------------- 选项 schema 渲染
//
// 选项的描述在 types.ts 里（ENCRYPT_GROUPS / PACKAGE_GROUPS），这里只负责把它
// 变成 DOM。加一个选项 = 在 schema 里加一条，不需要动渲染代码。

const WHEN_SEP = "\u0001";

function whenAttrs(when?: {
  key: string;
  in: (string | number | boolean)[];
  negate?: boolean;
}): string {
  if (!when) return "";
  return ` data-when-key="${esc(when.key)}" data-when-in="${esc(
    when.in.map(String).join(WHEN_SEP),
  )}"${when.negate ? ' data-when-negate="1"' : ""}`;
}

/** 「默认 X」小标：值是默认值时低调，改过之后高亮 */
function defaultChip(f: OptField, value: unknown): string {
  const label =
    f.kind === "bool" ? (f.def ? "开" : "关") : String(f.def) === "" ? "空" : String(f.def);
  const changed = String(value) !== String(f.def);
  return `<span class="opt-default${changed ? " is-changed" : ""}" title="该选项的默认值">默认 ${esc(
    label,
  )}</span>`;
}

/** 把 schema 里的一个字段渲染成一行 */
function optFieldHtml(f: OptField, value: unknown): string {
  if (f.kind === "bool") {
    return optRowHtml({
      key: f.key,
      label: f.label,
      hint: f.hint,
      checked: Boolean(value),
      meta: defaultChip(f, value),
      when: f.when,
      writes: f.writes,
    });
  }

  // 控件带上 id，标签用 for 关联：读屏软件否则只会念出「编辑框」，
  // 而不会说出这是「密钥派生迭代次数」。
  const id = `opt-${f.key}`;
  let control = "";
  if (f.kind === "enum") {
    const options = (f.choices ?? [])
      .map((c) => {
        const selected = String(c.value) === String(value) ? " selected" : "";
        return `<option value="${esc(c.value)}"${selected}>${esc(c.label)}</option>`;
      })
      .join("");
    control = `<select class="input select" id="${id}" data-opt="${esc(f.key)}">${options}</select>`;
  } else if (f.kind === "number") {
    const range =
      f.min !== undefined || f.max !== undefined
        ? ` min="${f.min ?? 0}" max="${f.max ?? ""}"`
        : "";
    control = `<input class="input input-num" type="number" id="${id}" data-opt="${esc(f.key)}" value="${esc(
      String(value),
    )}"${range} spellcheck="false" />${
      f.unit ? `<span class="opt-unit">${esc(f.unit)}</span>` : ""
    }`;
  } else {
    const browse =
      f.kind === "path"
        ? `<button class="btn btn-quiet btn-sm" type="button" data-act="pick-snkey">浏览</button>`
        : "";
    // 口令类字段用 password 类型：肩窥与随手截图都不该泄露它
    control = `<input class="input" type="${f.secret ? "password" : "text"}" id="${id}" data-opt="${esc(
      f.key,
    )}" value="${esc(String(value))}" placeholder="${esc(
      String(f.def) || "留空",
    )}" spellcheck="false" />${browse}`;
  }

  const title = f.writes ? ` title="将写入模板：${esc(f.writes)}"` : "";
  return `
  <div class="opt is-field" data-opt-row="${esc(f.key)}"${whenAttrs(f.when)}${title}>
    <span class="opt-text">
      <label class="opt-label" for="${id}">${esc(f.label)}</label>
      <span class="opt-hint">${esc(f.hint)}</span>
      ${defaultChip(f, value)}
    </span>
    <span class="opt-control">${control}</span>
  </div>`;
}

function groupHtml(g: OptGroup, opts: Record<string, unknown>): string {
  // 只有布尔开关参与「已启用 N 项」的计数：把「字典大小=0」算成一项没有意义
  const bools = g.fields.filter((f) => f.kind === "bool").map((f) => f.key);
  return `
  <section class="opt-group" data-group="${esc(g.id)}" data-group-bools="${esc(bools.join(","))}">
    <div class="opt-group-head">
      <h4 class="opt-group-title">${esc(g.title)}</h4>
      ${bools.length > 0 ? `<span class="opt-group-count" data-group-count></span>` : ""}
    </div>
    <p class="opt-group-note">${esc(g.note)}</p>
    <div class="opt-group-body">
      ${g.fields.map((f) => optFieldHtml(f, opts[f.key])).join("")}
    </div>
  </section>`;
}

/** 预设按钮组：一键把一组开关摆到合理位置 */
function presetsHtml(): string {
  return `
  <div class="preset-row" data-presets="encrypt">
    ${ENCRYPT_PRESETS.map(
      (p) => `<button class="btn btn-quiet btn-sm preset" type="button" data-preset="${esc(
        p.id,
      )}" title="${esc(p.hint)}">${esc(p.label)}</button>`,
    ).join("")}
    <span class="spacer"></span>
    <button class="btn btn-quiet btn-sm" type="button" data-act="reset-encrypt-options">恢复默认</button>
  </div>
  <p class="preset-hint" data-preset-hint></p>`;
}

function chipsHtml(): string {
  return placeholders
    .map(
      ([key, desc]) =>
        `<button class="chip" type="button" data-insert="${esc(key)}" title="${esc(desc)}">${esc(key)}</button>`,
    )
    .join("");
}

/** 高级区：模板编辑器。默认收起，绝大多数用户不需要打开它。 */
function advancedHtml(kind: "encrypt" | "package"): string {
  const isEncrypt = kind === "encrypt";
  return `
  <details class="adv" data-adv="${kind}"${advancedOpen[kind] ? " open" : ""}>
    <summary class="adv-head">
      <span class="adv-title">高级：直接编辑${isEncrypt ? " ConfuserEx 配置" : " Inno Setup 脚本"}</span>
      <span class="adv-note">不常用</span>
    </summary>
    <div class="adv-body">
      <div class="toolbar">
        <span class="toolbar-label">可用占位符</span>
        ${chipsHtml()}
        <span class="spacer"></span>
        <button class="btn btn-quiet btn-sm" type="button" data-act="reset-${kind}">恢复默认模板</button>
      </div>
      <textarea class="code ${isEncrypt ? "code-md" : "code-lg"}" data-code="${kind}" spellcheck="false"></textarea>
      <p class="note">一旦手工修改，开关就不再覆盖这份模板；想交回开关管理，点上方的「用当前选项覆盖模板」。</p>
    </div>
  </details>`;
}

function setupPaneHtml(p: Project): string {
  return `
  <section class="pane" id="pane-setup" data-pane="setup" role="tabpanel" aria-label="主程序">
    <header class="pane-head">
      <div class="pane-head-text">
        <h2>主程序</h2>
        <p>合并、加密、打包都以这个程序为目标。选好主程序后，它所在目录会成为后续步骤的扫描根目录。</p>
      </div>
      <div class="pane-head-actions">
        <button class="btn btn-quiet btn-sm" type="button" data-act="open-root">打开程序目录</button>
        <button class="btn btn-quiet btn-sm" type="button" data-act="open-output">打开输出目录</button>
      </div>
    </header>
    <div class="pane-body">
      <div class="card-body is-flush">
        ${fieldHtml({ key: "name", label: "工程名称", value: p.name, placeholder: "例如 我的工具" })}
        ${fieldHtml({
          key: "version",
          label: "版本号（用于安装包）",
          value: p.version,
          placeholder: "1.0.0.0",
          action: { id: "detect-version", label: "自动探测" },
        })}
        ${fieldHtml({
          key: "exeFile",
          label: "主程序文件",
          value: p.exeFile,
          placeholder: "编译输出的 .exe",
          action: { id: "pick-exe", label: "浏览" },
        })}
        ${fieldHtml({
          key: "outputDir",
          label: "安装包输出目录",
          value: p.outputDir,
          placeholder: "安装包生成位置",
          action: { id: "pick-output", label: "浏览" },
        })}
        ${fieldHtml({
          key: "password",
          label: "安装包密码（留空则不加密码）",
          value: p.password,
          secret: true,
        })}
        <p class="note">
          口令类字段（安装包密码、密钥口令、符号还原口令）以<b>明文</b>保存在工程配置文件里
          （<code>%APPDATA%\\com.hmilyld.sealpack\\projects\\</code>），这是为了让工具链能够无人值守地重跑。
          请不要把该目录纳入版本库或共享出去。
        </p>
        <div class="field">
          <span class="field-label">主程序所在目录</span>
          <input class="input" value="${esc(p.rootPath)}" readonly />
        </div>
      </div>
    </div>
  </section>`;
}

function mergePaneHtml(): string {
  return `
  <section class="pane" id="pane-merge" data-pane="merge" role="tabpanel" aria-label="合并">
    <header class="pane-head">
      <div class="pane-head-text">
        <h2>合并程序集</h2>
        <p>左侧是文件列表，可搜索、按类型筛选，主程序文件不在其中；右侧是已选文件清单，可筛选并逐项移除。合并后这些文件不再重复打包，可跳过本步。</p>
      </div>
      <div class="pane-head-actions">
        <button class="btn btn-quiet btn-sm" type="button" data-act="rescan">重新扫描</button>
      </div>
    </header>
    <div class="pane-body merge-split">
      <div class="merge-list" data-merge-body>
        <div class="picker-empty">正在扫描目录…</div>
      </div>
      <aside class="merge-preview" data-merge-preview>
        <div class="merge-preview-head">
          <span class="merge-preview-title">已选文件</span>
          <span class="merge-preview-count" data-merge-sel-count>0 项</span>
        </div>
        <div class="merge-preview-search">
          <input class="merge-preview-input" type="search" placeholder="筛选已选文件…" data-merge-sel-filter />
        </div>
        <div class="merge-sel-list" data-merge-selected></div>
        <div class="preview-actions"><button class="btn btn-quiet btn-xs" type="button" data-merge-clear>全部移除</button></div>
      </aside>
    </div>
  </section>`;
}

function encryptPaneHtml(): string {
  return `
  <section class="pane" id="pane-encrypt" data-pane="encrypt" role="tabpanel" aria-label="加密">
    <header class="pane-head">
      <div class="pane-head-text">
        <h2>加密保护</h2>
        <p>先选一档整体强度，再按需微调单项。开关与参数会直接生成 ConfuserEx 配置，不需要手写模板；一项保护都不启用时本步会被自动跳过。</p>
      </div>
    </header>
    <div class="pane-body">
      <section class="sub">
        <div class="sub-head">
          <h3 class="sub-title">一键预设</h3>
          <span class="sub-count" data-encrypt-count></span>
        </div>
        ${presetsHtml()}
      </section>
      <div class="opt-groups" data-opt-groups="encrypt"></div>
      <div data-generated-hint="encrypt"></div>
      ${advancedHtml("encrypt")}
    </div>
  </section>`;
}

function packagePaneHtml(): string {
  return `
  <section class="pane" id="pane-package" data-pane="package" role="tabpanel" aria-label="打包">
    <header class="pane-head">
      <div class="pane-head-text">
        <h2>安装包打包</h2>
        <p>确认哪些文件不参与打包，再选择压缩格式、打包模式与加密签名方式。前两步产生的中间文件已经自动排除，不需要你操心。</p>
      </div>
    </header>
    <div class="pane-body">
      <section class="sub">
        <div class="sub-head">
          <h3 class="sub-title">不参与打包的文件</h3>
          <span class="sub-count" data-ignore-count></span>
        </div>
        <p class="sub-note">
          自动项由前两步推导，不能在这里删除；自定义项支持相对路径与 Inno 通配符（如
          <code>*.pdb</code>、<code>docs\\*</code>）。
        </p>
        <div class="exclude" data-exclude="auto"></div>
        <div class="exclude" data-exclude="custom">
          <span class="exclude-label">自定义</span>
          <div class="toolbar">
            <button class="btn btn-quiet btn-sm" type="button" data-act="add-file">添加文件…</button>
            <button class="btn btn-quiet btn-sm" type="button" data-act="add-dir">添加文件夹…</button>
            <button class="btn btn-quiet btn-sm" type="button" data-act="add-glob">添加通配符…</button>
          </div>
          <span class="exclude-list" data-exclude-custom-list></span>
        </div>
        <details class="ignore-preview" data-ignore-details>
          <summary class="ignore-preview-head">
            <span class="ignore-preview-label">写入 Excludes</span>
            <span class="ignore-preview-hint">展开查看</span>
          </summary>
          <div class="ignore-preview-body">
            <code data-ignore-preview>—</code>
          </div>
        </details>
      </section>

      <section class="sub">
        <div class="sub-head">
          <h3 class="sub-title">安装包选项</h3>
          <span class="sub-count" data-package-count></span>
        </div>
        <p class="sub-note">
          每项都标注了默认值与适用场景；带参数的选项只在对应功能开启后才出现。
        </p>
        <div class="opt-groups" data-opt-groups="package"></div>
        <div class="toolbar">
          <span class="spacer"></span>
          <button class="btn btn-quiet btn-sm" type="button" data-act="reset-package-options">恢复默认</button>
        </div>
      </section>

      <div data-generated-hint="package"></div>
      ${advancedHtml("package")}
    </div>
  </section>`;
}

function runPaneHtml(): string {
  return `
  <section class="pane" id="pane-run" data-pane="run" role="tabpanel" aria-label="执行">
    <header class="pane-head">
      <div class="pane-head-text">
        <h2>执行</h2>
        <p>按顺序完成上述步骤。没有勾选内容的步骤会自动跳过，不会中断流程；某一步失败会停下并保留日志。</p>
      </div>
      <div class="pane-head-actions">
        <button class="btn btn-primary" type="button" data-act="run-all">全部执行</button>
      </div>
    </header>
    <div class="pane-body">
      <ol class="plan" data-plan></ol>
      <p class="note" data-run-progress hidden></p>
      <p class="note">每一步也可以单独执行，方便只重跑打包或只重跑加密。</p>
    </div>
  </section>`;
}

function wizardHtml(p: Project): string {
  return `
  <div class="wizard">
    <nav class="steps" id="steps" role="tablist" aria-label="操作步骤"></nav>
    <div class="panes">
      ${setupPaneHtml(p)}
      ${mergePaneHtml()}
      ${encryptPaneHtml()}
      ${packagePaneHtml()}
      ${runPaneHtml()}
    </div>
    <footer class="wizard-foot">
      <button class="btn btn-quiet" type="button" data-nav="prev">上一步</button>
      <span class="wizard-pos" id="wizard-pos"></span>
      <span class="spacer"></span>
      <span class="wizard-note" id="wizard-note"></span>
      <button class="btn btn-primary" type="button" data-nav="next">下一步</button>
    </footer>
  </div>`;
}

function renderWorkspace() {
  picker = null;
  activeTextarea = null;

  if (!current) {
    workspace.innerHTML = emptyStateHtml();
    document.getElementById("empty-new")!.onclick = () => void createProject();
    return;
  }

  workspace.innerHTML = wizardHtml(current);

  renderStepper();
  wireWizardNav();
  wireSetupPane();
  renderOptionGroups("encrypt");
  renderOptionGroups("package");
  wireOptionGroups();
  renderCodeEditors();
  renderGeneratedHints();
  renderIgnores();
  renderPlan();
  wireMergePane();
  wirePackagePane();
  wireRunPane();

  const mergeHost = workspace.querySelector<HTMLElement>("[data-merge-body]");
  if (mergeHost) attachPickerMenu(mergeHost);

  goStep(step);

  void ensureTree();
  void refreshIgnores();
}

// ---------------------------------------------------------------- 步骤条

function renderStepper() {
  const nav = document.getElementById("steps");
  if (!nav) return;

  nav.innerHTML = STEP_ORDER.map((id) => {
    const meta = STEP_META[id];
    return `
    <button class="step" type="button" role="tab" id="step-tab-${id}"
      aria-controls="pane-${id}" data-step="${id}" aria-selected="false" tabindex="-1">
      <span class="step-num">${meta.index}</span>
      <span class="step-text">
        <span class="step-title">${esc(meta.title)}</span>
        <span class="step-sub" data-sub>—</span>
      </span>
    </button>`;
  }).join("");

  nav.querySelectorAll<HTMLElement>("[data-step]").forEach((btn) => {
    btn.onclick = () => goStep(btn.dataset.step as StepId);
  });

  // 步骤条声明了 role=tablist，就得支持方向键 —— 只有鼠标能切步骤的 tab 是不完整的
  nav.onkeydown = (event) => {
    const idx = STEP_ORDER.indexOf(step);
    let next = idx;
    switch (event.key) {
      case "ArrowRight":
        next = Math.min(STEP_ORDER.length - 1, idx + 1);
        break;
      case "ArrowLeft":
        next = Math.max(0, idx - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = STEP_ORDER.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = STEP_ORDER[next]!;
    goStep(target);
    nav.querySelector<HTMLElement>(`[data-step="${target}"]`)?.focus();
  };
}

function goStep(id: StepId) {
  step = id;
  const idx = STEP_ORDER.indexOf(id);

  workspace.querySelectorAll<HTMLElement>("[data-pane]").forEach((pane) => {
    pane.classList.toggle("is-active", pane.dataset.pane === id);
  });

  workspace.querySelectorAll<HTMLElement>("[data-step]").forEach((el, i) => {
    el.classList.toggle("is-active", i === idx);
    el.classList.toggle("is-done", i < idx);
    el.setAttribute("aria-selected", String(i === idx));
    // roving tabindex：整个步骤条只占一个 Tab 停靠点，组内用方向键走
    el.tabIndex = i === idx ? 0 : -1;
  });

  const pos = document.getElementById("wizard-pos");
  if (pos) pos.textContent = `第 ${idx + 1} / ${STEP_ORDER.length} 步`;

  const note = document.getElementById("wizard-note");
  if (note) {
    // 用分隔符而不是再套一层括号：hint 自己常常已经带括号了
    note.textContent = `${STEP_META[id].hint} · Alt+←/→ 切换步骤`;
  }

  const prev = workspace.querySelector<HTMLButtonElement>('[data-nav="prev"]');
  const next = workspace.querySelector<HTMLButtonElement>('[data-nav="next"]');
  const last = idx === STEP_ORDER.length - 1;
  if (prev) prev.disabled = idx === 0;
  if (next) {
    next.textContent = last ? "全部执行" : "下一步";
    next.disabled = last && busy;
  }

  // 切到合并步骤时把焦点交给树（键盘用户可直接用方向键）。
  // 树是异步挂载的，此刻可能还没有，mountPicker 完成时会补一次。
  if (id === "merge") picker?.focus();

  syncStepSubs();
}

function wireWizardNav() {
  const prev = workspace.querySelector<HTMLElement>('[data-nav="prev"]');
  const next = workspace.querySelector<HTMLElement>('[data-nav="next"]');
  if (prev) {
    prev.onclick = () => {
      const idx = STEP_ORDER.indexOf(step);
      if (idx > 0) goStep(STEP_ORDER[idx - 1]!);
    };
  }
  if (next) {
    next.onclick = () => {
      const idx = STEP_ORDER.indexOf(step);
      if (idx < STEP_ORDER.length - 1) goStep(STEP_ORDER[idx + 1]!);
      else void runAll();
    };
  }
}

/** 步骤条上的一句话状态 —— 让人不用点进去也知道那一步配好了没有。 */
function stepSub(id: StepId): string {
  if (!current) return "—";
  switch (id) {
    case "setup":
      return current.exeFile ? baseName(current.exeFile) : "未设置主程序";
    case "merge":
      if (scanning) return "扫描中…";
      return current.mergeDlls.length > 0 ? `${current.mergeDlls.length} 个程序集` : "未勾选（跳过）";
    case "encrypt": {
      if (!current.encryptOptions.generated) return "已自定义模板";
      const on = enabledProtectionLabels().length;
      return on > 0 ? `${on} 项保护` : "未启用（跳过）";
    }
    case "package": {
      const n = ignores ? ignores.auto.length + ignores.custom.length : current.excludePaths.length;
      return `排除 ${n} 项`;
    }
    case "run": {
      const list = Object.keys(statuses) as Stage[];
      const failed = list.filter((s) => statuses[s] === "failed").length;
      if (failed > 0) return `${failed} 个阶段失败`;
      const done = list.filter((s) => statuses[s] === "ok").length;
      return done > 0 ? `已完成 ${done} / 3` : "待执行";
    }
    default:
      return "—";
  }
}

/**
 * 刷新所有「摘要」文案。
 *
 * 两处摘要读的是**同一份数据**（勾选了几个程序集 / 启用了几项保护 / 排除了几项）：
 *   · 步骤条每步下面那一行（`stepSub`）
 *   · 执行页每个阶段那一行（`stageSummary`）
 *
 * 所以必须一起刷新。之前只刷了步骤条 —— 执行页那几行是工程首次渲染时算好的，
 * 之后无论怎么改选项都不动，于是出现「每步都配好了，执行页却显示未勾选」。
 * 这个函数是所有改动路径的统一出口，别再只更新其中一半。
 */
function syncStepSubs() {
  workspace.querySelectorAll<HTMLElement>("[data-step]").forEach((el) => {
    const sub = el.querySelector<HTMLElement>("[data-sub]");
    if (sub) sub.textContent = stepSub(el.dataset.step as StepId);
  });
  updatePlanSums();
}

// ---------------------------------------------------------------- 第 1 步：主程序

/** 统一的事件绑定：带 try/catch，异常一律变成提示 —— 不允许出现「点了没反应」。 */
function bindAct(id: string, handler: () => void | Promise<void>) {
  const el = workspace.querySelector<HTMLElement>(`[data-act="${id}"]`);
  if (!el) return;
  el.onclick = async () => {
    try {
      await handler();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };
}

/** 只绑定字符串型字段 —— Project 上可直接由输入框写入的就是这几个。 */
type TextFieldKey = "name" | "version" | "exeFile" | "outputDir" | "password";

function bindField(key: TextFieldKey) {
  const el = workspace.querySelector<HTMLInputElement>(`[data-field="${key}"]`);
  if (!el) return;
  el.oninput = () => {
    if (!current) return;
    current[key] = el.value;
    scheduleSave();
  };
  attachInputMenu(el);
}

function wireSetupPane() {
  bindField("name");
  bindField("version");
  bindField("exeFile");
  bindField("outputDir");
  bindField("password");

  const p = current!;

  bindAct("pick-exe", async () => {
    const picked = await pickExe();
    if (!picked) return;
    const prevRoot = p.rootPath;
    p.exeFile = picked;
    p.rootPath = picked.replace(/[\\/][^\\/]+$/, "");
    const version = await api.exeVersion(picked).catch(() => "");
    if (version) p.version = version;

    // 换到别的目录后，原先勾选的程序集已经不在扫描范围内了：它们在树里看不见，
    // 也就无法用右栏的 × 取消（那个 × 会打到不存在的节点上）。这里主动丢弃并说明。
    let dropped = 0;
    if (prevRoot && prevRoot.toLowerCase() !== p.rootPath.toLowerCase()) {
      const kept = p.mergeDlls.filter((d) => isUnder(p.rootPath, d));
      dropped = p.mergeDlls.length - kept.length;
      p.mergeDlls = kept;
    }

    // 主程序换了 → 扫描结果、排除项、以及之前各阶段的执行结果全部失效，
    // 整块重建最省心（也最不容易出错）
    treeNode = null;
    treeError = "";
    ignores = null;
    statuses = { merge: "idle", encrypt: "idle", package: "idle" };
    artifacts = {};
    renderWorkspace();
    scheduleSave();
    if (dropped > 0) {
      toast(`主程序目录已变更，${dropped} 个原目录下的合并项已移除`, "info");
    }
  });

  bindAct("pick-output", async () => {
    const picked = await pickDirectory("选择安装包输出目录");
    if (!picked) return;
    p.outputDir = picked;
    const input = workspace.querySelector<HTMLInputElement>('[data-field="outputDir"]');
    if (input) input.value = picked;
    scheduleSave();
    syncStepSubs();
  });

  bindAct("detect-version", async () => {
    const version = await api.exeVersion(p.exeFile).catch(() => "");
    if (!version) {
      toast("未能读取版本号，请手动填写", "error");
      return;
    }
    p.version = version;
    const input = workspace.querySelector<HTMLInputElement>('[data-field="version"]');
    if (input) input.value = version;
    scheduleSave();
    toast(`已读取版本号 ${version}`, "success");
  });

  bindAct("open-root", () => reveal(p.rootPath).catch(() => toast("无法打开目录", "error")));
  bindAct("open-output", () => reveal(p.outputDir).catch(() => toast("无法打开目录", "error")));
}

// ---------------------------------------------------------------- 第 2 步：合并

async function ensureTree(force = false) {
  // 先占位：任何早退、以及后续任何一次扫描请求，都会让在途的旧扫描失效
  const epoch = (scanEpoch += 1);

  const host = () => workspace.querySelector<HTMLElement>("[data-merge-body]");
  // 每条早退路径都代表「本代次不需要扫描」，扫描标志要跟着落地，
  // 否则一个被作废的在途请求会把「扫描中…」永久留在步骤条上。
  const idle = () => {
    scanning = false;
  };

  if (!current || !host()) {
    idle();
    return;
  }

  if (!current.rootPath) {
    picker = null;
    host()!.innerHTML = `<div class="picker-empty">尚未设置主程序，无法扫描目录。</div>`;
    idle();
    syncStepSubs();
    return;
  }

  if (!force && treeNode) {
    mountPicker(treeNode);
    idle();
    syncStepSubs();
    return;
  }

  const root = current.rootPath;
  scanning = true;
  host()!.innerHTML = `<div class="picker-empty">正在扫描目录…</div>`;
  syncStepSubs();

  let node: FileNode | null = null;
  let error = "";
  try {
    node = await api.scanTree(root);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // 期间又发起了新的扫描（切工程 / 换主程序 / 再点一次重新扫描）→ 本次结果作废。
  // 少了这一道，旧工程的目录树会挂到新工程上，勾选出来的路径会写错工程。
  if (epoch !== scanEpoch) return;

  scanning = false;
  treeNode = node;
  treeError = error;

  const again = host();
  if (!again) return;

  if (!treeNode) {
    picker = null;
    again.innerHTML = `<div class="picker-empty">${esc(treeError)}</div>`;
    syncStepSubs();
    return;
  }

  mountPicker(treeNode);
  syncStepSubs();
}

/**
 * 「重新扫描目录」：与 `ensureTree(true)` 的区别是**保留视图状态** ——
 * 搜索词、类型筛选、只看已选、展开的目录与滚动位置都不该因为重扫而清零。
 * `createFilePicker` 的 `reload()` 正是为此准备的，此前一直没人调用它。
 */
async function rescanTree() {
  const proj = current;
  const host = workspace.querySelector<HTMLElement>("[data-merge-body]");
  if (!proj?.rootPath || !host) {
    void ensureTree(true);
    return;
  }

  const epoch = (scanEpoch += 1);
  scanning = true;
  syncStepSubs();

  let node: FileNode | null = null;
  let error = "";
  try {
    node = await api.scanTree(proj.rootPath);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (epoch !== scanEpoch) return;

  scanning = false;
  treeNode = node;
  treeError = error;

  if (!treeNode) {
    toast(`重新扫描失败：${treeError}`, "error");
    syncStepSubs();
    return;
  }

  if (picker) picker.reload(treeNode);
  else mountPicker(treeNode);
  syncStepSubs();
  toast("目录已重新扫描", "success");
}

function mountPicker(node: FileNode) {
  const host = workspace.querySelector<HTMLElement>("[data-merge-body]");
  if (!host || !current) return;
  const proj = current;

  const previewHost = () => workspace.querySelector<HTMLElement>("[data-merge-preview]");
  let selFilter = "";

  // 右侧 = 已选中文件列表：随勾选实时刷新，支持筛选与逐项移除
  const renderSelected = () => {
    const preview = previewHost();
    if (!preview) return;
    const selected = picker ? picker.getSelected() : proj.mergeDlls;
    const countEl = preview.querySelector<HTMLElement>("[data-merge-sel-count]");
    if (countEl) countEl.textContent = `${selected.length} 项`;

    const list = preview.querySelector<HTMLElement>("[data-merge-selected]");
    if (!list) return;
    if (selected.length === 0) {
      list.innerHTML = `<div class="preview-empty">还没有选中要合并的文件</div>`;
      return;
    }
    const terms = selFilter.toLowerCase().split(/\s+/).filter(Boolean);
    const items = selected
      .map((p) => {
        const rel = relativeTo(proj.rootPath, p);
        const hit = terms.length === 0 || terms.every((t) => rel.toLowerCase().includes(t));
        return { p, rel, hit };
      })
      .filter((it) => it.hit)
      .map(
        (it) =>
          `<div class="merge-sel-item" data-sel="${esc(it.p)}">
          <span class="merge-sel-name" title="${esc(it.p)}">${esc(it.rel)}</span>
          <span class="merge-sel-x" data-sel-remove="${esc(it.p)}" title="移出合并">×</span>
        </div>`,
      )
      .join("");
    list.innerHTML = items || `<div class="preview-empty">没有匹配项</div>`;

    preview.querySelectorAll<HTMLElement>("[data-sel-remove]").forEach((x) => {
      x.onclick = () => {
        if (!current) return;
        picker?.togglePath(x.dataset.selRemove!);
      };
    });
    const clear = preview.querySelector<HTMLButtonElement>("[data-merge-clear]");
    if (clear) clear.onclick = () => picker?.setSelected([]);
  };

  // 默认不显示主程序文件：从树节点里剔除 exeFile 本身
  const withoutExe = (n: FileNode): FileNode => {
    const exe = proj.exeFile.toLowerCase();
    const children = n.children
      .filter((c) => !c.isDir || c.children.length > 0)
      .map(withoutExe)
      .filter((c) => c.path.toLowerCase() !== exe);
    return { ...n, children };
  };

  host.innerHTML = "";
  if (node.truncated) {
    const notice = document.createElement("div");
    notice.className = "inline-note";
    const text = document.createElement("span");
    text.className = "inline-note-text";
    text.textContent =
      "目录过大，只扫描了前 8000 项（最多 6 层）。列表里没出现的文件并非不存在，可用「添加文件…」手工排除。";
    notice.appendChild(text);
    host.appendChild(notice);
  }
  picker = createFilePicker({
    nodes: withoutExe(node),
    selected: proj.mergeDlls,
    onChange: (paths) => {
      if (!current) return;
      current.mergeDlls = paths;
      scheduleSave();
      syncStepSubs();
      scheduleIgnoreRefresh();
      renderSelected();
    },
  });
  host.appendChild(picker.el);
  renderSelected();

  // 右侧筛选输入
  const filterInput = previewHost()?.querySelector<HTMLInputElement>("[data-merge-sel-filter]");
  if (filterInput) {
    filterInput.oninput = () => {
      selFilter = filterInput.value.trim();
      renderSelected();
    };
  }

  // 切到合并步骤时把焦点交给树（`goStep` 里那次因为树还没挂上而落空）。
  // 只在焦点不在合并页里时才抢，免得打断正在右栏筛选框里打字的人。
  if (step === "merge") {
    const active = document.activeElement as HTMLElement | null;
    const pane = workspace.querySelector<HTMLElement>('[data-pane="merge"]');
    if (pane && (!active || !pane.contains(active))) picker.focus();
  }
}

// ---------------------------------------------------------------- 第 3 / 4 步：选项

/**
 * 合并页抬头上的「重新扫描」。
 *
 * 这个按钮此前只存在于 HTML 里、没有任何地方绑定 —— 点了完全没反应，
 * 正是「浏览按钮没反应」那一类问题。这里把它接到 `rescanTree`，
 * 与右键菜单里的同名项共用一条路径。
 */
function wireMergePane() {
  bindAct("rescan", () => rescanTree());
}

/** 选项描述表：加密与打包各一份，界面按它渲染，探针也按它断言 */
function groupsFor(kind: "encrypt" | "package"): OptGroup[] {
  return kind === "encrypt" ? ENCRYPT_GROUPS : PACKAGE_GROUPS;
}

function findOptField(groups: OptGroup[], key: string): OptField | undefined {
  for (const g of groups) {
    const hit = g.fields.find((f) => f.key === key);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 当前工程上的选项对象本身（不是副本）。
 * 直接改它就等于改工程，所以渲染层不需要再造一套中间状态。
 */
function optionBag(kind: "encrypt" | "package"): Record<string, unknown> | null {
  if (!current) return null;
  return (kind === "encrypt" ? current.encryptOptions : current.packageOptions) as unknown as Record<
    string,
    unknown
  >;
}

/** 把控件里的值读回来，并按 schema 的约束收敛（数字夹在 min/max 之间） */
function readControl(
  el: HTMLInputElement | HTMLSelectElement,
  f: OptField,
): boolean | string | number {
  if (f.kind === "bool") return (el as HTMLInputElement).checked;
  if (f.kind === "number") {
    const n = Number(el.value);
    if (!Number.isFinite(n)) return f.def;
    let v = Math.trunc(n);
    if (f.min !== undefined) v = Math.max(f.min, v);
    if (f.max !== undefined) v = Math.min(f.max, v);
    return v;
  }
  return el.value;
}

function renderOptionGroups(kind: "encrypt" | "package") {
  const host = workspace.querySelector<HTMLElement>(`[data-opt-groups="${kind}"]`);
  const bag = optionBag(kind);
  if (!host || !bag) return;

  const groups = groupsFor(kind);
  host.innerHTML = groups.map((g) => groupHtml(g, bag)).join("");

  host.querySelectorAll<HTMLElement>("[data-opt]").forEach((el) => {
    const field = findOptField(groups, el.dataset.opt ?? "");
    if (!field) return;
    const input = el as HTMLInputElement | HTMLSelectElement;
    // 记下上一次的值：number / text 控件会同时触发 input 与 change，
    // 不做去重的话一次编辑会重建两遍模板（多打一次 IPC）。
    let last = String(bag[field.key]);

    const handler = () => {
      const next = readControl(input, field);
      if (String(next) === last) return;
      last = String(next);
      bag[field.key] = next;
      // 参数可能依赖别的开关，先刷新可见性再重建模板
      syncOptionVisibility(kind);
      void syncTemplate(kind);
    };

    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
  });

  syncOptionVisibility(kind);
  syncOptionSummaries();
}

/**
 * 条件显示：参数项只在对应的功能开启后才出现。
 *
 * 渲染时不做裁剪、只切换可见性 —— 这样切开关不会重建 DOM，
 * 输入框的焦点、光标位置、滚动位置都不会丢。
 */
function syncOptionVisibility(kind: "encrypt" | "package") {
  const host = workspace.querySelector<HTMLElement>(`[data-opt-groups="${kind}"]`);
  const bag = optionBag(kind);
  if (!host || !bag) return;

  host.querySelectorAll<HTMLElement>("[data-when-key]").forEach((row) => {
    const allowed = (row.dataset.whenIn ?? "").split(WHEN_SEP);
    const hit = allowed.includes(String(bag[row.dataset.whenKey ?? ""]));
    const show = row.dataset.whenNegate === "1" ? !hit : hit;
    row.hidden = !show;
  });

  host.querySelectorAll<HTMLElement>("[data-group]").forEach((section) => {
    const out = section.querySelector<HTMLElement>("[data-group-count]");
    if (!out) return;
    const keys = (section.dataset.groupBools ?? "").split(",").filter(Boolean);
    const on = keys.filter((k) => bag[k] === true).length;
    out.textContent = `已启用 ${on} / ${keys.length} 项`;
  });
}

/**
 * 当前启用的 protection，顺序与 Rust 侧 `enabled_protections()` 保持一致 ——
 * 这样界面上的摘要和生成出来的模板是同一个顺序，对照起来不会串行。
 */
function enabledProtectionLabels(): string[] {
  if (!current) return [];
  const e = current.encryptOptions;
  const out: string[] = [];
  if (e.antiIldasm) out.push("防反汇编");
  if (e.antiDebug) out.push("反调试");
  if (e.antiDump) out.push("防转储");
  if (e.antiTamper) out.push("反篡改");
  if (e.constants) out.push("常量加密");
  if (e.controlFlow) out.push("控制流混淆");
  if (e.invalidMetadata) out.push("无效元数据");
  if (e.rename) out.push("重命名符号");
  if (e.harden) out.push("强化");
  if (e.refProxy) out.push("引用代理");
  if (e.resources) out.push("资源加密");
  return out;
}

/** 步骤条与面板抬头上的计数/摘要 */
function syncOptionSummaries() {
  if (!current) return;

  const protections = enabledProtectionLabels().length;
  const encryptCount = workspace.querySelector<HTMLElement>("[data-encrypt-count]");
  if (encryptCount) {
    encryptCount.textContent =
      protections > 0 ? `已启用 ${protections} 项保护` : "未启用保护，执行时会跳过";
  }

  const p = current.packageOptions;
  const modeLabel =
    p.packagingMode === "portable"
      ? "免安装绿色版"
      : p.packagingMode === "multi_volume"
        ? "分卷"
        : "单文件安装程序";
  const extra = [
    p.encryption === "no" ? null : "加密",
    p.signTool.trim() ? "签名" : null,
    p.checksum === "none" ? null : `${p.checksum.toUpperCase()} 校验`,
  ].filter(Boolean);

  const packageCount = workspace.querySelector<HTMLElement>("[data-package-count]");
  if (packageCount) {
    packageCount.textContent = [p.compression, modeLabel, ...extra].join(" · ");
  }
}

let activePreset: string | null = null;

/**
 * 按当前选项反推它落在哪一档预设上（每一项都一致才算命中）。
 *
 * `activePreset` 是模块级变量，切工程后必须重算：否则上一个工程选的
 * 「标准」会继续高亮，而新工程的开关其实是另一套 —— 看着像预设坏了。
 */
function inferPreset(): string | null {
  if (!current) return null;
  const bag = current.encryptOptions as unknown as Record<string, unknown>;
  const hit = ENCRYPT_PRESETS.find((p) =>
    Object.entries(p.values).every(([k, v]) => String(bag[k]) === String(v)),
  );
  return hit ? hit.id : null;
}

function renderPresetHint() {
  const el = workspace.querySelector<HTMLElement>("[data-preset-hint]");
  if (!el) return;
  const preset = ENCRYPT_PRESETS.find((p) => p.id === activePreset);
  el.textContent = preset ? `${preset.label}：${preset.hint}` : "选一档预设，下面的开关会自动摆到对应位置，之后仍可逐项微调。";
  workspace.querySelectorAll<HTMLElement>("[data-preset]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.preset === activePreset);
  });
}

/**
 * 一键预设：把一组开关一次性设成给定值。
 *
 * 模板已被手工接管（`generated === false`）时先问一句 —— 否则预设只会改开关、
 * 模板一字不动，用户看到的现象是「点了预设什么都没发生」。
 */
async function applyEncryptPreset(id: string) {
  const preset = ENCRYPT_PRESETS.find((p) => p.id === id);
  if (!preset || !current) return;

  if (!current.encryptOptions.generated) {
    const overwrite = await confirmDialog(
      "模板已被手工修改",
      "套用预设只会改变下面的开关，不会重建模板。是否同时用这些选项覆盖模板？",
    );
    if (!current) return;
    if (overwrite) {
      Object.assign(current.encryptOptions, preset.values, { generated: true });
      activePreset = id;
      renderOptionGroups("encrypt");
      renderPresetHint();
      await regenerateTemplate("encrypt", { successText: `已套用「${preset.label}」并重建模板` });
      return;
    }
  }

  Object.assign(current.encryptOptions, preset.values);
  activePreset = id;
  renderOptionGroups("encrypt");
  renderPresetHint();
  void syncTemplate("encrypt");
}

/**
 * 恢复默认：按 schema 里声明的默认值把整组选项重置，并把模板交回开关托管。
 *
 * `generated` 不在 schema 里（它不是「选项」而是「谁来管模板」），所以要显式
 * 置回 true —— 否则用户手改过模板时，开关全部回到默认而模板一字未动。
 */
async function resetOptions(kind: "encrypt" | "package") {
  const bag = optionBag(kind);
  if (!bag) return;
  for (const g of groupsFor(kind)) {
    for (const f of g.fields) bag[f.key] = f.def;
  }
  if (kind === "encrypt") {
    activePreset = inferPreset();
    renderPresetHint();
  }
  renderOptionGroups(kind);
  await regenerateTemplate(kind);
  toast("已恢复为默认选项", "success");
}

function wireOptionGroups() {
  workspace.querySelectorAll<HTMLElement>("[data-preset]").forEach((btn) => {
    btn.onclick = () => void applyEncryptPreset(btn.dataset.preset ?? "");
  });
  // 每次重建工作区都按当前选项重算一次预设高亮（切工程后不会残留上一档）
  activePreset = inferPreset();
  renderPresetHint();

  bindAct("reset-encrypt-options", () => resetOptions("encrypt"));
  bindAct("reset-package-options", () => resetOptions("package"));

  // 强名称密钥：snk / pfx 两种容器，都让用户点着选，不要求手输路径
  bindAct("pick-snkey", async () => {
    const picked = await pickFile("选择强名称密钥", [
      { name: "强名称密钥", extensions: ["snk", "pfx"] },
      { name: "全部文件", extensions: ["*"] },
    ]);
    if (!picked || !current) return;
    current.encryptOptions.snKeyPath = picked;
    renderOptionGroups("encrypt");
    void syncTemplate("encrypt");
  });
}

/**
 * 选项变了 → 如果模板仍由选项托管，就用 Rust 侧的生成器重建模板。
 *
 * 模板只有一份定义（在 Rust），前端只收集开关；这样「点开关」与
 * 「手写模板」不会各自漂移出一套语义。
 */
async function syncTemplate(kind: "encrypt" | "package") {
  if (!current) return;

  const generated =
    kind === "encrypt" ? current.encryptOptions.generated : current.packageOptions.generated;

  if (generated) {
    try {
      if (kind === "encrypt") {
        current.encryptConfig = await api.renderEncryptConfig(current.encryptOptions);
      } else {
        current.packageScript = await api.renderPackageScript(current.packageOptions);
      }
    } catch (err) {
      toast(String(err), "error");
      return;
    }
    const ta = workspace.querySelector<HTMLTextAreaElement>(`[data-code="${kind}"]`);
    if (ta) ta.value = kind === "encrypt" ? current.encryptConfig : current.packageScript;
  }

  scheduleSave();
  renderGeneratedHints();
  syncStepSubs();
}

/**
 * 用当前选项重建模板 —— 三个入口共用（「恢复默认模板」「用当前选项覆盖模板」
 * 「恢复默认选项」）。它们做的事完全一样：把 `generated` 置回 true、
 * 让 Rust 生成器重写模板、刷新编辑器与提示条；差别只在要不要先确认与提示文案。
 */
async function regenerateTemplate(
  kind: "encrypt" | "package",
  opts: { confirm?: boolean; successText?: string } = {},
): Promise<void> {
  if (!current) return;

  if (opts.confirm) {
    const ok = await confirmDialog("恢复默认模板", "当前模板内容将被覆盖，确定继续？");
    if (!ok || !current) return;
  }

  try {
    if (kind === "encrypt") {
      current.encryptOptions.generated = true;
      current.encryptConfig = await api.renderEncryptConfig(current.encryptOptions);
    } else {
      current.packageOptions.generated = true;
      current.packageScript = await api.renderPackageScript(current.packageOptions);
    }
  } catch (err) {
    toast(String(err), "error");
    return;
  }

  const ta = workspace.querySelector<HTMLTextAreaElement>(`[data-code="${kind}"]`);
  if (ta) ta.value = kind === "encrypt" ? current.encryptConfig : current.packageScript;

  renderGeneratedHints();
  syncStepSubs();
  scheduleSave();
  if (opts.successText) toast(opts.successText, "success");
}

function renderCodeEditors() {
  if (!current) return;

  for (const kind of ["encrypt", "package"] as const) {
    const ta = workspace.querySelector<HTMLTextAreaElement>(`[data-code="${kind}"]`);
    if (!ta) continue;

    ta.value = kind === "encrypt" ? current.encryptConfig : current.packageScript;
    attachInputMenu(ta);

    ta.onfocus = () => {
      activeTextarea = ta;
    };
    ta.oninput = () => {
      if (!current) return;
      // 手工改动 = 接管模板：此后开关不再覆盖它
      if (kind === "encrypt") {
        current.encryptConfig = ta.value;
        current.encryptOptions.generated = false;
      } else {
        current.packageScript = ta.value;
        current.packageOptions.generated = false;
      }
      renderGeneratedHints();
      syncStepSubs();
      scheduleSave();
    };

    const details = workspace.querySelector<HTMLDetailsElement>(`[data-adv="${kind}"]`);
    if (details) {
      details.open = advancedOpen[kind];
      details.ontoggle = () => {
        advancedOpen[kind] = details.open;
      };
      details.querySelectorAll<HTMLElement>("[data-insert]").forEach((chip) => {
        chip.onclick = () => {
          const token = chip.dataset.insert!;
          const target = activeTextarea ?? ta;
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          target.value = target.value.slice(0, start) + token + target.value.slice(end);
          target.selectionStart = target.selectionEnd = start + token.length;
          target.focus();
          target.dispatchEvent(new Event("input", { bubbles: true }));
        };
      });
    }

    bindAct(`reset-${kind}`, () =>
      regenerateTemplate(kind, { confirm: true, successText: "已恢复默认模板" }),
    );
  }
}

/** 「模板被手工改过」时的提示条 + 一键交回开关托管。 */
function renderGeneratedHints() {
  if (!current) return;

  for (const kind of ["encrypt", "package"] as const) {
    const host = workspace.querySelector<HTMLElement>(`[data-generated-hint="${kind}"]`);
    if (!host) continue;

    const generated =
      kind === "encrypt" ? current.encryptOptions.generated : current.packageOptions.generated;

    if (generated) {
      host.innerHTML = "";
      continue;
    }

    host.innerHTML = `
      <div class="inline-note">
        <span class="inline-note-text">模板已被手工修改，${
          kind === "encrypt" ? "上面的开关" : "上面的选项"
        }不再自动同步。</span>
        <button class="btn btn-quiet btn-xs" type="button" data-act="resync-${kind}">用当前选项覆盖模板</button>
      </div>`;

    bindAct(`resync-${kind}`, () =>
      regenerateTemplate(kind, { successText: "模板已按当前选项重建" }),
    );
  }
}

// ---------------------------------------------------------------- 第 4 步：排除项

function scheduleIgnoreRefresh() {
  window.clearTimeout(ignoreTimer);
  ignoreTimer = window.setTimeout(() => void refreshIgnores(), 300);
}

async function refreshIgnores() {
  const proj = current;
  if (!proj) {
    ignores = null;
    renderIgnores();
    return;
  }

  const epoch = (ignoreEpoch += 1);
  try {
    const next = await api.projectIgnores(proj);
    // 期间切了工程或又刷新了一次 → 本次结果作废（否则预览里会短暂出现别的工程的排除项）
    if (epoch !== ignoreEpoch || current?.id !== proj.id) return;
    ignores = next;
  } catch {
    if (epoch !== ignoreEpoch) return;
    ignores = null;
  }
  renderIgnores();
  syncStepSubs();
}

/** 排除项的类型标签：文件夹通配（docs\*）、通配符（*.log）、具体文件 */
function exKind(item: string): string {
  if (item.endsWith("\\*") || item.endsWith("/*")) return "文件夹";
  if (item.includes("*") || item.includes("?")) return "通配符";
  return "文件";
}

function renderIgnores() {
  if (!current) return;

  const autoHost = workspace.querySelector<HTMLElement>('[data-exclude="auto"]');
  const customList = workspace.querySelector<HTMLElement>("[data-exclude-custom-list]");
  const countHost = workspace.querySelector<HTMLElement>("[data-ignore-count]");
  const preview = workspace.querySelector<HTMLElement>("[data-ignore-preview]");
  if (!autoHost || !customList) return;

  const auto = ignores?.auto ?? [];
  const custom = ignores?.custom ?? current.excludePaths;

  autoHost.innerHTML = `
    <span class="exclude-label">自动</span>
    <span class="exclude-list">${
      auto.length > 0
        ? auto
            .map(
              (item) =>
                `<span class="exclude-chip is-auto" title="由前两步推导，不可删除"><span class="ex-kind">自动</span><span class="ex-name">${esc(item)}</span></span>`,
            )
            .join("")
        : `<span class="exclude-empty">暂无（还没有勾选合并项）</span>`
    }</span>`;

  // 「自定义」标签与添加按钮是静态 HTML，这里只刷新已选清单本身
  customList.innerHTML =
    custom.length > 0
      ? custom
          .map(
            (item) =>
              `<button class="exclude-chip is-custom" type="button" data-remove="${esc(
                item,
              )}" title="点击移除"><span class="ex-kind">${esc(exKind(item))}</span><span class="ex-name">${esc(
                item,
              )}</span><span class="exclude-x">×</span></button>`,
          )
          .join("")
      : `<span class="exclude-empty">还没有自定义排除项</span>`;

  customList.querySelectorAll<HTMLElement>("[data-remove]").forEach((chip) => {
    chip.onclick = () => removeExclude(chip.dataset.remove!);
  });

  if (countHost) countHost.textContent = `共 ${auto.length + custom.length} 项`;
  if (preview) {
    preview.textContent = ignores?.combined || "—";
    // 默认收起、摘要行只给数量：Excludes 是给需要核对的人看的，
    // 内容一多（文件一多就是长串）直接铺开会把整页淹掉。
    const hint = preview
      .closest<HTMLDetailsElement>("[data-ignore-details]")
      ?.querySelector<HTMLElement>(".ignore-preview-hint");
    if (hint) hint.textContent = `共 ${auto.length + custom.length} 项 · 展开查看`;
  }
}

function removeExclude(item: string) {
  if (!current) return;
  current.excludePaths = current.excludePaths.filter((p) => p !== item);
  scheduleSave();
  void refreshIgnores();
}

function addExcludes(items: string[]) {
  if (!current || items.length === 0) return;

  const seen = new Set(current.excludePaths.map((p) => p.toLowerCase()));
  const added: string[] = [];
  const rejected: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    // 逗号是 Inno `Excludes` 的分隔符，混进一条里会被拆成两条（多半都不是本意）
    if (item.includes(",")) {
      rejected.push(item);
      continue;
    }
    seen.add(item.toLowerCase());
    added.push(item);
  }

  if (rejected.length > 0) {
    toast(`已忽略含逗号的 ${rejected.length} 项：Excludes 用逗号分隔，无法表达`, "error");
  }
  if (added.length === 0) {
    if (rejected.length === 0) toast("这些条目已经在排除列表里了", "info");
    return;
  }

  current.excludePaths = [...current.excludePaths, ...added];
  scheduleSave();
  void refreshIgnores();
  toast(`已添加 ${added.length} 个排除项`, "success");
}

function wirePackagePane() {
  bindAct("add-file", async () => {
    const picked = await pickFiles("选择不参与打包的文件");
    if (!current) return;
    addExcludes(picked.map((p) => relativeTo(current!.rootPath, p)));
  });

  bindAct("add-dir", async () => {
    const picked = await pickDirectory("选择不参与打包的文件夹");
    if (!picked || !current) return;
    addExcludes([`${relativeTo(current.rootPath, picked)}\\*`]);
  });

  bindAct("add-glob", async () => {
    const value = await promptDialog({
      title: "添加通配符排除项",
      description: "相对于主程序所在目录，支持 Inno Setup 的通配符语法。",
      label: "通配符",
      placeholder: "例如 *.pdb 或 docs\\*",
      validate: (v) => {
        if (v.includes(",")) {
          // Inno 的 Excludes 本身以逗号分隔多项：一条里再带逗号会被拆成两条，
          // 结果既不是用户想要的，也不会报错。
          return "不能包含逗号；需要排除多项请分别添加";
        }
        if (!v.includes("*") && !v.includes("?")) {
          return "请包含 * 或 ? 通配符；如果要排除确定的文件，请用「添加文件…」";
        }
        return null;
      },
    });
    if (value) addExcludes([value]);
  });
}

// ---------------------------------------------------------------- 第 5 步：执行

function stageSummary(stage: Stage): string {
  if (!current) return "";
  switch (stage) {
    case "merge":
      return current.mergeDlls.length > 0
        ? `合并 ${current.mergeDlls.length} 个程序集 → ${baseName(current.exeFile)}`
        : "未勾选程序集，执行时会跳过";
    case "encrypt": {
      if (!current.encryptOptions.generated) return "使用自定义模板";
      const on = enabledProtectionLabels();
      return on.length > 0 ? on.join(" · ") : "未启用保护，执行时会跳过";
    }
    case "package": {
      const n = ignores ? ignores.auto.length + ignores.custom.length : current.excludePaths.length;
      return `输出到 ${current.outputDir || "（未设置输出目录）"}，排除 ${n} 项`;
    }
    default:
      return "";
  }
}

/**
 * 绑定「全部执行」。
 *
 * 这个按钮和底部的「下一步」在最后一步指向同一个动作，但**两个入口都要绑** ——
 * 只绑了底栏那一个的话，面板抬头上的主按钮就是个死按钮，
 * 用户点它什么也不会发生（正是之前「浏览按钮没反应」那类问题）。
 */
function wireRunPane() {
  bindAct("run-all", () => runAll());
}

function renderPlan() {
  const host = workspace.querySelector<HTMLElement>("[data-plan]");
  if (!host || !current) return;

  const stages: Stage[] = ["merge", "encrypt", "package"];
  host.innerHTML = stages
    .map((stage, i) => {
      const meta = STAGE_META[stage];
      return `
      <li class="plan-row" data-stage="${stage}">
        <span class="plan-index">${i + 1}</span>
        <span class="plan-main">
          <span class="plan-title">${esc(meta.title)}<span class="tag">${esc(meta.tool)}</span></span>
          <span class="plan-sum" data-plan-sum></span>
          <span class="plan-artifacts" data-plan-artifacts></span>
        </span>
        <span class="status ${STATUS_CLASS[statuses[stage]]}" data-badge>${STATUS_TEXT[statuses[stage]]}</span>
        <button class="btn btn-quiet btn-sm" type="button" data-run>单独执行</button>
      </li>`;
    })
    .join("");

  host.querySelectorAll<HTMLElement>("[data-stage]").forEach((row) => {
    const stage = row.dataset.stage as Stage;
    const btn = row.querySelector<HTMLElement>("[data-run]");
    if (btn) btn.onclick = () => void runStage(stage);
  });

  updatePlanSums();
  updatePlanArtifacts();
  updateAllBadges();
  updateRunButtons();
}

function updatePlanSums() {
  workspace.querySelectorAll<HTMLElement>("[data-stage]").forEach((row) => {
    const el = row.querySelector<HTMLElement>("[data-plan-sum]");
    if (el) el.textContent = stageSummary(row.dataset.stage as Stage);
  });
}

function updatePlanArtifacts() {
  workspace.querySelectorAll<HTMLElement>("[data-stage]").forEach((row) => {
    const stage = row.dataset.stage as Stage;
    const host = row.querySelector<HTMLElement>("[data-plan-artifacts]");
    if (!host) return;
    const list = artifacts[stage] ?? [];
    host.innerHTML = list
      .map(
        (p) =>
          `<button class="artifact" type="button" data-reveal="${esc(p)}" title="${esc(
            p,
          )}\n点击在资源管理器中显示">${esc(baseName(p))}</button>`,
      )
      .join("");
    host.querySelectorAll<HTMLElement>("[data-reveal]").forEach((btn) => {
      btn.onclick = () => void reveal(btn.dataset.reveal!).catch(() => toast("无法打开文件位置", "error"));
    });
  });
}

// ---------------------------------------------------------------- 阶段状态

function updateBadge(stage: Stage) {
  workspace.querySelectorAll<HTMLElement>(`[data-stage="${stage}"] [data-badge]`).forEach((badge) => {
    const status = statuses[stage];
    badge.className = `status ${STATUS_CLASS[status]}`.trim();
    badge.textContent = STATUS_TEXT[status];
  });
}

function updateAllBadges() {
  (Object.keys(statuses) as Stage[]).forEach(updateBadge);
  updateRunButtons();
}

function updateRunButtons() {
  workspace.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((btn) => {
    btn.disabled = busy;
  });
  const all = workspace.querySelector<HTMLButtonElement>('[data-act="run-all"]');
  if (all) all.disabled = busy;
  const next = workspace.querySelector<HTMLButtonElement>('[data-nav="next"]');
  if (next && step === STEP_ORDER[STEP_ORDER.length - 1]) next.disabled = busy;
}

/** 执行进度的一行说明（只有「全部执行」与「单独执行」会用到它）。 */
function setRunProgress(text: string) {
  const el = workspace.querySelector<HTMLElement>("[data-run-progress]");
  if (!el) return;
  el.textContent = text;
  el.hidden = text === "";
}

/** `runAll` 正在进行时为 true：进度行由它统一维护，`runStage` 不要插手。 */
let runningAll = false;

async function runStage(stage: Stage): Promise<"ok" | "skipped" | "failed" | "aborted"> {
  // 快照当前工程：执行是长任务，期间 `current` 可能被换掉。
  // 所有写回（状态、产出、保存状态）都必须先确认目标没变，
  // 否则会把结果写到另一个工程上。
  const proj = current;
  if (!proj || busy) return "failed";

  if (!proj.exeFile) {
    toast("请先在「主程序」步骤选择主程序文件", "error");
    goStep("setup");
    return "failed";
  }

  const sameProject = () => current?.id === proj.id;

  busy = true;
  applyBusyLock();
  if (!runningAll) setRunProgress(`正在执行：${STAGE_META[stage].title}…`);
  statuses = { ...statuses, [stage]: "running" };
  updateAllBadges();
  syncStepSubs();

  try {
    // 先把防抖中的待保存修改结算掉 —— 否则这次执行可能跑在磁盘上的旧内容上。
    // 落盘的最终权威在 Rust 侧：`run_stage` 拿到工程后会先 `save_project` 再执行，
    // 所以这里不做无条件保存，同一份内容不该被写两次。
    await flushPendingSave();

    const outcome = await api.runStage(proj, stage);

    if (!sameProject()) {
      // 期间切了工程：这份结果属于旧工程，只报告、不写进当前界面
      toast(`工程「${proj.name}」的${STAGE_META[stage].title}：${outcome.message}`, "info");
      return "aborted";
    }

    const status = outcome.status === "ok" ? "ok" : outcome.status === "skipped" ? "skipped" : "failed";
    statuses = { ...statuses, [stage]: status };
    if (outcome.artifacts.length > 0) artifacts = { ...artifacts, [stage]: outcome.artifacts };

    toast(
      outcome.message,
      status === "ok" ? "success" : status === "failed" ? "error" : "info",
    );
    return status;
  } catch (err) {
    if (!sameProject()) return "aborted";
    statuses = { ...statuses, [stage]: "failed" };
    toast(String(err), "error");
    return "failed";
  } finally {
    busy = false;
    applyBusyLock();
    if (!runningAll) setRunProgress("");
    updateAllBadges();
    updatePlanSums();
    updatePlanArtifacts();
    syncStepSubs();
  }
}

/** 全部执行：合并 → 加密 → 打包，失败即停（后续步骤依赖前一步的产物）。 */
async function runAll() {
  const proj = current;
  if (!proj || busy) return;

  // 前置条件在这里一次说清。原先 runStage 也会检查并 toast，导致用户连吃两条
  // 含义重叠的报错；现在 runAll 自己检查完就返回，不会再把 runStage 叫起来。
  if (!proj.exeFile) {
    toast("请先在「主程序」步骤选择主程序文件", "error");
    goStep("setup");
    return;
  }

  const stages: Stage[] = ["merge", "encrypt", "package"];
  runningAll = true;
  try {
    for (let i = 0; i < stages.length; i += 1) {
      const stage = stages[i]!;
      // 工程被切走（列表虽已锁定，但快捷键/程序化路径仍可能触发）→ 静默中止
      if (current?.id !== proj.id) return;

      setRunProgress(`正在执行 ${i + 1} / ${stages.length}：${STAGE_META[stage].title}…`);
      const result = await runStage(stage);

      if (result === "aborted") return;
      if (result === "failed") {
        toast(`「${STAGE_META[stage].title}」未完成，已中止后续步骤`, "error");
        return;
      }
    }
    if (current?.id === proj.id) toast("全部步骤已完成", "success");
  } finally {
    runningAll = false;
    setRunProgress("");
  }
}

// ---------------------------------------------------------------- 工程增删改查

/**
 * 把与「当前工程」绑定的界面状态全部清空。
 * 切工程、删工程、工程列表变空，三条路径都要走一遍 —— 否则空状态页面上
 * 还挂着上一个工程的运行日志与阶段徽标。
 */
function resetWorkspaceState() {
  statuses = { merge: "idle", encrypt: "idle", package: "idle" };
  artifacts = {};
  treeNode = null;
  treeError = "";
  scanning = false;
  picker = null;
  ignores = null;
  activeTextarea = null;
  setRunProgress("");
  setSaveState("idle");
  logPanel.reset();
}

async function selectProject(id: string) {
  // 先结算待落盘的修改：一旦 `current` 换人，防抖里的那次保存就会落到新工程上，
  // 旧工程最后 600ms 内的编辑会静默丢失。
  await flushPendingSave();

  try {
    current = await api.loadProject(id);
  } catch (err) {
    toast(String(err), "error");
    return;
  }
  resetWorkspaceState();
  renderProjectList();
  renderWorkspace();
}

async function refreshProjects(preferId?: string) {
  await flushPendingSave();

  const list = await api.listProjects();
  projects = list.projects;
  renderProjectList();

  // 解析失败的工程文件此前是静默跳过的：列表里少了一个，用户却没有任何解释。
  if (list.unreadable.length > 0) {
    toast(
      `有 ${list.unreadable.length} 个工程文件无法读取，已从列表隐藏：${list.unreadable.join("、")}`,
      "error",
    );
  }

  const target = preferId ?? current?.id;
  const found = target ? projects.find((p) => p.id === target) : undefined;

  if (found) {
    if (current?.id !== found.id) await selectProject(found.id);
    return;
  }
  if (projects.length > 0) {
    await selectProject(projects[0]!.id);
    return;
  }
  current = null;
  resetWorkspaceState();
  renderWorkspace();
}

async function createProject() {
  const input = await newProjectDialog();
  if (!input) return;
  try {
    const created = await api.createProject(input.name, input.exeFile, input.outputDir);
    toast(`工程「${created.name}」已创建`, "success");
    await refreshProjects(created.id);
  } catch (err) {
    toast(String(err), "error");
  }
}

async function removeProject(project: Project) {
  const ok = await confirmDialog(
    "删除工程",
    `确定删除工程「${project.name}」？仅移除工程配置，不会删除你的程序文件。`,
    true,
  );
  if (!ok) return;

  // 要删的就是当前工程：待落盘的修改已经没有意义，直接丢掉定时器即可；
  // 删的是别的工程：当前工程的改动必须先结算，不能被这次操作带掉。
  if (current?.id === project.id) discardPendingSave();
  else await flushPendingSave();

  try {
    await api.deleteProject(project.id);
    if (current?.id === project.id) current = null;
    toast("工程已删除", "success");
    await refreshProjects();
  } catch (err) {
    toast(String(err), "error");
  }
}

// ---------------------------------------------------------------- 启动

async function bootstrap() {
  try {
    const [status, ph, settings, runtime] = await Promise.all([
      api.toolStatus(),
      api.placeholders(),
      api.getSettings(),
      api.environmentStatus(),
    ]);
    toolStatus = status;
    placeholders = ph;
    appSettings = settings;
    runtimeStatus = runtime;
  } catch (err) {
    toast(`初始化失败：${String(err)}`, "error");
  }
  renderToolchain();
  renderEnvBanner();

  try {
    await refreshProjects();
  } catch (err) {
    toast(`读取工程列表失败：${String(err)}`, "error");
    renderWorkspace();
  }
}

// ---- 桌面化行为（拦掉刷新/打印/查找/缩放/拖拽等浏览器行为）
installDesktopBehaviour();

// ---- 快捷键：都在界面里可见（按钮上的 <kbd> 或 tooltip）
const kbdHost = document.getElementById("settings-kbd");
if (kbdHost) kbdHost.textContent = shortcutLabel(",");
registerShortcut("mod+,", () => void openSettings());
registerShortcut("mod+w", () => void closeWindow().catch(() => {}));
registerShortcut("escape", () => closeContextMenu());

// 向导翻页：Alt + ←/→。桌面程序里「上一步/下一步」有键盘路径是基本要求。
registerShortcut("alt+arrowright", () => {
  const idx = STEP_ORDER.indexOf(step);
  if (idx < STEP_ORDER.length - 1) goStep(STEP_ORDER[idx + 1]!);
});
registerShortcut("alt+arrowleft", () => {
  const idx = STEP_ORDER.indexOf(step);
  if (idx > 0) goStep(STEP_ORDER[idx - 1]!);
});

renderSkinSwitch();
syncDesignUi();

document.getElementById("new-project")!.onclick = () => void createProject();
document.getElementById("settings-btn")!.onclick = () => void openSettings();
wireWindowControls();
attachLogMenu();
void renderVersion();

void onLog((event) => logPanel.append(event));
void onStage((event) => {
  statuses = { ...statuses, [event.stage]: event.status };
  updateBadge(event.stage);
  syncStepSubs();
});

void bootstrap();

// ---- 窗口材质：Rust 侧 set_effects() 的结果决定 chrome 要不要半透明。
// 先问出来再显示窗口，否则会先看到一帧实色、再跳成半透明；
// 万一 IPC 迟迟不回（400ms），照常显示，结果回来后再补上属性。
void (async () => {
  const probe = windowMaterial().then((ok) => {
    design.setMaterialSupported(ok);
    return ok;
  });
  await Promise.race([probe, new Promise((resolve) => setTimeout(resolve, 400))]);
  revealWindowWhenReady();
})();
