use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 三个核心能力：合并 / 加密 / 打包
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Merge,
    Encrypt,
    Package,
}

impl Stage {
    pub fn label(self) -> &'static str {
        match self {
            Stage::Merge => "程序合并",
            Stage::Encrypt => "程序加密",
            Stage::Package => "安装包打包",
        }
    }
}

/// 一个工程的完整配置。持久化为 `<id>.json`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// 主程序所在目录
    pub root_path: String,
    /// 主程序完整路径（.exe）
    pub exe_file: String,
    /// 安装包输出目录
    pub output_dir: String,
    /// 安装包密码，可为空
    pub password: String,
    /// 版本号
    pub version: String,
    /// 待合并进主程序的程序集
    pub merge_dlls: Vec<String>,
    /// 用户额外指定、**不参与打包**的条目。
    /// 每一项既可以是相对 root 的路径，也可以是 Inno 支持的通配符（如 `*.pdb`、`docs\*`）。
    /// 之所以单独存一份，是因为原实现只能靠手改 .iss 模板里的 `${ignore}` 才能排除文件。
    pub exclude_paths: Vec<String>,
    /// 加密选项（界面上的开关）。`generated` 为 true 时 `encrypt_config` 由它生成。
    pub encrypt_options: EncryptOptions,
    /// 打包选项。`generated` 为 true 时 `package_script` 由它生成。
    pub package_options: PackageOptions,
    /// ConfuserEx 加密配置（.crproj 内容）
    pub encrypt_config: String,
    /// Inno Setup 打包脚本（.iss 内容）
    pub package_script: String,
}

