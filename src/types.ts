export type Stage = "merge" | "encrypt" | "package";

export type StageStatus = "idle" | "running" | "ok" | "skipped" | "failed";

/** 向导步骤。前四步是配置，最后一步是执行。 */
export type StepId = "setup" | "merge" | "encrypt" | "package" | "run";

/**
 * 加密选项：界面上的开关与参数，由它生成 ConfuserEx 配置。
 *
 * 字段按加密算法的三个族组织（界面也是这么分组的）：
 *   对称 —— constants / resources / antiTamper（用整模块校验和派生密钥加密方法体）
 *   非对称 —— snKeyPath / snKeyPass（RSA 强名称签名）
 *   哈希 —— antiTamper 的整模块校验和、renameMode=reversible 的口令派生
 */
export interface EncryptOptions {
  /** 保护预设：none | minimum | normal | aggressive | maximum */
  preset: string;

  // 反编译与防篡改
  antiIldasm: boolean;
  antiDump: boolean;
  antiTamper: boolean;
  tamperMode: string;
  tamperKey: string;
  antiDebug: boolean;
  debugMode: string;
  invalidMetadata: boolean;
  harden: boolean;

  // 代码混淆
  rename: boolean;
  renameMode: string;
  renamePassword: string;
  renameArgs: boolean;
  renEnum: boolean;
  renPublic: boolean;
  controlFlow: boolean;
  cfType: string;
  cfPredicate: string;
  cfIntensity: number;
  cfDepth: number;
  cfJunk: boolean;
  refProxy: boolean;
  refMode: string;
  refInternal: boolean;

  // 数据加密（对称）
  constants: boolean;
  constMode: string;
  constElements: string;
  constCfg: boolean;
  resources: boolean;
  resMode: string;

  // 打包与复现
  compress: boolean;
  seed: string;
  debugSymbols: boolean;

  // 签名（非对称）
  snKeyPath: string;
  snKeyPass: string;

  /** false 表示用户在高级区手工改过模板，此时以模板为准 */
  generated: boolean;
}

/**
 * 打包选项：对应 .iss 的 [Setup] / [Tasks] / [Icons] / [Run] 段落。
 *
 *   压缩格式 —— compression（算法+等级，Inno 原生写法）+ lzma* 参数
 *   对称加密 —— encryption（XChaCha20）+ kdfIterations（PBKDF2-HMAC-SHA256）
 *   非对称   —— signTool（Authenticode 代码签名）
 *   哈希     —— checksum（产出校验清单）
 */
export interface PackageOptions {
  compression: string;
  solidCompression: boolean;
  lzmaDictionarySize: number;
  lzmaNumBlockThreads: number;
  lzmaMatchFinder: string;
  lzmaUseSeparateProcess: boolean;

  packagingMode: string;
  diskSliceSize: number;
  slicesPerDisk: number;

  appId: string;

  encryption: string;
  kdfIterations: number;

  signTool: string;
  signedUninstaller: boolean;

  desktopIcon: boolean;
  runAfterInstall: boolean;
  requireAdmin: boolean;
  uninstallable: boolean;
  wizardStyle: string;

  checksum: string;

  generated: boolean;
}

// ---------------------------------------------------------------- 选项 schema
//
// 选项不再是「散落的一堆布尔」，而是一份声明式描述：每项都带上
// 默认值、适用场景说明、以及该暴露哪些参数。界面按这份描述渲染，
// 探针也按这份描述断言 —— 一处定义，两处消费。

export type OptKind = "bool" | "enum" | "text" | "number" | "path";

export interface OptChoice {
  value: string;
  label: string;
  /** 这一档适合什么场景 */
  hint?: string;
}

export interface OptField {
  /** EncryptOptions / PackageOptions 上的键 */
  key: string;
  kind: OptKind;
  label: string;
  /** 适用场景说明：什么情况下用它、代价是什么 */
  hint: string;
  /** 默认值：界面上标注「默认」，也是「恢复默认」的依据 */
  def: boolean | string | number;
  /** 文本控件的占位提示。不写则回退到默认值（默认值为空时显示「留空」） */
  placeholder?: string;
  choices?: OptChoice[];
  min?: number;
  max?: number;
  unit?: string;
  /**
   * 只在主开关处于这些取值时才显示 —— 参数项不该在保护没开的时候碍事。
   * `negate` 用于「填了内容才出现」这种反向条件（如密钥路径非空才问口令）。
   */
  when?: { key: string; in: (string | number | boolean)[]; negate?: boolean };
  /** 该选项会往模板里写什么，用于让「点开关」和「看模板」对得上 */
  writes?: string;
  /**
   * 口令类字段：界面用 `type="password"` 渲染，避免肩窥与截图泄露。
   * 注意落盘仍是明文（见 README 的「口令存放」一节）。
   */
  secret?: boolean;
}

export interface OptGroup {
  id: string;
  title: string;
  /** 这一组解决什么问题 */
  note: string;
  fields: OptField[];
}

