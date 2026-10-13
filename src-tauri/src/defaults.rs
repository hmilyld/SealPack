use crate::model::{EncryptOptions, PackageOptions};

// ---------------------------------------------------------------- 取值收敛

/// 把用户选的值收敛到白名单内。
///
/// 模板是拼字符串拼出来的，而这些值最终会落进 XML 属性 / Inno 指令里。
/// 界面上的下拉本来就只会给出合法值，但工程 JSON 是可以手改的（也确实是
/// 旧版本存下来的），所以这里再兜一道：不认识的值一律退回默认值，
/// 免得一个错字就让 ConfuserEx / ISCC 抛出一句看不懂的语法错误。
fn pick(value: &str, allowed: &[&str], fallback: &str) -> String {
    if allowed.iter().any(|a| a.eq_ignore_ascii_case(value)) {
        // 用白名单里的写法，而不是用户给的大小写（如 LZMAMatchFinder 要 BT / HC 大写）
        allowed
            .iter()
            .find(|a| a.eq_ignore_ascii_case(value))
            .map(|a| a.to_string())
            .unwrap_or_else(|| fallback.to_string())
    } else {
        fallback.to_string()
    }
}

/// XML 属性值转义。路径里出现 `&` 或 `"` 的概率不高，但一旦出现，
/// 整个 .crproj 就会变成无法解析的 XML，报错还很难懂。
fn xml_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 常量加密的 elements 参数：只保留 S / N / P / I，去重并保持顺序。
/// ConfuserEx 对这个值的容错很差，多一个字符就报参数错误。
fn normalize_elements(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.to_ascii_uppercase().chars() {
        if matches!(ch, 'S' | 'N' | 'P' | 'I') && !out.contains(ch) {
            out.push(ch);
        }
    }
    // P 必须与 S 或 N 同时出现才有意义，单独给 P 等于什么都没加密
    if out.is_empty() || out == "P" {
        return "SI".to_string();
    }
    out
}

// ---------------------------------------------------------------- 加密配置

const PRESETS: &[&str] = &["none", "minimum", "normal", "aggressive", "maximum"];
const RENAME_MODES: &[&str] = &[
    "unicode",
    "letters",
    "ascii",
    "sequential",
    "decodable",
    "reversible",
    "retain",
];
const CF_TYPES: &[&str] = &["switch", "jump"];
const CF_PREDICATES: &[&str] = &["normal", "expression", "x86"];
const CONST_MODES: &[&str] = &["normal", "dynamic", "x86"];
const RES_MODES: &[&str] = &["normal", "dynamic"];
const REF_MODES: &[&str] = &["mild", "strong"];
const DEBUG_MODES: &[&str] = &["safe", "win32", "antinet"];
const TAMPER_MODES: &[&str] = &["normal", "jit"];
const TAMPER_KEYS: &[&str] = &["normal", "dynamic"];

