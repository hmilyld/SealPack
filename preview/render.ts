/**
 * ConfuserEx / Inno Setup 模板的**浏览器侧**生成器。
 *
 * 它是 Rust 侧 `defaults.rs` 的镜像：浏览器预览里没有 Rust，所以这里重写一遍，
 * 目的是让「改选项 → 模板变化」这条链路在预览里也能走通。
 *
 * 两边必须逐字一致，而这件事**不能靠人记得同步**。一致性由
 * `scripts/check-render-parity.mjs` 守着：它拿 Rust 侧 dump 出来的 fixture
 * （`cargo test dump_render_fixtures -- --ignored`）与这里的输出做字符串比对。
 * 改任何一边，都要跑一次那个脚本。
 *
 * 抽成独立模块（而不是留在 mock.ts 里）正是为了让那个脚本能直接 import ——
 * mock.ts 在顶层会往 `window` 上装 IPC 假层，import 它等于启动半个应用。
 *
 * 关键点（两边必须一致）：
 *   · `snKey` / `snKeyPass` 是 `<module>` 的属性，不是 `<project>` 的
 *   · 即使取值等于 ConfuserEx 默认值，也照样显式写 `<argument>`
 *   · 参数只在对应 protection 开启时出现（depth 只跟 expression / x86 走）
 *   · 不认识的值一律退回默认值
 *   · `[Files]` 里主程序由显式那一行加入，`*` 那行要把它排除掉
 */

/** 选项袋：加密 / 打包选项的松散形态，字段名与 Rust 侧的 camelCase 一致。 */
export type OptionBag = Record<string, unknown>;

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const boolStr = (value: unknown): string => (value === true ? "true" : "false");
const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function pick(value: unknown, allowed: string[], fallback: string): string {
  const hit = allowed.find((a) => a.toLowerCase() === str(value).toLowerCase());
  return hit ?? fallback;
}

export function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeElements(raw: unknown): string {
  let out = "";
  for (const ch of str(raw).toUpperCase()) {
    if ("SNPI".includes(ch) && !out.includes(ch)) out += ch;
  }
  return out === "" || out === "P" ? "SI" : out;
}

export function protectionArgs(o: OptionBag, id: string): [string, string][] {
  switch (id) {
    case "anti debug":
      return [["mode", pick(o.debugMode, ["safe", "win32", "antinet"], "safe")]];
    case "anti tamper":
      return [
        ["mode", pick(o.tamperMode, ["normal", "jit"], "normal")],
        ["key", pick(o.tamperKey, ["normal", "dynamic"], "normal")],
      ];
    case "constants":
      return [
        ["mode", pick(o.constMode, ["normal", "dynamic", "x86"], "normal")],
        ["elements", normalizeElements(o.constElements)],
        ["cfg", boolStr(o.constCfg)],
      ];
    case "ctrl flow": {
      const ty = pick(o.cfType, ["switch", "jump"], "switch");
      const args: [string, string][] = [["type", ty]];
      if (ty === "switch") {
        const predicate = pick(o.cfPredicate, ["normal", "expression", "x86"], "normal");
        args.push(["predicate", predicate]);
        // depth 只影响 expression / x86 这两种谓词
        if (predicate !== "normal") {
          args.push(["depth", String(Math.min(Math.max(num(o.cfDepth, 4), 1), 16))]);
        }
      }
      args.push(["intensity", String(Math.min(num(o.cfIntensity, 60), 100))]);
      args.push(["junk", boolStr(o.cfJunk)]);
      return args;
    }
    case "rename": {
      const mode = pick(
        o.renameMode,
        ["unicode", "letters", "ascii", "sequential", "decodable", "reversible", "retain"],
        "unicode",
      );
      const args: [string, string][] = [["mode", mode]];
      // password 只在 reversible 模式下被 ConfuserEx 使用
      if (mode === "reversible" && str(o.renamePassword)) args.push(["password", str(o.renamePassword)]);
      args.push(["renameArgs", boolStr(o.renameArgs)]);
      args.push(["renEnum", boolStr(o.renEnum)]);
      args.push(["renPublic", boolStr(o.renPublic)]);
      return args;
    }
    case "ref proxy":
      return [
        ["mode", pick(o.refMode, ["mild", "strong"], "mild")],
        ["internal", boolStr(o.refInternal)],
      ];
    case "resources":
      return [["mode", pick(o.resMode, ["normal", "dynamic"], "normal")]];
    default:
      // 防反汇编 / 防转储 / 无效元数据 / 强化：ConfuserEx 文档明确写了「无参数」
      return [];
  }
}