/** 一键预设：把一组字段一次性设成给定值，用户仍可随后微调 */
export interface OptPreset {
  id: string;
  label: string;
  /** 适用场景 */
  hint: string;
  values: Record<string, boolean | string | number>;
}

// ---------------------------------------------------------------- 加密

export const ENCRYPT_GROUPS: OptGroup[] = [
  {
    id: "posture",
    title: "保护强度预设",
    note: "先选一档整体强度，再按需微调下面的单项。预设只负责把开关摆到合理位置，随时可以改。",
    fields: [
      {
        key: "preset",
        kind: "enum",
        label: "ConfuserEx 规则预设",
        hint: "写进 <rule preset=\"…\">。显式开启的 protection 会覆盖预设里的同名项，所以它更像是「兜底强度」。",
        def: "normal",
        choices: [
          { value: "none", label: "none", hint: "不使用预设，完全按下面的开关来" },
          { value: "minimum", label: "minimum", hint: "最低强度，兼容性最好" },
          { value: "normal", label: "normal", hint: "公开发布的建议档" },
          { value: "aggressive", label: "aggressive", hint: "更强，但性能有可感知下降" },
          { value: "maximum", label: "maximum", hint: "最强，可能不兼容，需充分回归" },
        ],
        writes: '<rule preset="…">',
      },
    ],
  },
  {
    id: "anti",
    title: "反编译与防篡改",
    note: "目标是「让静态分析变贵、让改动被发现」。这几项对启动速度的影响都很小。",
    fields: [
      {
        key: "antiIldasm",
        kind: "bool",
        label: "防反汇编",
        hint: "阻止 ILDASM 等工具直接打开程序集。零成本，建议常开。",
        def: false,
        writes: '<protection id="anti ildasm" />',
      },
      {
        key: "antiDebug",
        kind: "bool",
        label: "反调试",
        hint: "检测调试器/分析器并阻止附加。对使用性能分析工具的场景不友好。",
        def: false,
        writes: '<protection id="anti debug">',
      },
      {
        key: "debugMode",
        kind: "enum",
        label: "反调试引擎",
        hint: "safe 走托管 API，兼容性最好；win32 走 WinAPI，只能在 Windows 跑；antinet 最强但会产生不可验证的模块，且不兼容 Mono。",
        def: "safe",
        when: { key: "antiDebug", in: [true] },
        choices: [
          { value: "safe", label: "safe（推荐）", hint: "托管 API，跨平台兼容" },
          { value: "win32", label: "win32", hint: "WinAPI，仅 Windows" },
          { value: "antinet", label: "antinet", hint: "最强，不兼容 Mono" },
        ],
      },
      {
        key: "antiTamper",
        kind: "bool",
        label: "反篡改",
        hint: "用整个模块的校验和加密方法体：任何字节被改动，程序就加载不起来。副作用是反编译器里方法体全是空的。会产生不可验证的模块。",
        def: false,
        writes: '<protection id="anti tamper">',
      },
      {
        key: "tamperMode",
        kind: "enum",
        label: "校验时机",
        hint: "normal 在启动时校验一次；jit 在每次方法编译前校验，更难绕过但兼容性差。",
        def: "normal",
        when: { key: "antiTamper", in: [true] },
        choices: [
          { value: "normal", label: "normal（启动时校验）" },
          { value: "jit", label: "jit（逐方法校验，兼容性差）" },
        ],
      },
      {
        key: "tamperKey",
        kind: "enum",
        label: "密钥派生",
        hint: "决定校验和如何变成解密密钥。dynamic 用动态生成的算法，更难还原。",
        def: "normal",
        when: { key: "antiTamper", in: [true] },
        choices: [
          { value: "normal", label: "normal（静态算法）" },
          { value: "dynamic", label: "dynamic（动态算法，更强）" },
        ],
      },
      {
        key: "antiDump",
        kind: "bool",
        label: "防转储",
        hint: "阻止把解密后的程序集从内存里 dump 出来。依赖 WinAPI，仅 Windows；会产生不可验证的模块。",
        def: false,
        writes: '<protection id="anti dump" />',
      },
      {
        key: "invalidMetadata",
        kind: "bool",
        label: "无效元数据",
        hint: "写入畸形元数据，让反编译器的解析直接出错。对运行时无影响，但某些扫描工具会误报。",
        def: false,
        writes: '<protection id="invalid metadata" />',
      },
      {
        key: "harden",
        kind: "bool",
        label: "强化保护自身",
        hint: "加固其它 protection 的运行时，显著提高「脱壳」成本。只在同时启用了别的保护时才有意义。",
        def: false,
        writes: '<protection id="harden" />',
      },
    ],
  },
  {
    id: "obfuscate",
    title: "代码混淆",
    note: "目标是「反编译出来的代码读不懂、也编译不回去」。重命名最有效，但对反射密集的程序有风险。",
    fields: [
      {
        key: "rename",
        kind: "bool",
        label: "重命名符号",
        hint: "把类名、方法名改成无意义字符。最有效的反编译阻碍。注意：使用反射按名字查找、或通过序列化跨程序集通信的程序可能被破坏。",
        def: false,
        writes: '<protection id="rename">',
      },
      {
        key: "renameMode",
        kind: "enum",
        label: "重命名方式",
        hint: "unicode 最难读但反射会失效；letters 兼容性最好；sequential 会输出 symbols.map，便于用崩溃日志里的名字反查；reversible 用口令加密符号名，需要时可还原。",
        def: "unicode",
        when: { key: "rename", in: [true] },
        choices: [
          { value: "unicode", label: "unicode（默认，不可读字符）" },
          { value: "letters", label: "letters（英文字母，兼容性最好）" },
          { value: "sequential", label: "sequential（编号 + symbols.map）" },
          { value: "decodable", label: "decodable（可解码 + symbols.map）" },
          { value: "reversible", label: "reversible（口令可逆）" },
          { value: "retain", label: "retain（不重命名）" },
        ],
      },
      {
        key: "renamePassword",
        kind: "text",
        label: "符号还原口令",
        hint: "仅在 reversible 方式下生效。上线后收到崩溃日志，可用这个口令把混淆名还原成原始名。",
        def: "",
        when: { key: "renameMode", in: ["reversible"] },
        secret: true,
      },
      {
        key: "renameArgs",
        kind: "bool",
        label: "连方法参数名一起重命名",
        hint: "参数名会出现在堆栈与反射结果里，一并改掉更彻底。",
        def: true,
        when: { key: "rename", in: [true] },
      },
      {
        key: "renEnum",
        kind: "bool",
        label: "重命名枚举成员",
        hint: "枚举成员名常被当作字符串序列化或写进配置，开了以后要确认没有依赖名字的地方。",
        def: false,
        when: { key: "rename", in: [true] },
      },
      {
        key: "renPublic",
        kind: "bool",
        label: "重命名公开成员",
        hint: "供外部调用的类库不要开 —— 调用方是按名字找的，改了就对不上。独立可执行程序可以开。",
        def: false,
        when: { key: "rename", in: [true] },
      },
      {
        key: "controlFlow",
        kind: "bool",
        label: "控制流混淆",
        hint: "打乱方法内部的控制流，反编译后逻辑读不通。体积会明显增大，执行也变慢。",
        def: false,
        writes: '<protection id="ctrl flow">',
      },
      {
        key: "cfType",
        kind: "enum",
        label: "混淆方式",
        hint: "switch 用状态机重排（推荐）；jump 插入跳转制造面条代码，会产生不可验证的模块。",
        def: "switch",
        when: { key: "controlFlow", in: [true] },
        choices: [
          { value: "switch", label: "switch（状态机重排，推荐）" },
          { value: "jump", label: "jump（跳转花指令，不可验证）" },
        ],
      },
      {
        key: "cfPredicate",
        kind: "enum",
        label: "状态变量存放方式",
        hint: "normal 直接存；expression 用动态表达式编码，更难跟踪；x86 用原生 x86 表达式，会破坏 AnyCPU。",
        def: "normal",
        when: { key: "cfType", in: ["switch"] },
        choices: [
          { value: "normal", label: "normal（直接存放）" },
          { value: "expression", label: "expression（表达式编码）" },
          { value: "x86", label: "x86（原生表达式，破坏 AnyCPU）" },
        ],
      },
      {
        key: "cfIntensity",
        kind: "number",
        label: "切块强度",
        hint: "0–100。数值越小，每个基本块被切得越碎、越难读，但执行越慢。60 是 ConfuserEx 的默认值。",
        def: 60,
        min: 0,
        max: 100,
        when: { key: "controlFlow", in: [true] },
      },
      {
        key: "cfDepth",
        kind: "number",
        label: "表达式深度",
        hint: "仅在状态变量用 expression / x86 存放时生效。越深越难还原，编译越慢。",
        def: 4,
        min: 1,
        max: 16,
        when: { key: "cfPredicate", in: ["expression", "x86"] },
      },
      {
        key: "cfJunk",
        kind: "bool",
        label: "插入垃圾代码",
        hint: "在方法里塞入永不执行的代码干扰阅读。明显增大体积，且会产生不可验证的模块。",
        def: false,
        when: { key: "controlFlow", in: [true] },
      },
      {
        key: "refProxy",
        kind: "bool",
        label: "引用代理",
        hint: "把字段/方法的直接引用改成间接调用，隐藏「谁调用了谁」。对启动速度有轻微影响。",
        def: false,
        writes: '<protection id="ref proxy">',
      },
      {
        key: "refMode",
        kind: "enum",
        label: "代理方式",
        hint: "mild 加一层间接方法（轻量）；strong 用动态委托，更难还原但更慢。",
        def: "mild",
        when: { key: "refProxy", in: [true] },
        choices: [
          { value: "mild", label: "mild（间接方法，轻量）" },
          { value: "strong", label: "strong（动态委托，更强）" },
        ],
      },
      {
        key: "refInternal",
        kind: "bool",
        label: "连内部调用也代理",
        hint: "默认只代理跨程序集调用。打开后程序集内部的调用也走代理，更强但更慢。",
        def: false,
        when: { key: "refProxy", in: [true] },
      },
    ],
  },
  {
    id: "data",
    title: "数据加密（对称）",
    note: "把常量与内嵌资源编码后存放，运行时再解码 —— 这是 .NET 程序集里最直接的「对称加密」落点，密钥由 ConfuserEx 随机生成并藏进解码器。",
    fields: [
      {
        key: "constants",
        kind: "bool",
        label: "常量加密",
        hint: "加密字符串与数字常量，让反编译出来的代码里看不到关键字、接口地址、密钥片段。",
        def: false,
        writes: '<protection id="constants">',
      },
      {
        key: "constMode",
        kind: "enum",
        label: "编码方式",
        hint: "normal 用带随机参数的静态算法；dynamic 现场生成算法；x86 生成原生 x86 表达式，最强但会破坏 AnyCPU。",
        def: "normal",
        when: { key: "constants", in: [true] },
        choices: [
          { value: "normal", label: "normal（静态算法 + 随机参数）" },
          { value: "dynamic", label: "dynamic（动态生成算法）" },
          { value: "x86", label: "x86（原生表达式，破坏 AnyCPU）" },
        ],
      },
      {
        key: "constElements",
        kind: "enum",
        label: "加密哪些常量",
        hint: "S 字符串、N 数字、P 常用值（0/1/-1 之类）、I 数组初始化器。可组合，例如 SNI。P 必须与 S 或 N 同时出现。",
        def: "SI",
        when: { key: "constants", in: [true] },
        choices: [
          { value: "SI", label: "SI（字符串 + 数组，默认）" },
          { value: "S", label: "S（只加密字符串）" },
          { value: "N", label: "N（只加密数字）" },
          { value: "SN", label: "SN（字符串 + 数字）" },
          { value: "SNI", label: "SNI（字符串 + 数字 + 数组，最全）" },
          { value: "SNPI", label: "SNPI（连 0/1 等常用值一起，最重）" },
        ],
      },
      {
        key: "constCfg",
        kind: "bool",
        label: "解码依赖控制流状态",
        hint: "把解码过程绑定到控制流状态变量上，静态还原难度大幅提高，代价是运行时性能有可感知下降。",
        def: false,
        when: { key: "constants", in: [true] },
      },
      {
        key: "resources",
        kind: "bool",
        label: "资源加密",
        hint: "加密内嵌资源（图标、配置文件、内嵌脚本）。资源在加载时解码，启动会稍慢。若已开压缩器，可只留一项以免重复压缩。",
        def: false,
        writes: '<protection id="resources">',
      },
      {
        key: "resMode",
        kind: "enum",
        label: "资源编码方式",
        hint: "normal 用静态算法 + 随机参数；dynamic 现场生成算法，更难还原。",
        def: "normal",
        when: { key: "resources", in: [true] },
        choices: [
          { value: "normal", label: "normal（静态算法）" },
          { value: "dynamic", label: "dynamic（动态生成算法）" },
        ],
      },
    ],
  },
  {
    id: "sign",
    title: "签名与复现（非对称 / 哈希）",
    note: "强名称签名用 RSA 私钥签名、公钥内嵌，属于非对称加密；种子决定构建是否可复现。",
    fields: [
      {
        key: "snKeyPath",
        kind: "path",
        label: "强名称密钥（.snk / .pfx）",
        hint: "用 RSA 私钥给程序集签名，运行时可验证未被替换。留空则不签名。生成密钥：sn -k app.snk。",
        def: "",
        writes: '<module snKey="…">',
      },
      {
        key: "snKeyPass",
        kind: "text",
        label: "密钥口令",
        hint: "仅当上面给的是 .pfx 容器时才需要。.snk 一般没有口令。",
        def: "",
        when: { key: "snKeyPath", in: [""], negate: true },
        secret: true,
      },
      {
        key: "seed",
        kind: "text",
        label: "随机种子",
        hint: "ConfuserEx 的加密参数是随机的。填一个固定值，同样的输入就能得到字节一致的输出，便于「同一版本重新打包应完全一致」这类校验。留空则每次不同。",
        def: "",
        writes: '<project seed="…">',
      },
      {
        key: "debugSymbols",
        kind: "bool",
        label: "生成调试符号",
        hint: "保留 .pdb。线上排障需要它来还原堆栈行号，但发布给用户的包里通常不该带。",
        def: false,
      },
      {
        key: "compress",
        kind: "bool",
        label: "压缩保护",
        hint: "把程序集压缩后加载，体积更小、加载稍慢。与「资源加密」同时开启会压缩两次，二选一即可。",
        def: true,
        writes: '<packer id="compressor" />',
      },
    ],
  },
];

