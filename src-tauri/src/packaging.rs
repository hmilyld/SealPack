//! 打包阶段的脚本片段：完整包与升级包只在这里分叉。
//!
//! `defaults.rs` 生成的是「模板」，里面保留 `${files}` / `${installDelete}` /
//! `${artifactSetup}` / `${artifactCode}` / `${artifactLabel}` / `${runSection}`
//! 六个占位符；本模块按产物类型把它们展开成 Inno 能直接编译的文本。
//!
//! 这样合并 / 加密完全不用知道「升级包」的存在，也只有一套 `.iss` 模板。

use std::path::Path;

use crate::manifest::DiffEntry;
use crate::model::Project;

pub const INSTALLER: &str = "installer";
pub const UPGRADE: &str = "upgrade";

/// 完整包的文件段：主程序一行 + 通配符一行。
///
/// 主程序必须从 `*` 里排除，否则同一个文件会进包两次（Inno 会报重复文件，
/// 体积统计也会重复计数）。`${ignore}` 至少含主程序备份，不会拼出空项。
pub fn full_files_section() -> &'static str {
    "Source: \"${root}\\${exe}\"; DestDir: \"{app}\"; Flags: ignoreversion\n\
Source: \"${root}\\*\"; Excludes: \"${ignore},${exe}\"; DestDir: \"{app}\"; Flags: ignoreversion recursesubdirs createallsubdirs\n"
}

/// 升级包的文件段：只列新增 / 修改的文件，并保留相对目录。
pub fn upgrade_files_section(project: &Project, entries: &[DiffEntry]) -> String {
    let mut out = String::new();
    for entry in entries
        .iter()
        .filter(|entry| matches!(entry.status.as_str(), "new" | "modified"))
    {
        let absolute = Path::new(&project.root_path).join(&entry.path);
        let source = escape_braces(&absolute.to_string_lossy());
        let parent = Path::new(&entry.path)
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        let dest = if parent.is_empty() {
            "{app}".to_string()
        } else {
            format!("{{app}}\\{}", escape_braces(&parent))
        };
        out.push_str(&format!(
            "Source: \"{source}\"; DestDir: \"{dest}\"; Flags: ignoreversion\n"
        ));
    }
    out
}

/// 旧版本有、新版本没有的文件。只删文件，不碰用户数据目录。
pub fn install_delete_section(entries: &[DiffEntry]) -> String {
    let deleted: Vec<&DiffEntry> = entries
        .iter()
        .filter(|entry| entry.status == "deleted")
        .collect();
    if deleted.is_empty() {
        return String::new();
    }
    let mut out = String::from("[InstallDelete]\n");
    for entry in deleted {
        out.push_str(&format!(
            "Type: files; Name: \"{{app}}\\{}\"\n",
            escape_braces(&entry.path)
        ));
    }
    out
}

/// `[Setup]` 段里的升级专用指令。完整包为空。
pub fn artifact_setup(artifact: &str) -> &'static str {
    if artifact == UPGRADE {
        // 目录页 / 就绪页 / 完成页全部跳过；目录沿用旧版本，任务沿用上次选择。
        // `DisableProgramGroupPage=yes` 已在公共模板里。
        "DisableDirPage=yes\nDisableReadyPage=yes\nDisableFinishedPage=yes\n"
    } else {
        ""
    }
}