/** 顺序必须与 Rust 的 `EncryptOptions::enabled_protections()` 一致 */
export function enabledProtections(o: OptionBag): string[] {
  const out: string[] = [];
  if (o.antiIldasm === true) out.push("anti ildasm");
  if (o.antiDebug === true) out.push("anti debug");
  if (o.antiDump === true) out.push("anti dump");
  if (o.antiTamper === true) out.push("anti tamper");
  if (o.constants === true) out.push("constants");
  if (o.controlFlow === true) out.push("ctrl flow");
  if (o.invalidMetadata === true) out.push("invalid metadata");
  if (o.rename === true) out.push("rename");
  if (o.harden === true) out.push("harden");
  if (o.refProxy === true) out.push("ref proxy");
  if (o.resources === true) out.push("resources");
  return out;
}

export function renderEncryptConfig(o: OptionBag): string {
  const preset = pick(o.preset, ["none", "minimum", "normal", "aggressive", "maximum"], "normal");

  let out = '<project outputDir="${root}" baseDir="${root}"';
  const seed = str(o.seed).trim();
  if (seed) out += ` seed="${xmlAttr(seed)}"`;
  if (o.debugSymbols === true) out += ' debug="true"';
  out += ' xmlns="http://confuser.codeplex.com">\n';

  const protections = enabledProtections(o);
  if (protections.length === 0) {
    out += "\t<!-- 未启用任何 protection 规则，仅做打包 -->\n";
  } else {
    out += `\t<rule pattern="true" preset="${preset}" inherit="false">\n`;
    for (const id of protections) {
      const args = protectionArgs(o, id);
      if (args.length === 0) {
        out += `\t\t<protection id="${id}" />\n`;
      } else {
        out += `\t\t<protection id="${id}">\n`;
        for (const [name, value] of args) {
          out += `\t\t\t<argument name="${name}" value="${xmlAttr(value)}" />\n`;
        }
        out += "\t\t</protection>\n";
      }
    }
    out += "\t</rule>\n";
  }

  if (o.compress === true) out += '\t<packer id="compressor" />\n';

  // 强名称签名：RSA 私钥签名 + 公钥内嵌，属于非对称加密
  const snKey = str(o.snKeyPath).trim();
  out += '\t<module path="${exe}"';
  if (snKey) {
    out += ` snKey="${xmlAttr(snKey)}"`;
    const pass = str(o.snKeyPass).trim();
    if (pass) out += ` snKeyPass="${xmlAttr(pass)}"`;
  }
  out += " />\n</project>\n";
  return out;
}

/** Inno Setup 的 Compression 取值：算法 + 等级写成一个值（官方取值的子集） */
const COMPRESSIONS = [
  "lzma2/max",
  "lzma2/normal",
  "lzma2/fast",
  "lzma/max",
  "lzma/normal",
  "lzma/fast",
  "zip",
  "bzip",
  "none",
];

// Inno 的边界值，抄自官方文档（`topic_setup_*`），必须与 defaults.rs 的同名常量一致
const LZMA_DICT_MIN_KB = 4;
const LZMA_DICT_MAX_KB = 3932160;
const LZMA_THREADS_MAX = 256;
const SLICE_MIN_BYTES = 262144;
/** 官方上限。超出 JS 安全整数范围，但它的最短往返表示恰好还是这串数字 */
const SLICE_MAX_BYTES = 9223372036800000000;
const SLICES_MIN = 1;
const SLICES_MAX = 26;