export const ENCRYPT_PRESETS: OptPreset[] = [
  {
    id: "none",
    label: "不加密",
    hint: "只做合并与打包，加密阶段自动跳过",
    values: {
      preset: "none",
      antiIldasm: false,
      antiDump: false,
      antiTamper: false,
      antiDebug: false,
      invalidMetadata: false,
      harden: false,
      rename: false,
      controlFlow: false,
      refProxy: false,
      constants: false,
      resources: false,
      compress: true,
    },
  },
  {
    id: "basic",
    label: "基础",
    hint: "内部工具、快速验证：只做重命名与常量加密，几乎不影响启动速度",
    values: {
      preset: "minimum",
      antiIldasm: true,
      antiDump: false,
      antiTamper: false,
      antiDebug: false,
      invalidMetadata: false,
      harden: false,
      rename: true,
      renameMode: "letters",
      renameArgs: true,
      renEnum: false,
      renPublic: false,
      controlFlow: false,
      refProxy: false,
      constants: true,
      constMode: "normal",
      constElements: "SI",
      constCfg: false,
      resources: false,
      compress: true,
    },
  },
  {
    id: "standard",
    label: "标准（推荐）",
    hint: "常规商业分发：重命名 + 常量加密 + 控制流 + 反调试，兼容性风险低",
    values: {
      preset: "normal",
      antiIldasm: true,
      antiDump: false,
      antiTamper: false,
      antiDebug: true,
      debugMode: "safe",
      invalidMetadata: false,
      harden: false,
      rename: true,
      renameMode: "unicode",
      renameArgs: true,
      renEnum: false,
      renPublic: false,
      controlFlow: true,
      cfType: "switch",
      cfPredicate: "normal",
      cfIntensity: 60,
      cfJunk: false,
      refProxy: true,
      refMode: "mild",
      refInternal: false,
      constants: true,
      constMode: "normal",
      constElements: "SI",
      constCfg: false,
      resources: true,
      resMode: "normal",
      compress: true,
    },
  },
  {
    id: "strict",
    label: "严格",
    hint: "高价值授权软件：再加反篡改、防转储、强化。可能有兼容性风险，务必回归测试",
    values: {
      preset: "aggressive",
      antiIldasm: true,
      antiDump: true,
      antiTamper: true,
      tamperMode: "normal",
      tamperKey: "dynamic",
      antiDebug: true,
      debugMode: "win32",
      invalidMetadata: true,
      harden: true,
      rename: true,
      renameMode: "unicode",
      renameArgs: true,
      renEnum: true,
      renPublic: false,
      controlFlow: true,
      cfType: "switch",
      cfPredicate: "expression",
      cfIntensity: 50,
      cfDepth: 6,
      cfJunk: false,
      refProxy: true,
      refMode: "strong",
      refInternal: true,
      constants: true,
      constMode: "dynamic",
      constElements: "SNI",
      constCfg: true,
      resources: true,
      resMode: "dynamic",
      compress: true,
    },
  },
];