/// 加密选项：把「要不要某种保护」变成开关 + 参数，用户不必理解 ConfuserEx 的
/// rule / preset / protection 语法。
///
/// 字段按「加密算法的三个族」组织，界面上也是这么分组的：
///
/// * **对称加密** —— `constants`（AES 编码常量）、`resources`（AES 编码资源）、
///   `anti_tamper`（用整模块校验和派生的密钥加密方法体，校验和本身即哈希）。
/// * **非对称加密** —— `sn_key_path` / `sn_key_pass`：用 RSA 强名称密钥签名程序集，
///   公钥内嵌、私钥签名，运行时可验签。
/// * **哈希** —— `anti_tamper` 的整模块校验和、`rename_mode = reversible` 的口令派生，
///   以及打包侧的 PBKDF2-HMAC-SHA256 与产出校验清单。
///
/// `generated == false` 表示用户在高级区手工改过模板，此时以 `encrypt_config` 为准，
/// 选项只作展示 —— 避免「切一下开关就把手写的规则冲掉」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptOptions {
    /// 保护预设：none | minimum | normal | aggressive | maximum。
    /// 写进 `<rule preset="...">`；显式列出的 protection 会覆盖预设里的对应项。
    pub preset: String,

    // ---------------- 反编译与防篡改 ----------------
    /// 防反汇编：阻止 ILDASM / 反编译工具打开程序集
    pub anti_ildasm: bool,
    /// 防转储：阻止从内存中 dump 出程序集（依赖 WinAPI，仅 Windows）
    pub anti_dump: bool,
    /// 反篡改：用整模块校验和加密方法体，被修改后无法加载
    pub anti_tamper: bool,
    /// 反篡改模式：normal（启动时校验一次）| jit（每次 JIT 前校验，兼容性差）
    pub tamper_mode: String,
    /// 反篡改的密钥派生方式：normal（静态算法）| dynamic（动态生成算法）
    pub tamper_key: String,
    /// 反调试：检测调试器 / 分析器
    pub anti_debug: bool,
    /// 反调试引擎：safe（托管 API，兼容性最好）| win32（WinAPI）| antinet
    pub debug_mode: String,
    /// 无效元数据：写入畸形元数据，让反编译器的解析直接出错
    pub invalid_metadata: bool,
    /// 强化：加固其它保护自身的运行时，显著提高「脱壳」成本
    pub harden: bool,

    // ---------------- 代码混淆 ----------------
    /// 重命名符号（最有效的反编译阻碍，但对反射密集的程序需谨慎）
    pub rename: bool,
    /// 重命名模式：unicode | letters | sequential | decodable | reversible | retain
    pub rename_mode: String,
    /// reversible 模式下用于还原符号名的口令
    pub rename_password: String,
    /// 是否连方法参数名一起重命名
    pub rename_args: bool,
    /// 是否重命名枚举成员
    pub ren_enum: bool,
    /// 是否重命名对外可见（public）的成员 —— 供外部调用的库不要开
    pub ren_public: bool,
    /// 控制流混淆
    pub control_flow: bool,
    /// 控制流方式：switch（状态机重排）| jump（花指令跳转，不可验证）
    pub cf_type: String,
    /// 状态变量的存放方式：normal（直接用）| expression（动态表达式编码）| x86（原生表达式，破坏 AnyCPU）
    pub cf_predicate: String,
    /// 控制流强度 0..100：越小切得越碎、越难读，也越慢
    pub cf_intensity: u32,
    /// 控制流谓词深度（predicate 为 expression / x86 时生效）
    pub cf_depth: u32,
    /// 是否插入垃圾代码（不可验证，且明显增大体积）
    pub cf_junk: bool,
    /// 引用代理：把字段/方法引用改写成间接调用
    pub ref_proxy: bool,
    /// 引用代理模式：mild（间接方法）| strong（动态委托）
    pub ref_mode: String,
    /// 是否连程序集内部的调用也代理（更慢，更强）
    pub ref_internal: bool,

    // ---------------- 数据加密（对称） ----------------
    /// 常量加密：把字符串与数字常量加密，运行时解码
    pub constants: bool,
    /// 常量编码方式：normal | dynamic | x86（x86 会破坏 AnyCPU）
    pub const_mode: String,
    /// 加密哪些常量：S 字符串 / N 数字 / P 常用值 / I 数组初始化器，可组合（如 SNI）
    pub const_elements: String,
    /// 解码是否依赖控制流状态（更强，但更慢）
    pub const_cfg: bool,
    /// 资源加密：把内嵌资源编码后存放
    pub resources: bool,
    /// 资源编码方式：normal | dynamic
    pub res_mode: String,

    // ---------------- 打包与复现 ----------------
    /// 压缩器：体积更小，加载稍慢
    pub compress: bool,
    /// 随机种子：填了就得到可复现的构建产物，留空则每次随机
    pub seed: String,
    /// 是否生成调试符号（.pdb）
    pub debug_symbols: bool,

    // ---------------- 签名（非对称） ----------------
    /// 强名称密钥（.snk 或 .pfx）：用 RSA 私钥签名程序集，防止被替换
    pub sn_key_path: String,
    /// .pfx 容器的口令
    pub sn_key_pass: String,
    pub generated: bool,
}

impl Default for EncryptOptions {
    fn default() -> Self {
        // 默认只开压缩器，与改造前的行为一致。
        // 不默认开「重命名符号」—— 它对使用反射 / 动态加载的程序可能造成破坏，
        // 需要用户明确同意；界面里会把它标为推荐项，并由「标准」预设一键打开。
        Self {
            preset: preset_normal(),
            anti_ildasm: false,
            anti_dump: false,
            anti_tamper: false,
            tamper_mode: tamper_mode_default(),
            tamper_key: tamper_key_default(),
            anti_debug: false,
            debug_mode: debug_mode_default(),
            invalid_metadata: false,
            harden: false,
            rename: false,
            rename_mode: rename_mode_default(),
            rename_password: String::new(),
            rename_args: true,
            ren_enum: false,
            ren_public: false,
            control_flow: false,
            cf_type: cf_type_default(),
            cf_predicate: cf_predicate_default(),
            cf_intensity: cf_intensity_default(),
            cf_depth: cf_depth_default(),
            cf_junk: false,
            ref_proxy: false,
            ref_mode: ref_mode_default(),
            ref_internal: false,
            constants: false,
            const_mode: const_mode_default(),
            const_elements: const_elements_default(),
            const_cfg: false,
            resources: false,
            res_mode: res_mode_default(),
            compress: true,
            seed: String::new(),
            debug_symbols: false,
            sn_key_path: String::new(),
            sn_key_pass: String::new(),
            generated: true,
        }
    }
}