export function renderPackageScript(o: OptionBag): string {
  const compression = pick(o.compression, COMPRESSIONS, "lzma2/max");
  const algo = compression.split("/")[0]!;
  const isLzma = algo === "lzma" || algo === "lzma2";
  const compressing = compression !== "none";

  const mode = pick(o.packagingMode, ["single", "portable", "multi_volume"], "single");
  const portable = mode === "portable";
  const multiVolume = mode === "multi_volume";

  const encryption = pick(o.encryption, ["no", "yes", "full"], "yes");
  const privileges = o.requireAdmin === true ? "admin" : "lowest";
  const wizard = pick(o.wizardStyle, ["modern", "classic"], "modern");

  let out = "; SealPack 打包脚本（Inno Setup）\n";
  out += "; 本文件由界面上的选项生成；在「高级」里直接编辑后会转为自定义模式。\n";
  out += "; 占位符使用 ${key} 语法，执行时会被替换为工程实际值\n\n";
  out += '#define MyAppName "${name}"\n';
  out += '#define MyAppVersion "${version}"\n';
  out += '#define MyAppExeName "${exe}"\n';
  out += '#define MyAppPublisher "hmilyld"\n';
  out += '#define MyAppURL "https://hmilyld.com/"\n\n';
  out += "[Setup]\n";
  // AppId 决定覆盖升级还是全新安装；取自「应用标识」选项，不是工程 ID。
  // 末尾的 `}` 是字面量：`{{` 转义成一个 `{`，于是 AppId 形如 `{GUID}`。
  out += "AppId={{${appId}}\n";
  out += "AppName={#MyAppName}\n";
  out += "AppVersion={#MyAppVersion}\n";
  out += "AppPublisher={#MyAppPublisher}\n";
  out += "AppPublisherURL={#MyAppURL}\n";
  out += "AppSupportURL={#MyAppURL}\n";
  out += "AppUpdatesURL={#MyAppURL}\n";
  out += "DefaultDirName={autopf}\\{#MyAppName}\n";
  out += "DisableProgramGroupPage=yes\n";
  out += `PrivilegesRequired=${privileges}\n`;
  out += "OutputDir=${output}\n";
  out += "OutputBaseFilename={#MyAppName}-安装包-{#MyAppVersion}\n";

  out += `Compression=${compression}\n`;
  if (o.solidCompression === true && compressing) out += "SolidCompression=yes\n";
  if (isLzma && compressing) {
    // 0 表示「交给 Inno 按压缩等级自动决定」，此时不写这一行
    const dict = num(o.lzmaDictionarySize, 0);
    if (dict >= LZMA_DICT_MIN_KB) {
      out += `LZMADictionarySize=${Math.min(dict, LZMA_DICT_MAX_KB)}\n`;
    }
    // 0 = 不写这一行，Inno 用它自己的默认值 1
    const threads = num(o.lzmaNumBlockThreads, 0);
    if (threads > 0) out += `LZMANumBlockThreads=${Math.min(threads, LZMA_THREADS_MAX)}\n`;
    out += `LZMAMatchFinder=${pick(o.lzmaMatchFinder, ["BT", "HC"], "BT")}\n`;
    if (o.lzmaUseSeparateProcess === true) out += "LZMAUseSeparateProcess=yes\n";
  }

  if (multiVolume) {
    out += "DiskSpanning=yes\n";
    const slice = num(o.diskSliceSize, 0);
    if (slice >= SLICE_MIN_BYTES) {
      out += `DiskSliceSize=${Math.min(slice, SLICE_MAX_BYTES)}\n`;
    }
    const perDisk = num(o.slicesPerDisk, 1);
    out += `SlicesPerDisk=${Math.min(Math.max(perDisk, SLICES_MIN), SLICES_MAX)}\n`;
  }

  // yes 与 full 都由编译器用 `Password` 派生密钥
  if (encryption !== "no") {
    out += "Password=${password}\n";
    out += `Encryption=${encryption}\n`;
    out += `EncryptionKeyDerivation=pbkdf2/${Math.max(num(o.kdfIterations, 220000), 1)}\n`;
  }

  const signTool = str(o.signTool).trim();
  if (signTool) {
    out += `SignTool=${signTool}\n`;
    if (o.signedUninstaller === true) out += "SignedUninstaller=yes\n";
  }

  if (portable) {
    out += "Uninstallable=no\n";
    out += "CreateUninstallRegKey=no\n";
  } else if (o.uninstallable !== true) {
    out += "Uninstallable=no\n";
  }

  out += `WizardStyle=${wizard}\n\n`;
  out += "[Languages]\n";
  // 简体中文不在 Inno Setup 官方发行版里，所以用相对路径引用随应用分发的那份语言包
  out += 'Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"\n\n';

  // 绿色版不建开始菜单项与桌面图标，所以也不生成 [Tasks]
  if (o.desktopIcon === true && !portable) {
    out += "[Tasks]\n";
    out +=
      'Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked\n\n';
  }

  out += "[Files]\n";
  out += 'Source: "${root}\\${exe}"; DestDir: "{app}"; Flags: ignoreversion\n';
  // 主程序由上一行显式加入，`*` 这一行必须把它排除掉（否则同一文件进包两次）
  out +=
    'Source: "${root}\\*"; Excludes: "${ignore},${exe}"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs\n\n';

  if (!portable) {
    out += "[Icons]\n";
    out += 'Name: "{autoprograms}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"\n';
    if (o.desktopIcon === true) {
      out +=
        'Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; Tasks: desktopicon\n';
    }
    out += "\n";
  }

  if (o.runAfterInstall === true && !portable) {
    out += "[Run]\n";
    out +=
      "Filename: \"{app}\\{#MyAppExeName}\"; Description: \"{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}\"; Flags: nowait postinstall skipifsilent\n";
  }

  return out;
}