// ---------------------------------------------------------------- 打包

export const PACKAGE_GROUPS: OptGroup[] = [
  {
    id: "compress",
    title: "压缩格式",
    note: "Inno Setup 的压缩格式是「算法 + 等级」写成一个值。压缩率越高，编译越慢、编译时越吃内存。",
    fields: [
      {
        key: "compression",
        kind: "enum",
        label: "压缩格式",
        hint: "lzma2/max 是 Inno 自己的默认值，压缩率最好，适合发布；lzma2/fast 适合频繁出包的联调期；zip 解压最快、兼容性最好；bzip 居中；none 不压缩。官方还有 lzma2/ultra 与 lzma2/ultra64（字典 32/64 MB，压缩时分别要 374 MB / 742 MB 内存），本工具刻意不列，需要时可在高级区直接改模板。",
        def: "lzma2/max",
        choices: [
          { value: "lzma2/max", label: "lzma2/max（默认，压缩率最高）" },
          { value: "lzma2/normal", label: "lzma2/normal（平衡）" },
          { value: "lzma2/fast", label: "lzma2/fast（最快，适合联调）" },
          { value: "lzma/max", label: "lzma/max（旧版 LZMA）" },
          { value: "lzma/normal", label: "lzma/normal" },
          { value: "lzma/fast", label: "lzma/fast" },
          { value: "zip", label: "zip（解压最快，兼容性最好）" },
          { value: "bzip", label: "bzip（居中）" },
          { value: "none", label: "none（不压缩，体积最大）" },
        ],
        writes: "Compression=",
      },
      {
        key: "solidCompression",
        kind: "bool",
        label: "固实压缩",
        hint: "把多个文件放在一起联合压缩，压缩率更高；文件很多时编译明显变慢。不压缩时该项无效。",
        def: true,
        writes: "SolidCompression=yes",
      },
      {
        key: "lzmaDictionarySize",
        kind: "number",
        label: "字典大小",
        hint: "单位 KB。0 表示不写这一行、交给 Inno 按压缩等级自动决定（推荐：max 档它会用 8192）。有效范围 4–3932160（64 位编译器；32 位编译器只到 131072），低于 4 的值会被 ISCC 拒绝，所以不写入。注意 LZMA2 只支持特定档位，其它值会被向上取整。调大能提高压缩率，但编译时内存消耗成倍上升：max 档 8MB 字典约需 98MB 内存。",
        def: 0,
        min: 0,
        // 上限必须与 `defaults.rs::LZMA_DICT_MAX_KB` 一致（官方 64 位编译器上限）
        max: 3932160,
        unit: "KB",
        when: { key: "compression", in: ["lzma2/max", "lzma2/normal", "lzma2/fast", "lzma/max", "lzma/normal", "lzma/fast"] },
        writes: "LZMADictionarySize=",
      },
      {
        key: "lzmaNumBlockThreads",
        kind: "number",
        label: "并行压缩线程",
        hint: "0 表示不写这一行，Inno 用它自己的默认值 1。官方范围 1–256。LZMA2 可以把大文件切成块并行压缩，加快编译；切块会略微降低压缩率，且每个块线程理想上需要两个处理器核心。",
        def: 0,
        min: 0,
        max: 256,
        when: { key: "compression", in: ["lzma2/max", "lzma2/normal", "lzma2/fast"] },
        writes: "LZMANumBlockThreads=",
      },
      {
        key: "lzmaMatchFinder",
        kind: "enum",
        label: "匹配器",
        hint: "BT（二叉树）压缩率更高但更吃内存；HC（哈希链）省内存、略快。Inno 在 fast 档默认用 HC，其余用 BT。",
        def: "bt",
        when: { key: "compression", in: ["lzma2/max", "lzma2/normal", "lzma2/fast", "lzma/max", "lzma/normal", "lzma/fast"] },
        choices: [
          { value: "bt", label: "BT（压缩率更高）" },
          { value: "hc", label: "HC（省内存）" },
        ],
        writes: "LZMAMatchFinder=",
      },
      {
        key: "lzmaUseSeparateProcess",
        kind: "bool",
        label: "压缩放到独立进程",
        hint: "32 位编译器在用了大字典 + 多线程后报「内存不足」时打开它。64 位编译器一般不需要。",
        def: false,
        when: { key: "compression", in: ["lzma2/max", "lzma2/normal", "lzma2/fast", "lzma/max", "lzma/normal", "lzma/fast"] },
        writes: "LZMAUseSeparateProcess=yes",
      },
    ],
  },
  {
    id: "mode",
    title: "打包模式",
    note: "决定产出的是「一个安装程序」「一个免安装包」还是「一组分卷」。",
    fields: [
      {
        key: "packagingMode",
        kind: "enum",
        label: "打包模式",
        hint: "single 是标准安装程序；portable 不写注册表、不生成卸载程序、不建快捷方式，解压即用；multi_volume 把内容拆成 Setup-*.bin 分卷，压缩后超过 4.2GB 时 Inno 会强制要求。",
        def: "single",
        choices: [
          { value: "single", label: "单文件安装程序（默认）" },
          { value: "portable", label: "免安装绿色版" },
          { value: "multi_volume", label: "分卷（多张盘 / 超 4.2GB）" },
        ],
        writes: "DiskSpanning=",
      },
      {
        key: "diskSliceSize",
        kind: "number",
        label: "单片大小",
        hint: "单位字节。官方有效范围 262144–9223372036800000000（也接受字面量 max），低于下界的值不写入。留 0 表示用 Inno 默认的 2100000000（约 2GB）。刻 4.7GB DVD 可用 1566000000 配 3 片。",
        def: 0,
        min: 0,
        // 上限必须与 `defaults.rs::SLICE_MAX_BYTES` 一致（官方上限）
        max: 9223372036800000000,
        unit: "字节",
        when: { key: "packagingMode", in: ["multi_volume"] },
        writes: "DiskSliceSize=",
      },
      {
        key: "slicesPerDisk",
        kind: "number",
        label: "每张盘片数",
        hint: "官方范围 1–26，默认 1。大于 1 时文件命名为 Setup-xy.bin。",
        def: 1,
        min: 1,
        max: 26,
        when: { key: "packagingMode", in: ["multi_volume"] },
        writes: "SlicesPerDisk=",
      },
      {
        key: "requireAdmin",
        kind: "bool",
        label: "需要管理员权限",
        hint: "打开后装到 Program Files（安装时弹 UAC）；关闭则装到当前用户目录，全程不需要提权。",
        def: false,
        writes: "PrivilegesRequired=",
      },
      {
        key: "wizardStyle",
        kind: "enum",
        label: "安装向导样式",
        hint: "modern 是 Inno 6 的新式向导（推荐）；classic 是旧版经典样式（Inno 自己的默认）。官方还支持 dark / dynamic 等外观模式与 polar / slate 等风格，本工具只暴露这两档基础样式，需要时可在高级区改模板。",
        def: "modern",
        choices: [
          { value: "modern", label: "modern（新式，推荐）" },
          { value: "classic", label: "classic（经典）" },
        ],
        writes: "WizardStyle=",
      },
    ],
  },
  {
    id: "crypto",
    title: "安装包加密与签名",
    note: "加密用 XChaCha20 对称加密，密钥由口令经 PBKDF2-HMAC-SHA256 派生；签名用 Authenticode 证书，属于非对称加密。",
    fields: [
      {
        key: "encryption",
        kind: "enum",
        label: "安装包加密",
        hint: "yes 只加密文件内容，安装时弹框输入口令；full 连安装界面一起加密，因此运行时没有输入框可用，必须用「安装包.exe /PASSWORD=口令」启动；no 不加密。口令取自工程设置里的「安装包密码」。Inno 自己的默认是 no，SealPack 默认选 yes。",
        def: "yes",
        choices: [
          { value: "no", label: "no（不加密）" },
          { value: "yes", label: "yes（加密文件内容；SealPack 默认）" },
          { value: "full", label: "full（整包加密，需命令行给口令）" },
        ],
        writes: "Encryption=",
      },
      {
        key: "kdfIterations",
        kind: "number",
        label: "密钥派生迭代次数",
        hint: "PBKDF2-HMAC-SHA256 的迭代次数。越高越难暴力破解口令，但安装时校验口令也越慢。220000 是 Inno 的默认值。",
        def: 220000,
        min: 1,
        max: 2147483647,
        unit: "次",
        when: { key: "encryption", in: ["yes", "full"] },
        writes: "EncryptionKeyDerivation=pbkdf2/",
      },
      {
        key: "signTool",
        kind: "text",
        label: "代码签名工具名",
        hint: "填 Inno 编译器里配置好的 SignTool 名称（如 signtool），留空则不签名。签名让 Windows 不再弹「未知发布者」，也是非对称加密的典型用法。",
        def: "",
        writes: "SignTool=",
      },
      {
        key: "signedUninstaller",
        kind: "bool",
        label: "连卸载程序一起签名",
        hint: "需要先配好签名工具。打开后卸载程序也带签名，避免卸载时被拦。",
        def: false,
        when: { key: "signTool", in: [""], negate: true },
      },
    ],
  },
  {
    id: "behaviour",
    title: "安装行为",
    note: "安装向导里给用户看什么、装完做什么。",
    fields: [
      {
        key: "appId",
        kind: "text",
        label: "应用标识（AppId）",
        hint: "决定「重新打包后是覆盖升级还是全新安装」：Inno 靠它认出一个应用之前装过没有，它变了就会被当成另一个应用、两个版本并存。默认由主程序的产品身份（版本信息里的产品名 + 公司名 + 原始文件名）推导，同一份主程序重新编译、重新打包都会得到同一个值。换了产品名或公司名就会变 —— 那本来就该当成另一个应用。改动这一项会让已装版本被当成另一个应用。",
        def: "",
        placeholder: "选好主程序后自动推导，也可手工填写",
        writes: "AppId=",
      },
      {
        key: "desktopIcon",
        kind: "bool",
        label: "桌面快捷方式",
        hint: "在向导里提供一个「创建桌面图标」的勾选项（默认不勾）。绿色版模式下该项无效。",
        def: true,
        when: { key: "packagingMode", in: ["single", "multi_volume"] },
        writes: "[Tasks] / [Icons]",
      },
      {
        key: "runAfterInstall",
        kind: "bool",
        label: "安装完成后运行",
        hint: "安装结束时提供「立即运行」选项。绿色版模式下该项无效。",
        def: true,
        when: { key: "packagingMode", in: ["single", "multi_volume"] },
        writes: "[Run]",
      },
      {
        key: "uninstallable",
        kind: "bool",
        label: "生成卸载程序",
        hint: "关闭后「应用和功能」里不会出现本程序，也无法常规卸载。绿色版模式固定不生成。",
        def: true,
        when: { key: "packagingMode", in: ["single", "multi_volume"] },
        writes: "Uninstallable=",
      },
    ],
  },
  {
    id: "integrity",
    title: "完整性校验（哈希）",
    note: "打包完成后，给产出文件算一份摘要清单，用户下载后可以自行核对 —— 这是「哈希」在发布环节最实用的落点。",
    fields: [
      {
        key: "checksum",
        kind: "enum",
        label: "产出校验清单",
        hint: "打包完成后在输出目录生成 checksums-<算法>.txt。SHA-256 是现在的通行选择；SHA-1 / MD5 只在与旧系统对接时才用（两者都已被证明可构造碰撞）。",
        def: "none",
        choices: [
          { value: "none", label: "不生成" },
          { value: "sha256", label: "SHA-256（推荐）" },
          { value: "sha1", label: "SHA-1（兼容旧系统）" },
          { value: "md5", label: "MD5（仅兼容旧系统）" },
        ],
        writes: "checksums-<算法>.txt",
      },
    ],
  },
];