/// 打包选项：对应 .iss 里的 [Setup] / [Tasks] / [Icons] / [Run] 段落。
///
/// 字段同样按算法族组织：
///
/// * **压缩格式** —— `compression` 是「算法 + 等级」的组合值（Inno 的原生写法，
///   如 `lzma2/max`），再用 `lzma_*` 微调字典、线程、匹配器。
/// * **对称加密** —— `encryption`（XChaCha20，256 位密钥由口令派生）+ `kdf_iterations`。
/// * **非对称加密** —— `sign_tool`：用 Authenticode 代码签名证书（RSA/ECDSA）签名安装包。
/// * **哈希** —— `kdf_iterations` 对应的 PBKDF2-HMAC-SHA256，以及 `checksum` 产出校验清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageOptions {
    /// 压缩格式（含等级）：lzma2/max | lzma2/normal | lzma2/fast | lzma | zip | bzip | none
    pub compression: String,
    /// 固实压缩：跨文件联合压缩，压缩率更高、编译更慢
    pub solid_compression: bool,
    /// LZMA 字典大小（KB）。0 表示交给 Inno 按压缩等级自动决定
    pub lzma_dictionary_size: u32,
    /// LZMA2 并行压缩块线程数。0 表示自动
    pub lzma_num_block_threads: u32,
    /// 匹配器：bt（压缩率更高、更吃内存）| hc（省内存、略快）
    pub lzma_match_finder: String,
    /// 把压缩放到独立进程：32 位编译器使用大字典时的必需项
    pub lzma_use_separate_process: bool,

    /// 打包模式：single（单文件安装程序）| portable（免安装绿色版）| multi_volume（分卷）
    pub packaging_mode: String,
    /// 分卷单片大小（字节）。0 表示交给 Inno 自动决定
    pub disk_slice_size: u64,
    /// 每张盘放几片
    pub slices_per_disk: u32,

    /// 安装包加密：no | yes（加密 [Files] 内容）| full（整个安装包加密，必须命令行给口令）
    pub encryption: String,
    /// PBKDF2-HMAC-SHA256 的迭代次数（口令派生密钥用）
    pub kdf_iterations: u32,

    /// 代码签名工具名（Inno 的 SignTool 标识），留空则不签名
    pub sign_tool: String,
    /// 卸载程序也一起签名（需要签名工具已配置）
    pub signed_uninstaller: bool,

    /// 在安装向导里提供「创建桌面快捷方式」选项
    pub desktop_icon: bool,
    /// 安装完成后启动程序
    pub run_after_install: bool,
    /// 需要管理员权限（默认 lowest，装到用户目录，不需要 UAC）
    pub require_admin: bool,
    /// 是否生成卸载程序
    pub uninstallable: bool,
    /// 安装向导样式：modern | classic
    pub wizard_style: String,

    /// 产出校验清单的哈希算法：none | sha256 | sha1 | md5
    pub checksum: String,
    pub generated: bool,
}

impl Default for PackageOptions {
    fn default() -> Self {
        Self {
            // lzma2/max 是 Inno Setup 自己的默认值，压缩率最好，所以作为本工具的默认。
            compression: compression_default(),
            solid_compression: true,
            lzma_dictionary_size: 0,
            lzma_num_block_threads: 0,
            lzma_match_finder: match_finder_default(),
            lzma_use_separate_process: false,
            packaging_mode: packaging_mode_default(),
            disk_slice_size: 0,
            slices_per_disk: 1,
            encryption: encryption_default(),
            kdf_iterations: kdf_iterations_default(),
            sign_tool: String::new(),
            signed_uninstaller: false,
            desktop_icon: true,
            run_after_install: true,
            require_admin: false,
            uninstallable: true,
            wizard_style: wizard_style_default(),
            checksum: checksum_default(),
            generated: true,
        }
    }
}

