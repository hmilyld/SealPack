// 浏览器内 UI 预览用的 Tauri IPC 模拟层。
// 用法：pnpm run dev 后打开 http://localhost:1420/preview.html
// 可通过 ?theme=light / ?theme=dark 指定主题。
import { renderEncryptConfig, renderPackageScript } from "./render";

const ROOT = "D:\\Projects\\SampleTool\\bin\\Release";

const encryptOptions = {
  preset: "normal",
  antiIldasm: false,
  antiDump: false,
  antiTamper: false,
  tamperMode: "normal",
  tamperKey: "normal",
  antiDebug: false,
  debugMode: "safe",
  invalidMetadata: false,
  harden: false,
  rename: false,
  renameMode: "unicode",
  renamePassword: "",
  renameArgs: true,
  renEnum: false,
  renPublic: false,
  controlFlow: false,
  cfType: "switch",
  cfPredicate: "normal",
  cfIntensity: 60,
  cfDepth: 4,
  cfJunk: false,
  refProxy: false,
  refMode: "mild",
  refInternal: false,
  constants: false,
  constMode: "normal",
  constElements: "SI",
  constCfg: false,
  resources: false,
  resMode: "normal",
  compress: true,
  seed: "",
  debugSymbols: false,
  snKeyPath: "",
  snKeyPass: "",
  generated: true,
};

const packageOptions = {
  compression: "lzma2/max",
  solidCompression: true,
  lzmaDictionarySize: 0,
  lzmaNumBlockThreads: 0,
  lzmaMatchFinder: "bt",
  lzmaUseSeparateProcess: false,
  packagingMode: "single",
  diskSliceSize: 0,
  slicesPerDisk: 1,
  // 空 = 由主程序推导。预览里点了「选择主程序」会被 mock 的 exe_app_id 填上
  appId: "",
  encryption: "yes",
  kdfIterations: 220000,
  signTool: "",
  signedUninstaller: false,
  desktopIcon: true,
  runAfterInstall: true,
  requireAdmin: false,
  uninstallable: true,
  wizardStyle: "modern",
  checksum: "none",
  generated: true,
};

/**
 * 模板生成器住在 `preview/render.ts`：抽出去是为了让
 * `scripts/check-render-parity.mjs` 能直接 import 它们做一致性校验，
 * 而不必先启动这一整套假 IPC 层。改 Rust 侧时记得跑那个脚本。
 */

const project = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "示例工具",
  rootPath: ROOT,
  exeFile: `${ROOT}\\SampleTool.exe`,
  outputDir: "D:\\Projects\\SampleTool\\Setup",
  password: "install-2026",
  version: "1.4.2.0",
  mergeDlls: [`${ROOT}\\Newtonsoft.Json.dll`, `${ROOT}\\NPOI.dll`, `${ROOT}\\libs\\NLog.dll`],
  excludePaths: ["SampleTool.pdb"],
  encryptOptions,
  packageOptions,
  encryptConfig: renderEncryptConfig(encryptOptions),
  packageScript: renderPackageScript(packageOptions),
};

const file = (name: string) => ({ name, path: `${ROOT}\\${name}`, isDir: false, children: [] });
const fileIn = (dir: string, name: string) => ({
  name,
  path: `${ROOT}\\${dir}\\${name}`,
  isDir: false,
  children: [],
});

const tree = {
  name: "Release",
  path: ROOT,
  isDir: true,
  children: [
    {
      name: "libs",
      path: `${ROOT}\\libs`,
      isDir: true,
      children: [fileIn("libs", "NLog.dll"), fileIn("libs", "protobuf-net.dll")],
    },
    file("SampleTool.exe"),
    file("Newtonsoft.Json.dll"),
    file("NPOI.dll"),
    file("ICSharpCode.SharpZipLib.dll"),
    file("EntityFramework.dll"),
    file("SampleTool.pdb"),
    file("SampleTool.exe.config"),
    file("readme.txt"),
  ],
};

// ---------------------------------------------------------------- 事件派发
//
// 浏览器里没有真实的 IPC 事件通道，所以自己维护一张「事件 → 回调」注册表。
// 只 mock invoke 而不 mock emit 是不够的：下载进度、流水线日志都靠它推送，
// 那样界面里「后台正在跑」的部件在预览里就是死的，一点也验证不到。
const listeners = new Map<string, Set<(message: unknown) => void>>();

function emitEvent(event: string, payload: unknown): void {
  for (const listener of [...(listeners.get(event) ?? [])]) {
    listener({ event, id: 0, payload });
  }
}

// ---------------------------------------------------------------- 工具状态