export interface Project {
  id: string;
  name: string;
  rootPath: string;
  exeFile: string;
  outputDir: string;
  password: string;
  version: string;
  mergeDlls: string[];
  /** 用户额外指定、不参与打包的条目（相对路径或通配符） */
  excludePaths: string[];
  encryptOptions: EncryptOptions;
  packageOptions: PackageOptions;
  encryptConfig: string;
  packageScript: string;
}

/** 打包排除项预览：自动带入的 / 你添加的 / 最终写进 Inno Excludes 的字符串 */
export interface IgnorePreview {
  auto: string[];
  custom: string[];
  combined: string;
}

export interface StageOutcome {
  stage: Stage;
  status: "ok" | "skipped" | "failed";
  exitCode: number | null;
  message: string;
  artifacts: string[];
}

export interface LogEvent {
  stage: Stage;
  stream: "system" | "stdout" | "stderr";
  line: string;
}

export interface StageEvent {
  stage: Stage;
  status: StageStatus;
  message: string;
}

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
  /**
   * 该目录树因超出扫描预算（项数 / 深度）而被截断。
   * 界面据此提示「只扫了一部分」，否则用户会以为目录里真的没有那些文件。
   */
  truncated?: boolean;
}

/** 工程列表：解析失败的工程文件单独报出来，避免「工程凭空消失」而无任何解释。 */
export interface ProjectList {
  projects: Project[];
  /** 读不出来的工程文件名（含扩展名，不含路径） */
  unreadable: string[];
}