impl EncryptOptions {
    /// 被启用的 protection，按输出顺序 —— 界面摘要与模板共用同一份顺序。
    pub fn enabled_protections(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.anti_ildasm {
            out.push("anti ildasm");
        }
        if self.anti_debug {
            out.push("anti debug");
        }
        if self.anti_dump {
            out.push("anti dump");
        }
        if self.anti_tamper {
            out.push("anti tamper");
        }
        if self.constants {
            out.push("constants");
        }
        if self.control_flow {
            out.push("ctrl flow");
        }
        if self.invalid_metadata {
            out.push("invalid metadata");
        }
        if self.rename {
            out.push("rename");
        }
        if self.harden {
            out.push("harden");
        }
        if self.ref_proxy {
            out.push("ref proxy");
        }
        if self.resources {
            out.push("resources");
        }
        out
    }
}

// ---------------------------------------------------------------- 默认值
//
// 每个非平凡默认值都用一个具名函数表达，`Default` 实现从这里取值 ——
// 「默认是多少」因此只有一处定义，`src/types.ts` 里界面标注的 `def` 也据此核对。
//
// 这些字段没有 serde 的 `default`：工程 JSON 由本程序完整写出，
// 缺字段说明文件被改坏了，应当报错而不是悄悄补一个默认值。

fn preset_normal() -> String {
    "normal".into()
}

fn rename_mode_default() -> String {
    "unicode".into()
}

fn cf_type_default() -> String {
    "switch".into()
}

fn cf_predicate_default() -> String {
    "normal".into()
}

fn cf_intensity_default() -> u32 {
    60
}

fn cf_depth_default() -> u32 {
    4
}

fn ref_mode_default() -> String {
    "mild".into()
}

fn const_mode_default() -> String {
    "normal".into()
}

fn const_elements_default() -> String {
    "SI".into()
}

fn res_mode_default() -> String {
    "normal".into()
}

fn debug_mode_default() -> String {
    "safe".into()
}

fn tamper_mode_default() -> String {
    "normal".into()
}

fn tamper_key_default() -> String {
    "normal".into()
}

fn compression_default() -> String {
    "lzma2/max".into()
}

fn match_finder_default() -> String {
    "bt".into()
}

fn packaging_mode_default() -> String {
    "single".into()
}

fn encryption_default() -> String {
    "yes".into()
}

fn kdf_iterations_default() -> u32 {
    220_000
}

fn wizard_style_default() -> String {
    "modern".into()
}

fn checksum_default() -> String {
    "none".into()
}