/// 升级包的 `[Code]`：跳过任务页 + 校验目标机器上的旧版本。
///
/// `DisableTasksPage` 这个指令并不存在（Inno 6.7.3 实测），只能靠
/// `ShouldSkipPage(wpSelectTasks)`。注册表键是 Inno 的 `<AppId>_is1`；
/// 管理员安装看 HKLM，当前用户安装看 HKCU。
pub fn artifact_code(artifact: &str, baseline_version: &str) -> String {
    if artifact != UPGRADE {
        return String::new();
    }
    let baseline = baseline_version.replace('\'', "''");
    format!(
        r#"[Code]
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := PageID = wpSelectTasks;
end;

function InstalledVersion(RootKey: Integer; const Key: String): String;
var
  Value: String;
begin
  if RegQueryStringValue(RootKey, Key, 'DisplayVersion', Value) then
    Result := Value
  else
    Result := '';
end;

function InitializeSetup(): Boolean;
var
  Key: String;
  Installed: String;
begin
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#MyAppId}}_is1';
  if IsAdminInstallMode then
  begin
    Installed := InstalledVersion(HKLM32, Key);
    if Installed = '' then
      Installed := InstalledVersion(HKLM64, Key);
  end
  else
    Installed := InstalledVersion(HKCU, Key);

  if Installed = '' then
  begin
    if not WizardSilent then
      MsgBox('未检测到已安装的旧版本。请先安装完整安装包，或改用完整安装包。', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if ('{baseline}' <> '') and (Installed <> '{baseline}') then
  begin
    if WizardSilent then
    begin
      Result := False;
      Exit;
    end;
    if MsgBox('当前安装版本是 ' + Installed + '，这个升级包基于 {baseline}。继续可能导致文件缺失，是否继续？', mbConfirmation, MB_YESNO) <> IDYES then
    begin
      Result := False;
      Exit;
    end;
  end;

  Result := True;
end;
"#
    )
}

/// `[Run]` 段。升级包不自动启动：零向导下没有完成页，postinstall 是否执行不可靠。
pub fn run_section(project: &Project, artifact: &str) -> String {
    if artifact == UPGRADE
        || project.package_options.packaging_mode == "portable"
        || !project.package_options.run_after_install
    {
        return String::new();
    }
    "[Run]\nFilename: \"{app}\\{#MyAppExeName}\"; Description: \"{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}\"; Flags: nowait postinstall skipifsilent\n".into()
}

/// 按产物类型组装要传给 `template::render` 的额外变量。
pub fn render_vars(
    project: &Project,
    artifact: &str,
    baseline_version: &str,
    entries: &[DiffEntry],
) -> Vec<(&'static str, String)> {
    let files = if artifact == UPGRADE {
        upgrade_files_section(project, entries)
    } else {
        full_files_section().to_string()
    };
    let install_delete = if artifact == UPGRADE {
        install_delete_section(entries)
    } else {
        String::new()
    };
    let label = if artifact == UPGRADE {
        "升级包"
    } else {
        "安装包"
    };

    vec![
        ("files", files),
        ("installDelete", install_delete),
        ("artifactSetup", artifact_setup(artifact).to_string()),
        ("artifactCode", artifact_code(artifact, baseline_version)),
        ("artifactLabel", label.to_string()),
        ("runSection", run_section(project, artifact)),
        ("baselineVersion", baseline_version.to_string()),
    ]
}

/// Inno 的 `Source` / `Name` 里 `{` 会开启常量，文件名里的花括号要转义成 `{{`。
fn escape_braces(value: &str) -> String {
    value.replace('{', "{{")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BuildOptions, EncryptOptions, PackageOptions};

    fn project() -> Project {
        Project {
            id: "p".into(),
            name: "Demo".into(),
            root_path: r"D:\App".into(),
            exe_file: r"D:\App\Demo.exe".into(),
            output_dir: r"D:\Out".into(),
            password: String::new(),
            version: "1.2.0".into(),
            merge_dlls: Vec::new(),
            exclude_paths: Vec::new(),
            encrypt_options: EncryptOptions::default(),
            package_options: PackageOptions::default(),
            encrypt_config: String::new(),
            package_script: String::new(),
            build_options: BuildOptions::default(),
            schema_version: 3,
            build_history: Vec::new(),
        }
    }

    fn entry(path: &str, status: &str, size: u64) -> DiffEntry {
        DiffEntry {
            path: path.into(),
            status: status.into(),
            size,
            old_size: 0,
        }
    }

    #[test]
    fn full_files_section_keeps_the_main_exe_exclusion() {
        let out = full_files_section();
        assert!(out.contains(r#"Source: "${root}\${exe}""#), "{out}");
        assert!(out.contains(r#"Excludes: "${ignore},${exe}""#), "{out}");
    }

    #[test]
    fn upgrade_files_only_lists_new_and_modified_with_dirs() {
        let entries = vec![
            entry("Demo.exe", "modified", 10),
            entry("lib\\a.dll", "new", 20),
            entry("lib\\same.dll", "unchanged", 30),
            entry("old.txt", "deleted", 40),
        ];
        let out = upgrade_files_section(&project(), &entries);
        assert!(
            out.contains(r#"Source: "D:\App\Demo.exe"; DestDir: "{app}""#),
            "{out}"
        );
        assert!(
            out.contains(r#"Source: "D:\App\lib\a.dll"; DestDir: "{app}\lib""#),
            "{out}"
        );
        assert!(!out.contains("same.dll"), "{out}");
        assert!(!out.contains("old.txt"), "{out}");
    }

    #[test]
    fn install_delete_only_lists_deleted_files() {
        let entries = vec![
            entry("a.dll", "modified", 10),
            entry("old\\b.txt", "deleted", 20),
        ];
        let out = install_delete_section(&entries);
        assert!(out.starts_with("[InstallDelete]\n"), "{out}");
        assert!(
            out.contains(r#"Type: files; Name: "{app}\old\b.txt""#),
            "{out}"
        );
        assert!(!out.contains("a.dll"), "{out}");
        assert!(install_delete_section(&entries[..1]).is_empty());
    }

    #[test]
    fn upgrade_setup_and_code_are_present() {
        let setup = artifact_setup(UPGRADE);
        assert!(setup.contains("DisableDirPage=yes"), "{setup}");
        assert!(setup.contains("DisableReadyPage=yes"), "{setup}");
        assert!(setup.contains("DisableFinishedPage=yes"), "{setup}");
        assert!(artifact_setup(INSTALLER).is_empty());

        let code = artifact_code(UPGRADE, "1.1.0");
        assert!(code.contains("ShouldSkipPage"), "{code}");
        assert!(code.contains("wpSelectTasks"), "{code}");
        assert!(code.contains("InitializeSetup"), "{code}");
        assert!(code.contains("'1.1.0'"), "{code}");
        assert!(artifact_code(INSTALLER, "1.1.0").is_empty());
    }

    #[test]
    fn upgrade_never_runs_the_app_after_install() {
        let mut p = project();
        p.package_options.run_after_install = true;
        assert!(run_section(&p, INSTALLER).contains("[Run]"));
        assert!(run_section(&p, UPGRADE).is_empty());
    }

    #[test]
    fn braces_in_file_names_are_escaped() {
        let entries = vec![entry("weird{name}.dll", "new", 10)];
        let out = upgrade_files_section(&project(), &entries);
        // Inno 只需要把 `{` 转义成 `{{`；`}` 本身不是特殊字符
        assert!(out.contains("weird{{name}.dll"), "{out}");
    }

    /// 真实安装：完整 v1 → 升级 v2 → 卸载。
    ///
    /// 会写 `%TEMP%` 和一个 HKCU 卸载项；用随机 AppId，并在 Drop 里跑卸载器，
    /// 所以重复运行不会互相干扰。仍然标 ignored，避免 CI 在没有 Inno 的机器上失败。
    #[test]
    #[ignore = "会真实安装到 %TEMP% 并写 HKCU 卸载项；需要 Inno Setup 6"]
    fn real_install_upgrade_and_uninstall() {
        let iscc = Path::new(r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe");
        if !iscc.is_file() {
            eprintln!("跳过：未找到 ISCC");
            return;
        }

        let dir = std::env::temp_dir().join("sealpack-install-upgrade");
        let _ = std::fs::remove_dir_all(&dir);
        let src1 = dir.join("src-v1");
        let src2 = dir.join("src-v2");
        let out = dir.join("out");
        let install = dir.join("install");
        std::fs::create_dir_all(&src1).unwrap();
        std::fs::create_dir_all(&src2).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(src1.join("Demo.exe"), b"v1").unwrap();
        std::fs::write(src1.join("same.dll"), b"same").unwrap();
        std::fs::write(src1.join("old.txt"), b"old").unwrap();
        std::fs::write(src2.join("Demo.exe"), b"v2").unwrap();
        std::fs::write(src2.join("same.dll"), b"same").unwrap();
        std::fs::write(src2.join("new.dll"), b"new").unwrap();

        let isl = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/isl/ChineseSimplified.isl");
        std::fs::copy(&isl, dir.join("ChineseSimplified.isl")).unwrap();

        struct Guard(std::path::PathBuf);
        impl Drop for Guard {
            fn drop(&mut self) {
                let unins = self.0.join("unins000.exe");
                if unins.is_file() {
                    let _ = std::process::Command::new(&unins)
                        .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
                        .status();
                    for _ in 0..50 {
                        if !self.0.join("Demo.exe").exists() {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = Guard(install.clone());

        let app_id = uuid::Uuid::new_v4().to_string();
        let mut base = project();
        base.name = "Probe".into();
        base.package_options.app_id = app_id;
        base.package_options.encryption = "no".into();
        base.package_options.checksum = "none".into();
        base.package_options.run_after_install = false;
        base.package_options.desktop_icon = false;

        let mut v1 = base.clone();
        v1.root_path = src1.to_string_lossy().to_string();
        v1.exe_file = src1.join("Demo.exe").to_string_lossy().to_string();
        v1.output_dir = out.to_string_lossy().to_string();
        v1.version = "1.0.0".into();

        let mut v2 = base.clone();
        v2.root_path = src2.to_string_lossy().to_string();
        v2.exe_file = src2.join("Demo.exe").to_string_lossy().to_string();
        v2.output_dir = out.to_string_lossy().to_string();
        v2.version = "1.1.0".into();

        let entries = vec![
            entry("Demo.exe", "modified", 2),
            entry("new.dll", "new", 3),
            entry("old.txt", "deleted", 3),
        ];

        let v1_exe = compile(&dir, &v1, INSTALLER, "", &[], "v1-full");
        let v2_exe = compile(&dir, &v2, UPGRADE, "1.0.0", &entries, "v2-upgrade");

        // 干净机器：升级包必须拒绝安装
        let _ = std::process::Command::new(&v2_exe)
            .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
            .status();
        assert!(
            !install.join("Demo.exe").exists(),
            "没有旧版本时升级包不应安装任何文件"
        );

        // 完整 v1
        let status = std::process::Command::new(&v1_exe)
            .arg("/VERYSILENT")
            .arg("/SUPPRESSMSGBOXES")
            .arg("/NORESTART")
            .arg(format!("/DIR={}", install.display()))
            .status()
            .expect("无法启动 v1 安装包");
        assert!(status.success(), "v1 安装失败");
        assert_eq!(std::fs::read(install.join("Demo.exe")).unwrap(), b"v1");
        assert!(install.join("old.txt").exists());

        // 升级 v2：只装变更文件、删除旧文件、保留未变化文件
        let status = std::process::Command::new(&v2_exe)
            .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
            .status()
            .expect("无法启动 v2 升级包");
        assert!(status.success(), "v2 升级失败");
        assert_eq!(std::fs::read(install.join("Demo.exe")).unwrap(), b"v2");
        assert_eq!(std::fs::read(install.join("same.dll")).unwrap(), b"same");
        assert_eq!(std::fs::read(install.join("new.dll")).unwrap(), b"new");
        assert!(
            !install.join("old.txt").exists(),
            "旧文件应被 [InstallDelete] 清理"
        );

        // 卸载：Inno 会把 v2 的卸载日志追加到 v1 的日志上，
        // 所以 v1 装的 same.dll 也必须被 v2 的卸载器删掉。
        let unins = install.join("unins000.exe");
        assert!(unins.is_file(), "应生成卸载程序");
        let status = std::process::Command::new(&unins)
            .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
            .status()
            .expect("无法启动卸载程序");
        assert!(status.success(), "卸载失败");
        for _ in 0..50 {
            if !install.join("Demo.exe").exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(!install.join("Demo.exe").exists(), "卸载后主程序应被删除");
        assert!(!install.join("new.dll").exists(), "卸载后新增文件应被删除");
        assert!(
            !install.join("same.dll").exists(),
            "卸载日志应包含 v1 安装的未变化文件"
        );

        // 先让 Guard 跑卸载器清掉 HKCU 卸载项，再删整个临时目录。
        drop(_guard);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn compile(
        dir: &Path,
        project: &Project,
        artifact: &str,
        baseline: &str,
        entries: &[DiffEntry],
        name: &str,
    ) -> std::path::PathBuf {
        let template = crate::defaults::package_script(&project.package_options);
        let mut vars = render_vars(project, artifact, baseline, entries);
        vars.extend(crate::template::context(project));
        let rendered = crate::template::render(&template, &vars);
        let path = dir.join(format!("{name}.iss"));
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(rendered.as_bytes());
        std::fs::write(&path, bytes).unwrap();

        let iscc = Path::new(r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe");
        let status = std::process::Command::new(iscc)
            .arg(&path)
            .current_dir(dir)
            .status()
            .expect("无法启动 ISCC");
        assert!(status.success(), "{name} 编译失败");

        let label = if artifact == UPGRADE {
            "升级包"
        } else {
            "安装包"
        };
        dir.join("out")
            .join(format!("{}-{label}-{}.exe", project.name, project.version))
    }

    /// 真实 ISCC 编译：验证升级包的 [Code] / [InstallDelete] / 显式 Source 行
    /// 都是合法语法。需要本机安装 Inno Setup 6，所以标成 ignored。
    #[test]
    #[ignore = "需要本机安装 Inno Setup 6（ISCC）"]
    fn real_iscc_compiles_full_and_upgrade_scripts() {
        let iscc = Path::new(r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe");
        if !iscc.is_file() {
            eprintln!("跳过：未找到 ISCC");
            return;
        }

        let dir = std::env::temp_dir().join("sealpack-iscc-upgrade");
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src");
        let out = dir.join("out");
        std::fs::create_dir_all(src.join("lib")).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(src.join("Demo.exe"), b"exe").unwrap();
        std::fs::write(src.join("lib").join("a.dll"), b"a").unwrap();
        std::fs::write(src.join("old.txt"), b"old").unwrap();

        let isl = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/isl/ChineseSimplified.isl");
        std::fs::copy(&isl, dir.join("ChineseSimplified.isl")).unwrap();

        let mut p = project();
        p.root_path = src.to_string_lossy().to_string();
        p.exe_file = src.join("Demo.exe").to_string_lossy().to_string();
        p.output_dir = out.to_string_lossy().to_string();
        p.version = "1.2.0".into();
        p.package_options.app_id = "11111111-2222-3333-4444-555555555555".into();
        p.package_options.encryption = "no".into();
        p.package_options.checksum = "none".into();

        let entries = vec![
            entry("Demo.exe", "modified", 3),
            entry("lib\\a.dll", "new", 1),
            entry("old.txt", "deleted", 3),
        ];

        for (artifact, baseline) in [(INSTALLER, ""), (UPGRADE, "1.1.0")] {
            let template = crate::defaults::package_script(&p.package_options);
            let mut vars = render_vars(&p, artifact, baseline, &entries);
            vars.extend(crate::template::context(&p));
            let rendered = crate::template::render(&template, &vars);
            let path = dir.join(format!("{artifact}.iss"));
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(rendered.as_bytes());
            std::fs::write(&path, bytes).unwrap();

            let status = std::process::Command::new(iscc)
                .arg(&path)
                .current_dir(&dir)
                .status()
                .expect("无法启动 ISCC");
            assert!(
                status.success(),
                "{artifact} 脚本编译失败：{}",
                path.display()
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