/** 一个工具的自动下载来源说明（版本、体积、来源名都由 Rust 侧声明给出） */
export interface ToolDownloadInfo {
  version: string;
  /** 期望字节数 */
  size: number;
  /** 来源名，如「NuGet 官方源」 */
  origin: string;
  /** 适用场景与前置条件 */
  note: string;
  /** 是否已在本地下载缓存里命中（命中则重新下载会跳过网络） */
  cached: boolean;
  /** 本机已装的一份（只在该工具存在标准安装位置时才给）。
   *  填进路径框就能用它，省掉一次下载，也免掉安装所需的授权。 */
  systemPath: string | null;
}

/** 生效路径的来源 */
export type ToolOrigin = "custom" | "bundled" | "downloaded";

export interface ToolInfo {
  key: string;
  label: string;
  /** 实际生效的路径 */
  path: string;
  /** 应用内置的默认路径（随应用分发，装到 Program Files 时不可写） */
  defaultPath: string;
  available: boolean;
  /** 是否使用了用户自定义路径 */
  overridden: boolean;
  /** 是否需要 .NET Framework 运行时 */
  needsDotnet: boolean;
  origin: ToolOrigin;
  /** 没有配置下载来源时为 null */
  download: ToolDownloadInfo | null;
}

export interface ToolStatus {
  /** 应用内置的工具目录 */
  toolsDir: string;
  /** 自动下载的落点目录（用户级，始终可写） */
  downloadDir: string;
  items: ToolInfo[];
}