impl Project {
    /// 主程序文件名，含扩展名
    pub fn exe_name(&self) -> String {
        Path::new(&self.exe_file)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    /// 主程序文件名，不含扩展名
    pub fn exe_stem(&self) -> String {
        Path::new(&self.exe_file)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    /// 主程序备份路径：`<主程序名>.bakup`
    pub fn backup_path(&self) -> PathBuf {
        Path::new(&self.root_path).join(format!("{}.bakup", self.exe_stem()))
    }

    /// 由前两步**自动**得出的排除项：待合并的程序集 + 主程序备份。
    /// 界面上这些以只读形式展示，让用户知道「为什么这些文件没进安装包」。
    pub fn auto_ignores(&self) -> Vec<String> {
        let mut items: Vec<String> = self
            .merge_dlls
            .iter()
            .map(|d| relative_to(&self.root_path, d))
            .collect();
        items.push(format!("{}.bakup", self.exe_stem()));
        items
    }

    /// 用户手工添加的排除项，去掉空白项。
    pub fn custom_ignores(&self) -> Vec<String> {
        self.exclude_paths
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    /// 最终传给 Inno `Excludes` 的字符串（自动项 + 自定义项，去重且保持顺序）。
    pub fn ignore_list(&self) -> String {
        let mut items = self.auto_ignores();
        items.extend(self.custom_ignores());

        let mut seen = std::collections::HashSet::new();
        items.retain(|item| seen.insert(item.to_lowercase()));
        items.join(",")
    }
}

/// 把 `full` 转成相对 `root` 的路径，失败时原样返回。
///
/// 与前端 `src/util.ts` 的 `relativeTo` 必须同义：
///   · 分隔符统一成 `\` —— Inno 的 `Excludes` 用的是 Windows 写法；
///   · 大小写不敏感 —— `Path::strip_prefix` 是逐字节比较的，在 Windows 上
///     `d:\app\x.dll` 会被判成「不在 `D:\App` 之下」，于是 `Excludes` 里写进
///     一条绝对路径、永远匹配不上，等于没排除。
pub fn relative_to(root: &str, full: &str) -> String {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_string();
    let root = norm(root);
    let full = norm(full);

    if !root.is_empty() {
        let prefix = format!("{root}\\");
        // `get(..n)` 在非字符边界上返回 None，所以这里不会 panic
        if let Some(head) = full.get(..prefix.len()) {
            if head.eq_ignore_ascii_case(&prefix) {
                return full[prefix.len()..].to_string();
            }
        }
    }
    full
}

/// 打包排除项的预览：界面要能分别显示「自动带入的」与「你添加的」，
/// 并让用户看到最终写进 Inno `Excludes` 的字符串长什么样。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnorePreview {
    /// 由前两步自动得出：待合并的程序集 + 主程序备份
    pub auto: Vec<String>,
    /// 用户手工添加的
    pub custom: Vec<String>,
    /// 最终传给 Inno `Excludes` 的值
    pub combined: String,
}

/// 单个阶段的执行结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOutcome {
    pub stage: Stage,
    /// ok | skipped | failed
    pub status: String,
    pub exit_code: Option<i32>,
    pub message: String,
    /// 产出文件
    pub artifacts: Vec<String>,
}

impl StageOutcome {
    pub fn ok(stage: Stage, message: impl Into<String>, artifacts: Vec<String>) -> Self {
        Self {
            stage,
            status: "ok".into(),
            exit_code: Some(0),
            message: message.into(),
            artifacts,
        }
    }

    pub fn skipped(stage: Stage, message: impl Into<String>) -> Self {
        Self {
            stage,
            status: "skipped".into(),
            exit_code: None,
            message: message.into(),
            artifacts: vec![],
        }
    }

    pub fn failed(stage: Stage, exit_code: Option<i32>, message: impl Into<String>) -> Self {
        Self {
            stage,
            status: "failed".into(),
            exit_code,
            message: message.into(),
            artifacts: vec![],
        }
    }
}

/// 推送给前端的日志行
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub stage: Stage,
    /// system | stdout | stderr
    pub stream: String,
    pub line: String,
}

/// 推送给前端的阶段状态变化
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageEvent {
    pub stage: Stage,
    /// running | ok | skipped | failed
    pub status: String,
    pub message: String,
}

/// 目录树节点
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
    /// 该子树因超出扫描预算（项数 / 深度）而被截断。
    /// 界面据此提示「只扫了一部分」，否则用户会以为目录里真的没有那些文件。
    pub truncated: bool,
}