/// 某个 protection 需要写进配置的 `<argument>`。
///
/// 即使取值等于 ConfuserEx 自己的默认值也照样显式写出来 —— 这个工具的立场是
/// 「界面上的选项就是唯一事实源」，模板要能一眼看出每个开关产生了什么，
/// 而不是让人去猜哪些参数被省略了、省略后又是什么值。
fn protection_args(opts: &EncryptOptions, id: &str) -> Vec<(&'static str, String)> {
    match id {
        "anti debug" => vec![("mode", pick(&opts.debug_mode, DEBUG_MODES, "safe"))],

        "anti tamper" => vec![
            ("mode", pick(&opts.tamper_mode, TAMPER_MODES, "normal")),
            ("key", pick(&opts.tamper_key, TAMPER_KEYS, "normal")),
        ],

        "constants" => vec![
            ("mode", pick(&opts.const_mode, CONST_MODES, "normal")),
            ("elements", normalize_elements(&opts.const_elements)),
            ("cfg", opts.const_cfg.to_string()),
        ],

        "ctrl flow" => {
            let ty = pick(&opts.cf_type, CF_TYPES, "switch");
            let mut args: Vec<(&'static str, String)> = vec![("type", ty.clone())];
            // predicate 只在 switch 方式下有意义：jump 方式没有状态变量
            if ty == "switch" {
                let predicate = pick(&opts.cf_predicate, CF_PREDICATES, "normal");
                args.push(("predicate", predicate.clone()));
                // depth 只影响 expression / x86 这两种谓词
                if predicate != "normal" {
                    args.push(("depth", opts.cf_depth.clamp(1, 16).to_string()));
                }
            }
            args.push(("intensity", opts.cf_intensity.min(100).to_string()));
            args.push(("junk", opts.cf_junk.to_string()));
            args
        }

        "rename" => {
            let mode = pick(&opts.rename_mode, RENAME_MODES, "unicode");
            let mut args: Vec<(&'static str, String)> = vec![("mode", mode.clone())];
            // password 只在 reversible 模式下被 ConfuserEx 使用
            if mode == "reversible" && !opts.rename_password.is_empty() {
                args.push(("password", opts.rename_password.clone()));
            }
            args.push(("renameArgs", opts.rename_args.to_string()));
            args.push(("renEnum", opts.ren_enum.to_string()));
            args.push(("renPublic", opts.ren_public.to_string()));
            args
        }

        "ref proxy" => vec![
            ("mode", pick(&opts.ref_mode, REF_MODES, "mild")),
            ("internal", opts.ref_internal.to_string()),
        ],

        "resources" => vec![("mode", pick(&opts.res_mode, RES_MODES, "normal"))],

        // 防反汇编 / 防转储 / 无效元数据 / 强化：ConfuserEx 文档明确写了「无参数」
        _ => Vec::new(),
    }
}

/// 由界面上的选项生成 ConfuserEx 配置。
///
/// 存在的意义：绝大多数用户只需要「要不要这种保护、保护到什么程度」，
/// 不需要读 ConfuserEx 的 rule / preset / protection id 语法。
/// 把这一步从「改配置文本」变成「点开关」。
///
/// 注意 `snKey` / `snKeyPass` 是 `<module>` 的属性而不是 `<project>` 的 ——
/// 这一点看 ConfuserEx 的 ProjectFormat 文档才能确认，写错位置 ConfuserEx 会静默忽略。
pub fn encrypt_config(opts: &EncryptOptions) -> String {
    let preset = pick(&opts.preset, PRESETS, "normal");

    let mut out = String::new();
    out.push_str("<project outputDir=\"${root}\" baseDir=\"${root}\"");

    // seed 留空表示「每次都不一样」。填上就能得到可复现的构建产物，
    // 便于「同一个版本重新打包后二进制完全一致」这种校验。
    let seed = opts.seed.trim();
    if !seed.is_empty() {
        out.push_str(&format!(" seed=\"{}\"", xml_attr(seed)));
    }
    if opts.debug_symbols {
        out.push_str(" debug=\"true\"");
    }
    out.push_str(" xmlns=\"http://confuser.codeplex.com\">\n");

    let protections = opts.enabled_protections();
    if protections.is_empty() {
        out.push_str("\t<!-- 未启用任何 protection 规则，仅做打包 -->\n");
    } else {
        out.push_str(&format!(
            "\t<rule pattern=\"true\" preset=\"{preset}\" inherit=\"false\">\n"
        ));
        for id in protections {
            let args = protection_args(opts, id);
            if args.is_empty() {
                out.push_str(&format!("\t\t<protection id=\"{id}\" />\n"));
            } else {
                out.push_str(&format!("\t\t<protection id=\"{id}\">\n"));
                for (name, value) in args {
                    out.push_str(&format!(
                        "\t\t\t<argument name=\"{name}\" value=\"{}\" />\n",
                        xml_attr(&value)
                    ));
                }
                out.push_str("\t\t</protection>\n");
            }
        }
        out.push_str("\t</rule>\n");
    }

    if opts.compress {
        out.push_str("\t<packer id=\"compressor\" />\n");
    }

    // 强名称签名：RSA 私钥签名 + 公钥内嵌，属于非对称加密
    let sn_key = opts.sn_key_path.trim();
    out.push_str("\t<module path=\"${exe}\"");
    if !sn_key.is_empty() {
        out.push_str(&format!(" snKey=\"{}\"", xml_attr(sn_key)));
        let pass = opts.sn_key_pass.trim();
        if !pass.is_empty() {
            out.push_str(&format!(" snKeyPass=\"{}\"", xml_attr(pass)));
        }
    }
    out.push_str(" />\n");

    out.push_str("</project>\n");
    out
}

// ---------------------------------------------------------------- 打包脚本

/// Inno Setup 的 Compression 取值：算法 + 等级写成一个值。
///
/// 这是官方取值的一个**子集**：文档里还有 `lzma/ultra`、`lzma/ultra64`、
/// `lzma2/ultra`、`lzma2/ultra64` 与 `zip/1`–`zip/9`、`bzip/1`–`bzip/9`。
/// 之所以不列 ultra 档：它们的字典默认值分别是 32 MB / 64 MB，压缩时内存要
/// 374 MB / 742 MB，摆在界面上更像陷阱而不是选项。需要时可在高级区直接改模板。
const COMPRESSIONS: &[&str] = &[
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
const MATCH_FINDERS: &[&str] = &["BT", "HC"];
const PACKAGING_MODES: &[&str] = &["single", "portable", "multi_volume"];
const ENCRYPTIONS: &[&str] = &["no", "yes", "full"];
const WIZARD_STYLES: &[&str] = &["modern", "classic"];

// ---------------------------------------------------------------- Inno 的边界值
//
// 下面几个常量都抄自 Inno Setup 官方文档，改动前请先回去核对一遍
// （`https://jrsoftware.org/ishelp/`，topic_setup_*）。

/// `LZMADictionarySize` 的有效范围（KB）。
/// 官方：64 位编译器 `4`–`3932160`；32 位编译器默认只到 `131072`
/// （设了 `LZMAUseSeparateProcess` 且跑在 64 位 Windows 上时到 `1048576`）。
/// 低于 4 的值会被 ISCC 拒绝，所以判断下界用 4 而不是 0 —— 0 在本工具里是
/// 「不写这一行」的产品约定。
const LZMA_DICT_MIN_KB: u32 = 4;
const LZMA_DICT_MAX_KB: u32 = 3_932_160;

/// `LZMANumBlockThreads` 的有效范围。官方默认值是 1（不是「自动」）。
const LZMA_THREADS_MAX: u32 = 256;

/// `DiskSliceSize` 的有效范围（字节）。官方也接受字面量 `max`，默认 `2100000000`。
/// 注意上限 9223372036800000000 超出 JS 的安全整数范围（2^53），前端用的是同一个
/// 数值 —— 它的最短往返表示恰好还是这串数字，所以两侧拼出来的字符串一致。
const SLICE_MIN_BYTES: u64 = 262_144;
const SLICE_MAX_BYTES: u64 = 9_223_372_036_800_000_000;

/// `SlicesPerDisk` 的有效范围。官方：1–26，默认 1。
const SLICES_MIN: u32 = 1;
const SLICES_MAX: u32 = 26;

/// 由界面上的选项生成 Inno Setup 打包脚本。
/// 模板里的 `${...}` 占位符保持原样，由 `template::render` 在执行阶段替换。
pub fn package_script(opts: &PackageOptions) -> String {
    let compression = pick(&opts.compression, COMPRESSIONS, "lzma2/max");
    let algo = compression.split('/').next().unwrap_or("lzma2").to_string();
    let is_lzma = matches!(algo.as_str(), "lzma" | "lzma2");
    let compressing = compression != "none";

    let mode = pick(&opts.packaging_mode, PACKAGING_MODES, "single");
    let portable = mode == "portable";
    let multi_volume = mode == "multi_volume";

    let encryption = pick(&opts.encryption, ENCRYPTIONS, "yes");
    let privileges = if opts.require_admin {
        "admin"
    } else {
        "lowest"
    };
    let wizard = pick(&opts.wizard_style, WIZARD_STYLES, "modern");

    let mut out = String::new();
    out.push_str("; SealPack 打包脚本（Inno Setup）\n");
    out.push_str("; 本文件由界面上的选项生成；在「高级」里直接编辑后会转为自定义模式。\n");
    out.push_str("; 占位符使用 ${key} 语法，执行时会被替换为工程实际值\n\n");

    out.push_str("#define MyAppName \"${name}\"\n");
    out.push_str("#define MyAppVersion \"${version}\"\n");
    out.push_str("#define MyAppExeName \"${exe}\"\n");
    out.push_str("#define MyAppPublisher \"hmilyld\"\n");
    out.push_str("#define MyAppURL \"https://hmilyld.com/\"\n\n");

    out.push_str("[Setup]\n");
    out.push_str("AppId={{${id}\n");
    out.push_str("AppName={#MyAppName}\n");
    out.push_str("AppVersion={#MyAppVersion}\n");
    out.push_str("AppPublisher={#MyAppPublisher}\n");
    out.push_str("AppPublisherURL={#MyAppURL}\n");
    out.push_str("AppSupportURL={#MyAppURL}\n");
    out.push_str("AppUpdatesURL={#MyAppURL}\n");
    out.push_str("DefaultDirName={autopf}\\{#MyAppName}\n");
    out.push_str("DisableProgramGroupPage=yes\n");
    out.push_str(&format!("PrivilegesRequired={privileges}\n"));
    out.push_str("OutputDir=${output}\n");
    out.push_str("OutputBaseFilename={#MyAppName}-安装包-{#MyAppVersion}\n");

    // ---- 压缩
    out.push_str(&format!("Compression={compression}\n"));
    if opts.solid_compression && compressing {
        out.push_str("SolidCompression=yes\n");
    }
    if is_lzma && compressing {
        // 0 表示「交给 Inno 按压缩等级自动决定」，此时不写这一行，
        // 免得把一个外行数字固化成比 Inno 自己选的值还差的配置。
        // 判断下界用官方最小值 4（而不是 0）：1–3 会被 ISCC 直接拒绝。
        if opts.lzma_dictionary_size >= LZMA_DICT_MIN_KB {
            out.push_str(&format!(
                "LZMADictionarySize={}\n",
                opts.lzma_dictionary_size.min(LZMA_DICT_MAX_KB)
            ));
        }
        // 0 = 不写这一行，Inno 用它自己的默认值 1
        if opts.lzma_num_block_threads > 0 {
            out.push_str(&format!(
                "LZMANumBlockThreads={}\n",
                opts.lzma_num_block_threads.min(LZMA_THREADS_MAX)
            ));
        }
        out.push_str(&format!(
            "LZMAMatchFinder={}\n",
            pick(&opts.lzma_match_finder, MATCH_FINDERS, "BT")
        ));
        if opts.lzma_use_separate_process {
            out.push_str("LZMAUseSeparateProcess=yes\n");
        }
    }

    // ---- 分卷：超过 4.2GB 时 Inno 会强制要求打开它
    if multi_volume {
        out.push_str("DiskSpanning=yes\n");
        // 低于官方下界的值不写（交给 Inno 用默认的 2100000000），高于上限的收敛到上限
        if opts.disk_slice_size >= SLICE_MIN_BYTES {
            out.push_str(&format!(
                "DiskSliceSize={}\n",
                opts.disk_slice_size.min(SLICE_MAX_BYTES)
            ));
        }
        out.push_str(&format!(
            "SlicesPerDisk={}\n",
            opts.slices_per_disk.clamp(SLICES_MIN, SLICES_MAX)
        ));
    }

    // ---- 安装包加密（对称，XChaCha20）
    if encryption != "no" {
        // yes 与 full 都由编译器用 `Password` 派生密钥：
        //   yes  —— 只加密 [Files] 里的内容，安装时弹框让用户输口令；
        //   full —— 连安装界面一起加密，所以装的时候没有输入框可用，
        //           必须用 `安装包.exe /PASSWORD=<口令>` 启动（这是运行期的参数，
        //           不是 ISCC 的参数 —— ISCC 并没有 /PASSWORD= 这个开关）。
        out.push_str("Password=${password}\n");
        out.push_str(&format!("Encryption={encryption}\n"));
        // 密钥由口令经 PBKDF2-HMAC-SHA256 派生，迭代次数越高越难暴力破解
        out.push_str(&format!(
            "EncryptionKeyDerivation=pbkdf2/{}\n",
            opts.kdf_iterations.max(1)
        ));
    }

    // ---- 代码签名（非对称）
    let sign_tool = opts.sign_tool.trim();
    if !sign_tool.is_empty() {
        out.push_str(&format!("SignTool={sign_tool}\n"));
        if opts.signed_uninstaller {
            out.push_str("SignedUninstaller=yes\n");
        }
    }

    if portable {
        // 绿色版：不写卸载信息、不生成卸载程序，解压即用
        out.push_str("Uninstallable=no\n");
        out.push_str("CreateUninstallRegKey=no\n");
    } else if !opts.uninstallable {
        out.push_str("Uninstallable=no\n");
    }

    out.push_str(&format!("WizardStyle={wizard}\n\n"));

    out.push_str("[Languages]\n");
    // 简体中文**不在** Inno Setup 的官方发行版里（官方 `Languages\` 只带 29 种语言，
    // 中文属于用户贡献的翻译）。所以不能用 `compiler:Languages\ChineseSimplified.isl` ——
    // 那在任何标准安装上都会以「Couldn't open include file」失败，只有手工往 Inno
    // 目录里放过这个文件的机器才能跑通。
    //
    // 改成相对路径：执行阶段会把随应用分发的那份语言包复制到临时脚本旁边，
    // ISCC 按**脚本所在目录**解析相对路径，于是与 Inno 装在哪儿无关。
    out.push_str("Name: \"chinesesimplified\"; MessagesFile: \"ChineseSimplified.isl\"\n\n");

    // 绿色版不建开始菜单项与桌面图标，所以也不生成 [Tasks]
    if opts.desktop_icon && !portable {
        out.push_str("[Tasks]\n");
        out.push_str(
            "Name: \"desktopicon\"; Description: \"{cm:CreateDesktopIcon}\"; GroupDescription: \"{cm:AdditionalIcons}\"; Flags: unchecked\n\n",
        );
    }

    out.push_str("[Files]\n");
    out.push_str("Source: \"${root}\\${exe}\"; DestDir: \"{app}\"; Flags: ignoreversion\n");
    // 主程序由上一行显式加入，`*` 这一行必须把它排除掉 —— 否则同一个文件会进包两次
    // （Inno 会报重复文件，体积统计也会重复计数）。`${ignore}` 至少含主程序备份，
    // 因此这里不会拼出以逗号开头的空项。
    out.push_str(
        "Source: \"${root}\\*\"; Excludes: \"${ignore},${exe}\"; DestDir: \"{app}\"; Flags: ignoreversion recursesubdirs createallsubdirs\n\n",
    );

    if !portable {
        out.push_str("[Icons]\n");
        out.push_str(
            "Name: \"{autoprograms}\\{#MyAppName}\"; Filename: \"{app}\\{#MyAppExeName}\"\n",
        );
        if opts.desktop_icon {
            out.push_str(
                "Name: \"{autodesktop}\\{#MyAppName}\"; Filename: \"{app}\\{#MyAppExeName}\"; Tasks: desktopicon\n",
            );
        }
        out.push('\n');
    }

    if opts.run_after_install && !portable {
        out.push_str("[Run]\n");
        out.push_str(
            "Filename: \"{app}\\{#MyAppExeName}\"; Description: \"{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}\"; Flags: nowait postinstall skipifsilent\n",
        );
    }

    out
}

// ---------------------------------------------------------------- 测试
//
// 这两个生成器是「选项 → 模板」的唯一实现，也是最容易悄悄改坏的地方
// （属性写错位置、取值大小写不对、参数只在特定组合下才该出现）。
// 所以用断言把它们钉住，改的时候至少知道碰到了什么。
#[cfg(test)]
// 测试里的用例表用「先取默认值、再逐项覆盖」比结构体更新更好读：
// 一屏十来个字段时，不必每处都拖一个 `..Default::default()` 尾巴，改动也只看一行。
// 只在本模块允许；业务代码里这条 lint 照常生效。
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    fn encrypt(opts: EncryptOptions) -> String {
        encrypt_config(&opts)
    }

    fn package(opts: PackageOptions) -> String {
        package_script(&opts)
    }

    #[test]
    fn default_options_only_pack() {
        let out = encrypt(EncryptOptions::default());
        assert!(out.contains("<packer id=\"compressor\" />"), "{out}");
        assert!(out.contains("<module path=\"${exe}\" />"), "{out}");
        assert!(out.contains("未启用任何 protection"), "{out}");
        assert!(!out.contains("<rule"), "{out}");
        // 默认不开重命名，也不写 seed
        assert!(!out.contains("seed="), "{out}");
        assert!(!out.contains("debug="), "{out}");
    }

    #[test]
    fn encrypt_writes_protection_arguments() {
        let mut opts = EncryptOptions::default();
        opts.constants = true;
        opts.const_cfg = true;
        let out = encrypt(opts);

        assert!(out.contains("<protection id=\"constants\">"), "{out}");
        assert!(
            out.contains("<argument name=\"mode\" value=\"normal\" />"),
            "{out}"
        );
        assert!(
            out.contains("<argument name=\"elements\" value=\"SI\" />"),
            "{out}"
        );
        assert!(
            out.contains("<argument name=\"cfg\" value=\"true\" />"),
            "{out}"
        );
    }

    #[test]
    fn parameter_free_protections_are_self_closing() {
        let mut opts = EncryptOptions::default();
        opts.anti_ildasm = true;
        opts.anti_dump = true;
        opts.harden = true;
        let out = encrypt(opts);

        assert!(out.contains("<protection id=\"anti ildasm\" />"), "{out}");
        assert!(out.contains("<protection id=\"anti dump\" />"), "{out}");
        assert!(out.contains("<protection id=\"harden\" />"), "{out}");
    }

    #[test]
    fn strong_name_key_belongs_on_module() {
        let mut opts = EncryptOptions::default();
        opts.sn_key_path = "D:\\keys\\app.snk".into();
        opts.sn_key_pass = "p@ss".into();
        let out = encrypt(opts);

        // snKey / snKeyPass 是 <module> 的属性；写到 <project> 上 ConfuserEx 会静默忽略
        assert!(
            out.contains(
                "<module path=\"${exe}\" snKey=\"D:\\keys\\app.snk\" snKeyPass=\"p@ss\" />"
            ),
            "{out}"
        );
        let project_line = out.lines().next().unwrap();
        assert!(!project_line.contains("snKey"), "{project_line}");
    }

    #[test]
    fn xml_attributes_are_escaped() {
        let mut opts = EncryptOptions::default();
        opts.seed = "a&b\"c".into();
        let out = encrypt(opts);
        assert!(out.contains("seed=\"a&amp;b&quot;c\""), "{out}");
    }

    #[test]
    fn unknown_enum_values_fall_back_to_defaults() {
        let mut opts = EncryptOptions::default();
        opts.rename = true;
        opts.rename_mode = "bogus".into();
        opts.debug_mode = "nope".into();
        opts.anti_debug = true;
        let out = encrypt(opts);

        assert!(
            out.contains("<argument name=\"mode\" value=\"unicode\" />"),
            "{out}"
        );
        assert!(
            out.contains("<argument name=\"mode\" value=\"safe\" />"),
            "{out}"
        );
    }

    #[test]
    fn rename_password_only_in_reversible_mode() {
        let mut opts = EncryptOptions::default();
        opts.rename = true;
        opts.rename_password = "secret".into();

        let unicode = encrypt(opts.clone());
        assert!(!unicode.contains("password"), "{unicode}");

        opts.rename_mode = "reversible".into();
        let reversible = encrypt(opts);
        assert!(
            reversible.contains("<argument name=\"password\" value=\"secret\" />"),
            "{reversible}"
        );
    }

    #[test]
    fn elements_are_normalised() {
        assert_eq!(normalize_elements("sni"), "SNI");
        assert_eq!(normalize_elements("ssnnii"), "SNI");
        assert_eq!(normalize_elements("xyz"), "SI");
        // 只有 P 是没有意义的（P 必须与 S 或 N 同时出现）
        assert_eq!(normalize_elements("P"), "SI");
        assert_eq!(normalize_elements(""), "SI");
    }

    #[test]
    fn control_flow_depth_only_for_expression_predicates() {
        let mut opts = EncryptOptions::default();
        opts.control_flow = true;

        let normal = encrypt(opts.clone());
        assert!(!normal.contains("name=\"depth\""), "{normal}");

        opts.cf_predicate = "expression".into();
        opts.cf_depth = 6;
        let expression = encrypt(opts);
        assert!(
            expression.contains("<argument name=\"depth\" value=\"6\" />"),
            "{expression}"
        );
    }

    #[test]
    fn jump_control_flow_has_no_predicate() {
        let mut opts = EncryptOptions::default();
        opts.control_flow = true;
        opts.cf_type = "jump".into();
        let out = encrypt(opts);
        assert!(
            out.contains("<argument name=\"type\" value=\"jump\" />"),
            "{out}"
        );
        assert!(!out.contains("predicate"), "{out}");
    }

    #[test]
    fn default_options_use_inno_defaults() {
        let out = package(PackageOptions::default());
        assert!(out.contains("Compression=lzma2/max\n"), "{out}");
        assert!(out.contains("SolidCompression=yes\n"), "{out}");
        assert!(out.contains("Encryption=yes\n"), "{out}");
        assert!(
            out.contains("EncryptionKeyDerivation=pbkdf2/220000\n"),
            "{out}"
        );
        assert!(out.contains("PrivilegesRequired=lowest\n"), "{out}");
        assert!(out.contains("WizardStyle=modern\n"), "{out}");
        // 单文件模式不写分卷指令；0 表示「交给 Inno 自动决定」，也不该写出来
        assert!(!out.contains("DiskSpanning"), "{out}");
        assert!(!out.contains("LZMADictionarySize"), "{out}");
        assert!(!out.contains("LZMANumBlockThreads"), "{out}");
        // 默认不签名
        assert!(!out.contains("SignTool"), "{out}");
    }

    #[test]
    fn no_compression_drops_solid_and_lzma_params() {
        let mut opts = PackageOptions::default();
        opts.compression = "none".into();
        opts.lzma_dictionary_size = 8192;
        let out = package(opts);
        assert!(out.contains("Compression=none\n"), "{out}");
        assert!(!out.contains("SolidCompression"), "{out}");
        assert!(!out.contains("LZMADictionarySize"), "{out}");
    }

    #[test]
    fn zip_gets_solid_but_no_lzma_params() {
        let mut opts = PackageOptions::default();
        opts.compression = "zip".into();
        opts.lzma_num_block_threads = 4;
        let out = package(opts);
        assert!(out.contains("Compression=zip\n"), "{out}");
        assert!(out.contains("SolidCompression=yes\n"), "{out}");
        assert!(!out.contains("LZMANumBlockThreads"), "{out}");
    }

    #[test]
    fn lzma_params_are_written_when_set() {
        let mut opts = PackageOptions::default();
        opts.lzma_dictionary_size = 32768;
        opts.lzma_num_block_threads = 4;
        opts.lzma_use_separate_process = true;
        let out = package(opts);
        assert!(out.contains("LZMADictionarySize=32768\n"), "{out}");
        assert!(out.contains("LZMANumBlockThreads=4\n"), "{out}");
        assert!(out.contains("LZMAMatchFinder=BT\n"), "{out}");
        assert!(out.contains("LZMAUseSeparateProcess=yes\n"), "{out}");
    }

    #[test]
    fn match_finder_is_upper_cased() {
        let mut opts = PackageOptions::default();
        opts.lzma_match_finder = "hc".into();
        assert!(package(opts).contains("LZMAMatchFinder=HC\n"));
    }

    #[test]
    fn multi_volume_enables_disk_spanning() {
        let mut opts = PackageOptions::default();
        opts.packaging_mode = "multi_volume".into();
        opts.disk_slice_size = 1_566_000_000;
        opts.slices_per_disk = 3;
        let out = package(opts);
        assert!(out.contains("DiskSpanning=yes\n"), "{out}");
        assert!(out.contains("DiskSliceSize=1566000000\n"), "{out}");
        assert!(out.contains("SlicesPerDisk=3\n"), "{out}");
    }

    #[test]
    fn slice_size_below_minimum_is_omitted() {
        let mut opts = PackageOptions::default();
        opts.packaging_mode = "multi_volume".into();
        opts.disk_slice_size = 1024; // Inno 的最小值是 262144
        let out = package(opts);
        assert!(out.contains("DiskSpanning=yes\n"), "{out}");
        assert!(!out.contains("DiskSliceSize"), "{out}");
    }

    #[test]
    fn portable_drops_installer_furniture() {
        let mut opts = PackageOptions::default();
        opts.packaging_mode = "portable".into();
        let out = package(opts);
        assert!(out.contains("Uninstallable=no\n"), "{out}");
        assert!(out.contains("CreateUninstallRegKey=no\n"), "{out}");
        // 绿色版不建开始菜单项、不建桌面图标、不自动运行
        assert!(!out.contains("[Icons]"), "{out}");
        assert!(!out.contains("[Tasks]"), "{out}");
        assert!(!out.contains("[Run]"), "{out}");
    }

    #[test]
    fn no_encryption_omits_password_and_kdf() {
        let mut opts = PackageOptions::default();
        opts.encryption = "no".into();
        let out = package(opts);
        assert!(!out.contains("Password="), "{out}");
        assert!(!out.contains("Encryption="), "{out}");
        assert!(!out.contains("EncryptionKeyDerivation"), "{out}");
    }

    #[test]
    fn full_encryption_still_writes_password() {
        // full 模式的口令在**运行安装包**时用 /PASSWORD= 给，
        // 编译期仍然要靠 Password 指令派生密钥 —— 两件事不冲突。
        let mut opts = PackageOptions::default();
        opts.encryption = "full".into();
        let out = package(opts);
        assert!(out.contains("Password=${password}\n"), "{out}");
        assert!(out.contains("Encryption=full\n"), "{out}");
    }

    #[test]
    fn sign_tool_only_when_set() {
        let mut opts = PackageOptions::default();
        opts.sign_tool = "signtool".into();
        opts.signed_uninstaller = true;
        let out = package(opts);
        assert!(out.contains("SignTool=signtool\n"), "{out}");
        assert!(out.contains("SignedUninstaller=yes\n"), "{out}");
    }

    #[test]
    fn unknown_compression_falls_back() {
        let mut opts = PackageOptions::default();
        opts.compression = "rar/9".into();
        assert!(package(opts).contains("Compression=lzma2/max\n"));
    }

    #[test]
    fn generated_script_is_not_empty_and_keeps_placeholders() {
        let out = package(PackageOptions::default());
        assert!(out.contains("${ignore}"), "{out}");
        assert!(out.contains("${password}"), "{out}");
        assert!(out.contains("${output}"), "{out}");
    }

    /// 主程序由显式那一行加入，`*` 那行必须把它排除，否则同一文件进包两次
    #[test]
    fn wildcard_source_excludes_the_main_exe() {
        let out = package(PackageOptions::default());
        assert!(out.contains(r#"Excludes: "${ignore},${exe}""#), "{out}");
        // 显式那一行仍然在，主程序不会因为被排除而漏掉
        assert!(out.contains(r#"Source: "${root}\${exe}""#), "{out}");
    }

    // ---------------------------------------------------------------- Inno 边界值
    //
    // 下面几条盯的都是「抄错官方数字」这类错误 —— 它们不会让 ISCC 报错，
    // 只会静默地产生一个非预期的安装包。

    /// `LZMADictionarySize`：官方有效范围 4–3932160（64 位编译器）
    #[test]
    fn lzma_dictionary_size_uses_official_bounds() {
        let mut opts = PackageOptions::default();

        // 低于下界 4：不写这一行（1–3 会被 ISCC 拒绝）
        opts.lzma_dictionary_size = 2;
        assert!(!package(opts.clone()).contains("LZMADictionarySize"));

        // 4 是下界，要写出来
        opts.lzma_dictionary_size = 4;
        assert!(package(opts.clone()).contains("LZMADictionarySize=4\n"));

        // 超过 64 位编译器的上限：收敛到上限
        opts.lzma_dictionary_size = 9_999_999;
        assert!(package(opts).contains("LZMADictionarySize=3932160\n"));
    }

    /// `LZMANumBlockThreads`：官方 1–256，默认 1（不是「自动」）
    #[test]
    fn block_threads_use_official_bounds() {
        let mut opts = PackageOptions::default();
        opts.lzma_num_block_threads = 999;
        assert!(package(opts).contains("LZMANumBlockThreads=256\n"));

        // 0 = 不写这一行 → Inno 用自己的默认值 1
        let mut opts = PackageOptions::default();
        opts.lzma_num_block_threads = 0;
        assert!(!package(opts).contains("LZMANumBlockThreads"));
    }

    /// `DiskSliceSize`：官方 262144–9223372036800000000（也接受字面量 max）
    #[test]
    fn slice_size_uses_official_bounds() {
        let mut opts = PackageOptions::default();
        opts.packaging_mode = "multi_volume".into();

        // 低于下界：不写，交给 Inno 默认的 2100000000
        opts.disk_slice_size = 1024;
        assert!(!package(opts.clone()).contains("DiskSliceSize"));

        // 超过官方上限：收敛到上限
        opts.disk_slice_size = u64::MAX;
        assert!(package(opts).contains("DiskSliceSize=9223372036800000000\n"));
    }

    /// `SlicesPerDisk`：官方 1–26
    #[test]
    fn slices_per_disk_uses_official_bounds() {
        let mut opts = PackageOptions::default();
        opts.packaging_mode = "multi_volume".into();

        opts.slices_per_disk = 99;
        assert!(package(opts.clone()).contains("SlicesPerDisk=26\n"));

        opts.slices_per_disk = 0;
        assert!(package(opts).contains("SlicesPerDisk=1\n"));
    }

    /// `EncryptionKeyDerivation`：官方 `pbkdf2/1`–`pbkdf2/2147483647`，默认 `pbkdf2/220000`
    #[test]
    fn kdf_iterations_are_never_zero() {
        let mut opts = PackageOptions::default();
        opts.kdf_iterations = 0;
        assert!(package(opts).contains("EncryptionKeyDerivation=pbkdf2/1\n"));
    }

    /// 语言包必须用**相对路径**引用。
    ///
    /// 简体中文不在 Inno Setup 官方发行版里，`compiler:Languages\ChineseSimplified.isl`
    /// 在标准安装上必然编译失败（只有手工放过该文件的机器才行）。
    #[test]
    fn language_file_is_referenced_relatively() {
        let out = package(PackageOptions::default());
        assert!(
            out.contains(r#"MessagesFile: "ChineseSimplified.isl""#),
            "{out}"
        );
        assert!(
            !out.contains("compiler:"),
            "不该依赖 Inno 的安装目录：{out}"
        );
    }

    // ---------------------------------------------------------------- 一致性 fixture
    //
    // 浏览器预览用的 `preview/render.ts` 是这两个生成器的镜像，两边必须逐字一致。
    // 这里把一组有代表性的选项连同 Rust 侧的生成结果 dump 成 JSON，
    // 由 `scripts/check-render-parity.mjs` 拿 TS 侧的输出与之比对 ——
    // 「改 Rust 侧时记得同步 mock」这句口头约定，现在有机器守着了。

    fn json_str(value: &str) -> String {
        serde_json::to_string(value).expect("字符串序列化不会失败")
    }

    /// 覆盖两侧最容易写错的分支：默认值、每条带参数的 protection、
    /// 条件参数（depth 只跟 expression / x86）、强名称签名、XML 转义、
    /// 分卷、绿色版、加密三态、签名、LZMA 参数、未知取值回退。
    fn fixture_cases() -> Vec<(&'static str, EncryptOptions, PackageOptions)> {
        let mut cases: Vec<(&'static str, EncryptOptions, PackageOptions)> = vec![(
            "defaults",
            EncryptOptions::default(),
            PackageOptions::default(),
        )];

        let mut enc = EncryptOptions::default();
        enc.anti_ildasm = true;
        enc.anti_dump = true;
        enc.anti_tamper = true;
        enc.tamper_mode = "jit".into();
        enc.tamper_key = "dynamic".into();
        enc.anti_debug = true;
        enc.debug_mode = "win32".into();
        enc.invalid_metadata = true;
        enc.harden = true;
        cases.push(("anti-family", enc, PackageOptions::default()));

        let mut enc = EncryptOptions::default();
        enc.rename = true;
        enc.rename_mode = "reversible".into();
        enc.rename_password = "p@ss".into();
        enc.rename_args = false;
        enc.ren_enum = true;
        enc.ren_public = true;
        cases.push(("rename-reversible", enc, PackageOptions::default()));

        let mut enc = EncryptOptions::default();
        enc.rename = true;
        enc.rename_mode = "letters".into();
        enc.rename_password = "不该出现".into(); // 非 reversible 时必须被忽略
        cases.push(("rename-password-ignored", enc, PackageOptions::default()));

        let mut enc = EncryptOptions::default();
        enc.control_flow = true;
        enc.cf_type = "switch".into();
        enc.cf_predicate = "expression".into();
        enc.cf_depth = 6;
        enc.cf_intensity = 42;
        enc.cf_junk = true;
        cases.push(("ctrl-flow-expression", enc, PackageOptions::default()));

        let mut enc = EncryptOptions::default();
        enc.control_flow = true;
        enc.cf_type = "jump".into();
        cases.push(("ctrl-flow-jump", enc, PackageOptions::default()));

        let mut enc = EncryptOptions::default();
        enc.constants = true;
        enc.const_mode = "x86".into();
        enc.const_elements = "snpi".into();
        enc.const_cfg = true;
        enc.resources = true;
        enc.res_mode = "dynamic".into();
        enc.ref_proxy = true;
        enc.ref_mode = "strong".into();
        enc.ref_internal = true;
        cases.push(("data-and-ref", enc, PackageOptions::default()));

        let mut enc = EncryptOptions::default();
        enc.seed = "a&b\"c".into();
        enc.debug_symbols = true;
        enc.sn_key_path = r"D:\keys\app.snk".into();
        enc.sn_key_pass = "秘密".into();
        enc.compress = false;
        cases.push(("seed-escape-and-snkey", enc, PackageOptions::default()));

        let mut enc = EncryptOptions::default();
        enc.preset = "bogus".into();
        enc.rename = true;
        enc.rename_mode = "bogus".into();
        enc.anti_debug = true;
        enc.debug_mode = "nope".into();
        enc.const_elements = "P".into();
        cases.push(("unknown-values-fall-back", enc, PackageOptions::default()));

        let mut pkg = PackageOptions::default();
        pkg.compression = "none".into();
        pkg.solid_compression = false;
        pkg.lzma_dictionary_size = 8192;
        cases.push(("no-compression", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.compression = "zip".into();
        pkg.lzma_num_block_threads = 4;
        cases.push(("zip", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.lzma_dictionary_size = 32768;
        pkg.lzma_num_block_threads = 4;
        pkg.lzma_match_finder = "hc".into();
        pkg.lzma_use_separate_process = true;
        cases.push(("lzma-params", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.packaging_mode = "multi_volume".into();
        pkg.disk_slice_size = 1_566_000_000;
        pkg.slices_per_disk = 3;
        cases.push(("multi-volume", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.packaging_mode = "multi_volume".into();
        pkg.disk_slice_size = 1024; // 低于 Inno 的最小值，应被省略
        cases.push(("slice-size-too-small", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.packaging_mode = "portable".into();
        cases.push(("portable", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.encryption = "no".into();
        cases.push(("no-encryption", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.encryption = "full".into();
        pkg.kdf_iterations = 500_000;
        cases.push(("full-encryption", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.sign_tool = "signtool".into();
        pkg.signed_uninstaller = true;
        pkg.require_admin = true;
        pkg.wizard_style = "classic".into();
        pkg.uninstallable = false;
        cases.push(("sign-and-admin", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.desktop_icon = false;
        pkg.run_after_install = false;
        cases.push(("no-icon-no-run", EncryptOptions::default(), pkg));

        let mut pkg = PackageOptions::default();
        pkg.compression = "rar/9".into();
        cases.push((
            "unknown-compression-falls-back",
            EncryptOptions::default(),
            pkg,
        ));

        // 官方边界：字典大小低于下界 4 → 省略该行
        let mut pkg = PackageOptions::default();
        pkg.lzma_dictionary_size = 2;
        cases.push(("dict-size-below-minimum", EncryptOptions::default(), pkg));

        // 官方边界：分片大小与每盘片数都超上限 → 收敛到上限
        let mut pkg = PackageOptions::default();
        pkg.packaging_mode = "multi_volume".into();
        pkg.disk_slice_size = 9_300_000_000_000_000_000;
        pkg.slices_per_disk = 99;
        cases.push(("slice-bounds-clamped", EncryptOptions::default(), pkg));

        cases
    }

    /// 把两侧的生成结果 dump 成 fixture。
    ///
    /// 默认忽略（它要写文件）。改动任一生成器后跑：
    ///   cargo test --lib dump_render_fixtures -- --ignored --nocapture
    ///   node scripts/check-render-parity.mjs
    #[test]
    #[ignore = "写 fixture 文件，按需运行"]
    fn dump_render_fixtures() {
        let out_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("docs")
            .join("fixtures");
        std::fs::create_dir_all(&out_dir).unwrap();

        let cases = fixture_cases();
        let mut body = String::from("{\n  \"cases\": [\n");
        for (i, (name, enc, pkg)) in cases.iter().enumerate() {
            if i > 0 {
                body.push_str(",\n");
            }
            body.push_str(&format!(
                "    {{ \"name\": {}, \"encryptOptions\": {}, \"packageOptions\": {}, \"encryptConfig\": {}, \"packageScript\": {} }}",
                json_str(name),
                serde_json::to_string(enc).unwrap(),
                serde_json::to_string(pkg).unwrap(),
                json_str(&encrypt_config(enc)),
                json_str(&package_script(pkg)),
            ));
        }
        body.push_str("\n  ]\n}\n");

        let path = out_dir.join("render-fixtures.json");
        std::fs::write(&path, body).unwrap();
        println!("已写出 {} 个用例 → {}", cases.len(), path.display());
    }
}