/** 工具下载进度事件（`total === 0` 表示进度未知） */
export interface ToolProgress {
  key: string;
  phase: "download" | "verify" | "extract" | "install" | "done";
  received: number;
  total: number;
  message: string;
}

/** 全局设置：三个外部工具的自定义路径，留空表示使用内置工具 */
export interface Settings {
  ilmergePath: string;
  confuserPath: string;
  isccPath: string;
}

export interface RuntimeStatus {
  dotnetAvailable: boolean;
  dotnetRelease: number | null;
  dotnetVersion: string | null;
  dotnetDisplay: string;
}

export const STAGE_META: Record<
  Stage,
  { index: number; title: string; action: string; hint: string; tool: string }
> = {
  merge: {
    index: 1,
    title: "程序合并",
    action: "执行合并",
    hint: "把多个程序集合并进主程序，减少分发文件",
    tool: "ILMerge",
  },
  encrypt: {
    index: 2,
    title: "程序加密",
    action: "执行加密",
    hint: "使用混淆与压缩保护主程序，提升反编译成本",
    tool: "ConfuserEx",
  },
  package: {
    index: 3,
    title: "安装包打包",
    action: "执行打包",
    hint: "按脚本生成带密码保护的安装程序",
    tool: "Inno Setup",
  },
};

/**
 * 向导步骤。
 *
 * 之所以把「主程序」单独作为第一步：它是后面所有步骤的前置条件
 * （合并要知道合并进谁、打包要知道打包谁、加密要知道加密谁），
 * 放在最前面可以让后面的每一步都少一个「还没设置」的空状态。
 */
export const STEP_META: Record<StepId, { index: number; title: string; hint: string }> = {
  setup: { index: 1, title: "主程序", hint: "选择要处理的主程序与输出位置" },
  merge: { index: 2, title: "合并", hint: "勾选要合并进主程序的程序集（可跳过）" },
  encrypt: { index: 3, title: "加密", hint: "选择保护强度（可跳过）" },
  package: { index: 4, title: "打包", hint: "确认排除项与安装包选项" },
  run: { index: 5, title: "执行", hint: "按顺序完成上述步骤" },
};

/** 向导步骤顺序，与 STEP_META 的 index 一致 */
export const STEP_ORDER: StepId[] = ["setup", "merge", "encrypt", "package", "run"];