/** 下载目录：与 Rust 侧 `user_tools_dir`（应用数据目录下的 tools）对应。
 *  数据目录按 tauri.conf.json 的 identifier 推导，Windows 下是 %APPDATA%\<id>。 */
const DOWNLOAD_DIR = "C:\\Users\\hmilyld\\AppData\\Roaming\\com.hmilyld.sealpack\\tools";

const BASE_TOOL_ITEMS = [
  {
    key: "ilmerge",
    label: "ILMerge",
    path: `${DOWNLOAD_DIR}\\ILMerge\\ILMerge.exe`,
    defaultPath: "C:\\Program Files\\SealPack\\resources\\tools\\ILMerge\\ILMerge.exe",
    available: true,
    overridden: false,
    needsDotnet: true,
    origin: "downloaded",
    download: {
      version: "3.0.41",
      size: 346561,
      origin: "NuGet 官方源",
      note: "ILMerge 必须与同目录的 System.Compiler.dll 一起使用，两者会一并取出。依赖 .NET Framework 运行时。",
      cached: true,
      systemPath: null,
    },
  },
  {
    key: "confuser",
    label: "ConfuserEx",
    path: "D:\\Tools\\ConfuserEx\\Confuser.CLI.exe",
    defaultPath: "C:\\Program Files\\SealPack\\resources\\tools\\ConfuserEx\\Confuser.CLI.exe",
    available: true,
    overridden: true,
    needsDotnet: true,
    origin: "custom",
    download: {
      version: "1.6.0",
      size: 1943620,
      origin: "作者 GitHub 发布页",
      note: "命令行版压缩包，解压即用、不需要安装。依赖 .NET Framework 运行时。",
      cached: false,
      systemPath: null,
    },
  },
  {
    key: "iscc",
    label: "Inno Setup",
    path: "C:\\Program Files\\SealPack\\resources\\tools\\Inno\\ISCC.exe",
    defaultPath: "C:\\Program Files\\SealPack\\resources\\tools\\Inno\\ISCC.exe",
    available: false,
    overridden: false,
    needsDotnet: false,
    origin: "bundled",
        download: {
          version: "6.7.3",
          size: 10592232,
          origin: "Inno Setup 官方发布页",
          note: "官方只提供安装程序、没有便携压缩包，装它需要管理员授权（会弹出 UAC）：它的安装脚本没有设置 PrivilegesRequired，默认按「为所有用户安装」处理，且只允许用对话框切换，不接受 /CURRENTUSER 这类命令行开关。装到本程序的工具目录，不写全局注册表。若你不想授权，可改用手动安装的那一份。",
          cached: false,
          systemPath: "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
        },
  },
];

/** 预览期「已经下载过」的工具：装完就翻成已就绪，再点一次即「重新下载」 */
const downloadedTools = new Set<string>(["ilmerge"]);

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function toolStatus() {
  return {
    toolsDir: "C:\\Program Files\\SealPack\\resources\\tools",
    downloadDir: DOWNLOAD_DIR,
    items: BASE_TOOL_ITEMS.map((item) => {
      if (downloadedTools.has(item.key)) {
        // 下载完成后改走下载目录 —— 与 Rust 侧的三级回退一致
        return {
          ...item,
          available: true,
          overridden: false,
          origin: "downloaded",
          path: item.defaultPath.replace(
            "C:\\Program Files\\SealPack\\resources\\tools",
            DOWNLOAD_DIR,
          ),
          download: item.download ? { ...item.download, cached: true } : null,
        };
      }
      return { ...item };
    }),
  };
}

// ---------------------------------------------------------------- 下载模拟
//
// 下载是「有进度的异步过程」：先推若干帧 download 事件，再走校验 / 解压（或安装）。
// 少了这些事件，进度条就永远停在 0%，下载流程在预览里等于没被验证。
const DOWNLOAD_STEPS: Record<string, number> = { ilmerge: 4, confuser: 6, iscc: 8 };
const pendingDownloads = new Map<string, Promise<unknown>>();