/// 工程列表。
///
/// 解析失败的工程文件单独报出来：早先是静默跳过，用户会以为「工程凭空消失」，
/// 而文件其实还躺在磁盘上。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectList {
    pub projects: Vec<Project>,
    /// 读不出来的工程文件名（含扩展名，不含路径）
    pub unreadable: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Excludes` 里必须写相对路径，否则永远匹配不上。
    /// 关键在大小写：Windows 上 `D:\App` 与 `d:\app` 是同一个目录。
    #[test]
    fn relative_to_ignores_case_and_normalizes_separators() {
        assert_eq!(relative_to(r"D:\App", r"D:\App\lib.dll"), r"lib.dll");
        assert_eq!(relative_to(r"D:\App", r"d:\app\lib.dll"), r"lib.dll");
        assert_eq!(relative_to(r"d:\app", r"D:\APP\sub\x.dll"), r"sub\x.dll");
        // 正斜杠也要能对上（用户手改 JSON 时可能写成 /）
        assert_eq!(relative_to(r"D:\App", "D:/App/lib.dll"), r"lib.dll");
        // 尾部分隔符不该影响结果
        assert_eq!(relative_to(r"D:\App\", r"D:\App\lib.dll"), r"lib.dll");
    }

    #[test]
    fn relative_to_keeps_foreign_paths_intact() {
        // 不在 root 下：原样返回（不猜、不裁剪）
        assert_eq!(
            relative_to(r"D:\App", r"E:\Other\lib.dll"),
            r"E:\Other\lib.dll"
        );
        // 前缀相同但不是子目录：`D:\AppExtra` 不是 `D:\App` 的子目录
        assert_eq!(
            relative_to(r"D:\App", r"D:\AppExtra\lib.dll"),
            r"D:\AppExtra\lib.dll"
        );
        // root 为空时不做任何处理
        assert_eq!(relative_to("", r"D:\App\lib.dll"), r"D:\App\lib.dll");
        // 路径本身就是 root：没有相对形式，原样返回
        assert_eq!(relative_to(r"D:\App", r"D:\App"), r"D:\App");
    }

    /// 多字节路径不能因为切片越界而 panic（`get(..n)` 守住了字符边界）
    #[test]
    fn relative_to_handles_non_ascii_paths() {
        assert_eq!(relative_to(r"D:\程序", r"D:\程序\库.dll"), r"库.dll");
        assert_eq!(
            relative_to(r"D:\程序", r"D:\其他\库.dll"),
            r"D:\其他\库.dll"
        );
    }

    /// 自动排除项 = 待合并程序集（相对化）+ 主程序备份
    #[test]
    fn auto_ignores_are_relative_and_deduplicated() {
        let mut project = Project {
            id: "x".into(),
            name: "t".into(),
            root_path: r"D:\App".into(),
            exe_file: r"D:\App\t.exe".into(),
            output_dir: r"D:\Out".into(),
            password: String::new(),
            version: String::new(),
            merge_dlls: vec![r"D:\App\a.dll".into(), r"d:\app\b.dll".into()],
            exclude_paths: vec!["  a.dll  ".into(), "".into(), "b.dll".into()],
            encrypt_options: EncryptOptions::default(),
            package_options: PackageOptions::default(),
            encrypt_config: String::new(),
            package_script: String::new(),
        };
        assert_eq!(project.auto_ignores(), vec!["a.dll", "b.dll", "t.bakup"]);
        // 自定义项去空白，并与自动项按小写去重
        assert_eq!(project.custom_ignores(), vec!["a.dll", "b.dll"]);
        assert_eq!(project.ignore_list(), "a.dll,b.dll,t.bakup");

        project.merge_dlls.clear();
        project.exclude_paths.clear();
        assert_eq!(project.ignore_list(), "t.bakup");
    }
}

/// 一个工具的自动下载来源说明。
///
/// 版本、体积、来源名都来自 Rust 侧的声明，界面只负责展示 ——
/// 这样「下载按钮旁边写的是什么」和「实际会下载什么」不可能对不上。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDownloadInfo {
    pub version: String,
    /// 期望字节数，由界面换算成人类可读的体积
    pub size: u64,
    /// 来源名（如「NuGet 官方源」）
    pub origin: String,
    /// 适用场景与前置条件
    pub note: String,
    /// 是否已经在下载目录里命中过缓存
    pub cached: bool,
    /// 本机已装的一份（只在该工具存在标准安装位置时才给）。
    /// 填进路径框就能用它，省掉一次下载，也免掉安装所需的授权。
    pub system_path: Option<String>,
}

/// 外部工具的可用性
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub key: String,
    pub label: String,
    /// 实际生效的路径
    pub path: String,
    /// 应用内置的默认路径（随应用分发，安装到 Program Files 时不可写）
    pub default_path: String,
    pub available: bool,
    /// 是否使用了用户自定义路径
    pub overridden: bool,
    /// 是否需要 .NET Framework 运行时
    pub needs_dotnet: bool,
    /// 生效路径的来源：custom / bundled / downloaded
    pub origin: String,
    /// 自动下载的说明；None 表示该工具没有配置下载来源
    pub download: Option<ToolDownloadInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    /// 应用内置的工具目录
    pub tools_dir: String,
    /// 自动下载的落点目录（用户级，始终可写）
    pub download_dir: String,
    pub items: Vec<ToolInfo>,
}