function simulateDownload(key: string): Promise<unknown> {
  const running = pendingDownloads.get(key);
  if (running) return running;

  const item = BASE_TOOL_ITEMS.find((t) => t.key === key);
  const total = item?.download?.size ?? 1_000_000;
  const steps = DOWNLOAD_STEPS[key] ?? 4;
  // Inno Setup 是安装程序，不是压缩包：阶段名跟着换，文案也要换
  const deploy = key === "iscc" ? "install" : "extract";

  const task = (async () => {
    for (let step = 1; step <= steps; step += 1) {
      await sleep(90);
      emitEvent("tools:progress", {
        key,
        phase: "download",
        received: Math.round((total * step) / steps),
        total,
        message: `正在下载 ${key}`,
      });
    }
    emitEvent("tools:progress", {
      key,
      phase: "verify",
      received: 0,
      total: 0,
      message: "正在核对校验值…",
    });
    await sleep(60);
    emitEvent("tools:progress", {
      key,
      phase: deploy,
      received: 0,
      total: 0,
      message: deploy === "install" ? "正在静默安装…" : "正在解压…",
    });
    await sleep(80);
    downloadedTools.add(key);
    return toolStatus();
  })();

  pendingDownloads.set(key, task);
  void task.finally(() => pendingDownloads.delete(key));
  return task;
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  tool_status: () => toolStatus(),
  // 预览里模拟一次下载：先推几帧进度事件，再把工具标记为已就绪。
  // 这样下载条的填充、阶段文案、按钮禁用态在浏览器里都能真的被看到。
  download_tool: (args) => simulateDownload(String(args.key ?? "")),
  get_settings: () => ({
    ilmergePath: "",
    confuserPath: "D:\\Tools\\ConfuserEx\\Confuser.CLI.exe",
    isccPath: "",
  }),
  save_settings: () => handlers.tool_status!({}),
  // 预览时可用 ?dotnet=missing 模拟未安装 .NET Framework
  environment_status: () =>
    new URLSearchParams(location.search).get("dotnet") === "missing"
      ? {
          dotnetAvailable: false,
          dotnetRelease: null,
          dotnetVersion: null,
          dotnetDisplay: "未检测到 .NET Framework 4.x",
        }
      : {
          dotnetAvailable: true,
          dotnetRelease: 533509,
          dotnetVersion: "4.8.09221",
          dotnetDisplay: ".NET Framework 4.8.09221（Release 533509）",
        },
  placeholders: () => [
    ["${id}", "工程标识（GUID）"],
    ["${appId}", "应用标识（AppId）：决定覆盖升级还是全新安装"],
    ["${name}", "工程名称"],
    ["${root}", "主程序所在目录"],
    ["${exe}", "主程序文件名（含扩展名）"],
    ["${exe_stem}", "主程序文件名（不含扩展名）"],
    ["${exe_path}", "主程序完整路径"],
    ["${output}", "安装包输出目录"],
    ["${version}", "版本号"],
    ["${password}", "安装包密码"],
    ["${ignore}", "打包排除项"],
  ],
  // 与 Rust 侧一致：工程列表与「读不出来的文件」一起返回
  list_projects: () => ({ projects: [project], unreadable: [] }),
  load_project: () => project,
  // 预览里没有真实磁盘写入，这些命令直接吞掉。
  // 少了它们，界面上会自动保存失败、标题栏挂一条「保存失败」，看起来像坏了。
  save_project: () => undefined,
  delete_project: () => undefined,
  create_project: (args) => ({
    ...project,
    id: "preview-created",
    name: String(args.name ?? "新工程"),
    exeFile: String(args.exeFile ?? project.exeFile),
    outputDir: String(args.outputDir ?? project.outputDir),
    mergeDlls: [],
    excludePaths: [],
  }),
  // 执行阶段在预览里是模拟的：真实工具链不在浏览器里。
  // 返回成功是为了让「状态徽标 / 产出文件」这两块界面能被看到，
  // 因此 message 里明确写了「预览」。
  run_stage: (args) => {
    const stage = String(args.stage ?? "merge");
    const p = (args.project ?? {}) as Record<string, unknown>;
    const pkg = (p.packageOptions ?? {}) as Record<string, unknown>;
    const checksum = String(pkg.checksum ?? "none");

    const outputs: Record<string, string[]> = {
      merge: [`${ROOT}\\SampleTool.exe`],
      encrypt: [`${ROOT}\\SampleTool.exe`],
      package: ["D:\\Projects\\SampleTool\\Setup\\示例工具-安装包-1.4.2.0.exe"],
    };

    const artifacts = [...(outputs[stage] ?? [])];
    // 与 Rust 侧一致：开了校验清单，打包阶段会多产出一个 checksums-<算法>.txt
    if (stage === "package" && checksum !== "none") {
      artifacts.push(`D:\\Projects\\SampleTool\\Setup\\checksums-${checksum}.txt`);
    }

    return {
      stage,
      status: "ok",
      exitCode: 0,
      message: `预览：模拟${stage} 完成（浏览器里不会真的调用外部工具）`,
      artifacts,
    };
  },
  scan_tree: () => tree,
  exe_version: () => "1.4.2.0",
  // 与 Rust 侧同义：由主程序推导的稳定应用标识。预览里给固定值，
  // 这样每次点「选择主程序」得到的结果都一样（便于断言与肉眼比对）。
  exe_app_id: () => "6f3a1c2e-8b47-5d91-9a04-2c7be5f0d318",
  render_encrypt_config: (args) =>
    renderEncryptConfig({ ...encryptOptions, ...((args.options ?? {}) as object) }),
  render_package_script: (args) =>
    renderPackageScript({ ...packageOptions, ...((args.options ?? {}) as object) }),
  // 与 Rust 侧 Project::auto_ignores / custom_ignores / ignore_list 一致：
  // 自动项 = 待合并程序集（相对化）+ 主程序备份（<stem>.bakup，不含 .exe）；
  // 再拼上自定义项并按小写去重。
  project_ignores: (args) => {
    const p = { ...project, ...((args.project ?? {}) as object) } as typeof project;
    const stem = p.exeFile.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
    const auto = [
      ...p.mergeDlls.map((d) => d.replace(`${p.rootPath}\\`, "")),
      `${stem}.bakup`,
    ];
    const custom = (p.excludePaths ?? []).map((s) => s.trim()).filter(Boolean);
    const seen = new Set<string>();
    const combined = [...auto, ...custom].filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { auto, custom, combined: combined.join(",") };
  },
  // 注册事件监听。transformCallback 直接把函数本身当 id 返回（见文件末尾），
  // 所以这里拿到的是可调用的回调，按事件名存起来，emitEvent 时再叫。
  "plugin:event|listen": (args) => {
    const event = String(args.event ?? "");
    const handler = args.handler;
    if (typeof handler === "function") {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (message: unknown) => void);
      listeners.set(event, set);
    }
    return 1;
  },
  "plugin:event|unlisten": () => undefined,
  // 文件 / 目录选择框：浏览器里没有原生对话框，返回一个像样的假路径，
  // 让「新建工程 → 浏览 → 自动填名」这条链路在预览里也能走通。
  // 想验证「用户取消」的分支时加 ?pick=none。
  "plugin:dialog|open": (args) => {
    if (new URLSearchParams(location.search).get("pick") === "none") return null;
    const options = (args.options ?? {}) as { directory?: boolean; multiple?: boolean };
    if (options.directory) return "D:\\Projects\\SampleTool\\Setup";
    if (options.multiple) {
      return [
        `${ROOT}\\SampleTool.pdb`,
        `${ROOT}\\readme.txt`,
        `${ROOT}\\libs\\protobuf-net.dll`,
      ];
    }
    return `${ROOT}\\SampleTool.exe`;
  },
  "plugin:dialog|save": () => null,
  "plugin:dialog|message": () => undefined,
  "plugin:dialog|ask": () => true,
  "plugin:dialog|confirm": () => true,
  "plugin:opener|reveal_item_in_dir": () => undefined,
};

// 主题 / 皮肤 / 材质的查询参数由 preview.html 的首帧内联脚本处理
// （它必须早于 src/skin.ts 的控制器读取，见那里的注释），这里不再重复处理。

// 预览时可用 ?dialog=settings 自动打开设置弹窗，便于截图验证。
// main.ts 的 bootstrap 是异步的，首次点击时环境信息可能尚未就绪，因此轮询重试直到弹窗出现。
// 注意判据是 `.overlay`（对话框外壳的类名）—— 早先这里找的是 `.z-40`，
// 那个类名早已不存在，导致轮询永远不退出、反复点按钮叠出一堆对话框。
if (new URLSearchParams(location.search).get("dialog") === "settings") {
  const timer = window.setInterval(() => {
    if (document.querySelector(".overlay")) {
      window.clearInterval(timer);
      return;
    }
    document.querySelector<HTMLElement>("#settings-btn")?.click();
  }, 100);
  window.setTimeout(() => window.clearInterval(timer), 10000);
}

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main", windowLabel: "main" },
  },
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const handler = handlers[cmd];
    if (handler) return handler(args ?? {});
    // 窗口相关命令在浏览器预览中直接吞掉
    if (cmd.startsWith("plugin:window|")) {
      if (cmd.includes("is_maximized")) return false;
      return undefined;
    }
    // 应用信息（版本号等）
    if (cmd === "plugin:app|version") return "0.1.0";
    if (cmd === "plugin:app|name") return "SealPack";
    if (cmd.startsWith("plugin:app|")) return undefined;
    // 窗口材质：浏览器里没有 DWM，真实运行时由 Rust 的 set_effects() 决定。
    // 用 ?material=on 让预览走一遍「材质可用」的分支，便于检查半透明 chrome 的观感。
    if (cmd === "window_material") {
      return new URLSearchParams(location.search).get("material") === "on";
    }
    if (cmd.startsWith("plugin:event|")) return 1;
    throw new Error(`mock 未实现命令：${cmd}`);
  },
  transformCallback: (cb: unknown) => cb,
};
