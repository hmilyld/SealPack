use std::path::Path;

use crate::defaults;
use crate::download;
use crate::model::{
    EncryptOptions, FileNode, IgnorePreview, PackageOptions, Project, ProjectList, Stage,
    StageOutcome, ToolStatus,
};
use crate::pipeline;
use crate::runtime::{self, RuntimeStatus};
use crate::settings::Settings;
use crate::store::{self, AppState};
use crate::template;
use crate::tools;

fn to_err<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

// ---------------------------------------------------------------- 工程管理

/// 把「选项」与「模板」两个表示对齐。
///
/// 选项与模板是同一件事的两种表示：`generated == true` 表示模板由选项生成，
/// 此时以选项为准重新生成，保证两者不会漂移；`generated == false` 表示用户在
/// 高级区手工改过模板，以模板为准，一个字都不动。
fn normalize(mut project: Project) -> Project {
    if project.encrypt_options.generated {
        project.encrypt_config = defaults::encrypt_config(&project.encrypt_options);
    }
    if project.package_options.generated {
        project.package_script = defaults::package_script(&project.package_options);
    }
    project
}

#[tauri::command]
pub async fn list_projects(state: tauri::State<'_, AppState>) -> Result<ProjectList, String> {
    let list = store::list_projects(&state.projects_dir);
    Ok(ProjectList {
        projects: list.projects.into_iter().map(normalize).collect(),
        unreadable: list.unreadable,
    })
}

#[tauri::command]
pub async fn load_project(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Project, String> {
    store::load_project(&state.projects_dir, &id)
        .map(normalize)
        .map_err(to_err)
}

#[tauri::command]
pub async fn create_project(
    state: tauri::State<'_, AppState>,
    name: String,
    exe_file: String,
    output_dir: String,
) -> Result<Project, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("工程名称不能为空".into());
    }
    if !Path::new(&exe_file).is_file() {
        return Err(format!("主程序文件不存在：{exe_file}"));
    }

    // 输出目录在这里就落一次地：不校验的话，问题要拖到打包阶段才暴露
    // （而且那时用户已经在等编译了）。create_dir_all 对已存在的目录是幂等的。
    let output_dir = output_dir.trim().to_string();
    if output_dir.is_empty() {
        return Err("安装包输出目录不能为空".into());
    }
    std::fs::create_dir_all(&output_dir)
        .map_err(|err| format!("无法创建输出目录 {output_dir}：{err}"))?;

    let root_path = Path::new(&exe_file)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        root_path,
        exe_file: exe_file.clone(),
        output_dir,
        password: String::new(),
        version: detect_version(&exe_file).unwrap_or_default(),
        merge_dlls: Vec::new(),
        exclude_paths: Vec::new(),
        encrypt_options: EncryptOptions::default(),
        package_options: PackageOptions::default(),
        encrypt_config: defaults::encrypt_config(&EncryptOptions::default()),
        package_script: defaults::package_script(&PackageOptions::default()),
    };

    store::save_project(&state.projects_dir, &project).map_err(to_err)?;
    Ok(project)
}

#[tauri::command]
pub async fn save_project(
    state: tauri::State<'_, AppState>,
    project: Project,
) -> Result<(), String> {
    store::save_project(&state.projects_dir, &project).map_err(to_err)
}

#[tauri::command]
pub async fn delete_project(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    store::delete_project(&state.projects_dir, &id).map_err(to_err)
}

// ---------------------------------------------------------------- 执行阶段

#[tauri::command]
pub async fn run_stage(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project: Project,
    stage: Stage,
) -> Result<StageOutcome, String> {
    let state = state.inner().clone();
    store::save_project(&state.projects_dir, &project).map_err(to_err)?;
    pipeline::run_stage(&app, &state, &project, stage)
        .await
        .map_err(to_err)
}

// ---------------------------------------------------------------- 资源与探测

#[tauri::command]
pub async fn scan_tree(root: String) -> Result<FileNode, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("目录不存在：{root}"));
    }
    let mut budget: usize = 8000;
    let (children, truncated) = build_tree(root_path, 0, &mut budget);
    Ok(FileNode {
        name: root_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| root.clone()),
        path: root,
        is_dir: true,
        children,
        truncated,
    })
}

/// 递归构建目录树，返回 (子节点, 是否因预算/深度上限而漏掉了内容)。
///
/// 预算与深度上限是为了防止在 `node_modules` 这类巨型目录上把界面卡死；
/// 但「漏掉了内容」必须如实上报 —— 早先是静默截断，界面上看起来就像
/// 那些文件真的不存在。
fn build_tree(dir: &Path, depth: usize, budget: &mut usize) -> (Vec<FileNode>, bool) {
    if depth > 6 {
        // 深度上限：更深的内容没有收录
        return (Vec::new(), true);
    }
    if *budget == 0 {
        return (Vec::new(), true);
    }

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut truncated = false;

    let Ok(entries) = std::fs::read_dir(dir) else {
        return (Vec::new(), false);
    };

    for entry in entries.flatten() {
        if *budget == 0 {
            truncated = true;
            break;
        }
        *budget -= 1;

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();

        if is_dir {
            let (children, child_truncated) = build_tree(&path, depth + 1, budget);
            truncated |= child_truncated;
            dirs.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                children,
                truncated: child_truncated,
            });
        } else {
            files.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                children: Vec::new(),
                truncated: false,
            });
        }
    }

    dirs.sort_by_key(|n| n.name.to_lowercase());
    files.sort_by_key(|n| n.name.to_lowercase());
    dirs.extend(files);
    (dirs, truncated)
}

#[tauri::command]
pub async fn exe_version(path: String) -> Result<String, String> {
    Ok(detect_version(&path).unwrap_or_default())
}

#[tauri::command]
pub async fn tool_status(state: tauri::State<'_, AppState>) -> Result<ToolStatus, String> {
    Ok(tool_status_of(&state))
}

/// 汇总三个工具的定位与下载信息。
///
/// 下载完成后也要走这里，界面才能拿到「路径变了、状态变了」的结果 ——
/// 所以抽出来而不是内联在命令里。
fn tool_status_of(state: &AppState) -> ToolStatus {
    let settings = state.settings();
    tools::status(
        &state.tools_dir,
        &state.user_tools_dir,
        &state.download_cache(),
        &settings,
    )
}

/// 下载并安装一个外部工具。
///
/// 进度通过 `tools:progress` 事件推送；命令本身要等到装完才返回，
/// 返回值是刷新后的工具状态，界面拿到后可以直接就地更新那一行。
#[tauri::command]
pub async fn download_tool(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<ToolStatus, String> {
    let state = state.inner().clone();
    download::install(
        Some(&app),
        &state.user_tools_dir,
        &state.download_cache(),
        &key,
    )
    .await
    .map_err(to_err)?;

    Ok(tool_status_of(&state))
}

// ---------------------------------------------------------------- 设置与环境

#[tauri::command]
pub async fn get_settings(state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings())
}

#[tauri::command]
pub async fn save_settings(
    state: tauri::State<'_, AppState>,
    settings: Settings,
) -> Result<ToolStatus, String> {
    settings.save(&state.settings_file).map_err(to_err)?;
    Ok(tool_status_of(&state))
}

#[tauri::command]
pub async fn environment_status() -> Result<RuntimeStatus, String> {
    Ok(runtime::detect())
}

/// 由界面上的开关生成加密配置。
/// 放在 Rust 侧而不是前端，是为了让模板只有一份定义 —— 前端只负责收集开关。
#[tauri::command]
pub async fn render_encrypt_config(options: EncryptOptions) -> Result<String, String> {
    Ok(defaults::encrypt_config(&options))
}

#[tauri::command]
pub async fn render_package_script(options: PackageOptions) -> Result<String, String> {
    Ok(defaults::package_script(&options))
}

/// 打包排除项的预览：自动项 / 自定义项 / 最终 Excludes 字符串。
#[tauri::command]
pub async fn project_ignores(project: Project) -> Result<IgnorePreview, String> {
    Ok(IgnorePreview {
        auto: project.auto_ignores(),
        custom: project.custom_ignores(),
        combined: project.ignore_list(),
    })
}

#[tauri::command]
pub async fn placeholders() -> Result<Vec<(String, String)>, String> {
    Ok(template::placeholder_help()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect())
}

// ---------------------------------------------------------------- 主程序信息探测

/// 读出可执行文件的版本资源块（`GetFileVersionInfo` 的原始字节）。
///
/// 版本号与「应用标识」都要从这里取，所以抽出来共用一份 WinAPI 样板。
#[cfg(windows)]
fn read_version_block(path: &str) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW};

    if !Path::new(path).is_file() {
        return None;
    }

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut handle: u32 = 0;
        let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
        if size == 0 {
            return None;
        }

        let mut buffer = vec![0u8; size as usize];
        if GetFileVersionInfoW(wide.as_ptr(), 0, size, buffer.as_mut_ptr() as *mut c_void) == 0 {
            return None;
        }
        Some(buffer)
    }
}

#[cfg(windows)]
fn query_bytes(buffer: &[u8], sub: &str) -> Option<(*const std::ffi::c_void, u32)> {
    use std::ffi::c_void;
    use windows_sys::Win32::Storage::FileSystem::VerQueryValueW;

    let sub_w: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
    let mut ptr: *mut c_void = std::ptr::null_mut();
    let mut len: u32 = 0;
    unsafe {
        if VerQueryValueW(
            buffer.as_ptr() as *const c_void,
            sub_w.as_ptr(),
            &mut ptr,
            &mut len,
        ) == 0
            || ptr.is_null()
        {
            return None;
        }
    }
    Some((ptr as *const c_void, len))
}

/// 取版本资源里的一个字符串字段（`ProductName` / `CompanyName` / `OriginalFilename`…）。
///
/// 字符串字段挂在 `\StringFileInfo\<语言><代码页>\` 下面，语言/代码页要先从
/// `\VarFileInfo\Translation` 里问出来。
#[cfg(windows)]
fn query_version_string(buffer: &[u8], field: &str) -> Option<String> {
    let (ptr, len) = query_bytes(buffer, "\\VarFileInfo\\Translation")?;
    if len < 4 {
        return None;
    }
    // 取第一条语言/代码页；多语言资源里通常第一条就是主语言
    let (lang, codepage) = unsafe {
        let words = std::slice::from_raw_parts(ptr as *const u16, 2);
        (words[0], words[1])
    };

    let sub = format!("\\StringFileInfo\\{lang:04x}{codepage:04x}\\{field}");
    let (ptr, len) = query_bytes(buffer, &sub)?;
    let chars = unsafe { std::slice::from_raw_parts(ptr as *const u16, len as usize) };
    let text = String::from_utf16_lossy(chars);
    let text = text.trim_end_matches('\0').trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// 非 Windows 平台上拿不到版本资源：退化成「只用文件名推导」，
/// 仍然确定，只是分辨力差一些（`cargo test` 与 `cargo check` 在别的平台上照样能跑）。
#[cfg(not(windows))]
fn read_version_block(_path: &str) -> Option<Vec<u8>> {
    None
}

/// 由主程序推导一个**稳定**的应用标识（Inno 的 AppId）。
///
/// 为什么不能拿工程 ID 当 AppId：工程 ID 是「新建工程」时随机生成的 UUID，
/// 同一个 exe 换个工程打包就会得到不同的 AppId，Inno 于是把它当成另一个应用，
/// 结果是**全新安装、两个版本并存**，而不是覆盖升级。
///
/// 所以这里从主程序自身的**产品身份**推导：版本信息里的
/// `ProductName` + `CompanyName` + `OriginalFilename`（拿不到就退到文件名）。
/// 这三样都不含版本号与编译日期，因此同一个产品重新编译、重新打包、换台机器打包，
/// 都会得到同一个 AppId。
///
/// 反过来，`ProductName` 或 `CompanyName` 改了就是「换了产品身份」，AppId 会跟着变 ——
/// 这是有意的：那种情况下本来就该当成另一个应用。
pub fn detect_app_id(path: &str) -> String {
    let block = read_version_block(path);

    let pick = |field: &str| -> Option<String> {
        block
            .as_deref()
            .and_then(|b| query_version_string(b, field))
    };

    let stem = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // 全部小写：产品名只改了个大小写不该被当成另一个应用
    app_id_from_identity(&app_identity(
        &pick("ProductName").unwrap_or_default(),
        &pick("CompanyName").unwrap_or_default(),
        &pick("OriginalFilename").unwrap_or_else(|| stem.clone()),
    ))
}

/// 把「产品身份」拼成一个字符串，作为推导 AppId 的输入。
///
/// 抽成独立函数是为了能直接单测：它必须满足「同一份主程序每次结果相同、
/// 不同产品结果不同、只改大小写不算换了产品」。
fn app_identity(product: &str, company: &str, original: &str) -> String {
    // 用 \x1f 分隔，避免「A B」+「C」与「A」+「B C」撞成同一个身份
    format!(
        "{}\u{1f}{}\u{1f}{}",
        product.trim().to_lowercase(),
        company.trim().to_lowercase(),
        original.trim().to_lowercase()
    )
}

/// 把身份字符串确定性地映射成一个 UUIDv5 形状的标识。
///
/// 用哈希而不是直接用产品名：Inno 会把它写进注册表的 `Uninstall\<AppId>_is1`，
/// 产品名里的空格、中文、反斜杠都可能出问题；哈希成 GUID 就没有这些顾虑，
/// 而且一眼能看出「这是个标识」而不是「谁的名字」。
fn app_id_from_identity(identity: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(b"sealpack/app-id/v1\0");
    hasher.update(identity.as_bytes());
    let digest = hasher.finalize();

    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // 摆成合法的 UUIDv5 形状（版本位 = 5、变体位 = 10xx）：
    // 很多工具会校验这两处，随便一段十六进制虽然也能用，但看着不像个标识
    bytes[6] = (bytes[6] & 0x0F) | 0x50;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;

    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// 前端的「选择主程序」会调它，把结果填进打包选项的「应用标识」。
#[tauri::command]
pub async fn exe_app_id(path: String) -> Result<String, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("主程序不存在：{path}"));
    }
    Ok(detect_app_id(&path))
}

#[cfg(windows)]
fn detect_version(path: &str) -> Option<String> {
    let buffer = read_version_block(path)?;
    let (ptr, len) = query_bytes(&buffer, "\\")?;
    // VS_FIXEDFILEINFO 至少需要 24 字节才能取到 ProductVersion
    if len < 24 {
        return None;
    }
    let base = ptr as *const u32;
    let (ms, ls) = unsafe { (*base.add(4), *base.add(5)) };
    if ms == 0 && ls == 0 {
        return None;
    }
    Some(format!(
        "{}.{}.{}.{}",
        ms >> 16,
        ms & 0xFFFF,
        ls >> 16,
        ls & 0xFFFF
    ))
}

#[cfg(not(windows))]
fn detect_version(_path: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一个身份必须每次推导出同一个 AppId。
    ///
    /// 这条是整个「覆盖升级」功能的基石：只要它不稳定，重新打包就会被 Inno
    /// 当成另一个应用，用户看到的就是「全新安装、两个版本并存」。
    #[test]
    fn app_id_is_deterministic() {
        let a = app_id_from_identity("我的工具\u{1f}示例公司\u{1f}tool.exe");
        let b = app_id_from_identity("我的工具\u{1f}示例公司\u{1f}tool.exe");
        assert_eq!(a, b);
    }

    /// 不同产品要得到不同的 AppId，否则两个应用会互相「升级」
    #[test]
    fn app_id_differs_between_products() {
        let a = app_id_from_identity("工具甲\u{1f}公司\u{1f}tool.exe");
        let b = app_id_from_identity("工具乙\u{1f}公司\u{1f}tool.exe");
        let c = app_id_from_identity("工具甲\u{1f}另一家公司\u{1f}tool.exe");
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    /// 形状要像个 UUID：8-4-4-4-12、版本位 5、变体位 8/9/a/b。
    /// 很多工具会校验这两处，随便一段十六进制虽然也能用，但看着不像个标识。
    #[test]
    fn app_id_is_uuid_shaped() {
        let id = app_id_from_identity("x\u{1f}y\u{1f}z.exe");
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5, "{id}");
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12],
            "{id}"
        );
        assert!(
            id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
            "{id}"
        );
        assert!(parts[2].starts_with('5'), "版本位应为 5：{id}");
        assert!(
            matches!(parts[3].chars().next(), Some('8' | '9' | 'a' | 'b')),
            "变体位应为 8/9/a/b：{id}"
        );
    }

    /// 只改大小写、或在两端多打了空格，都不该被当成换了产品
    #[test]
    fn app_identity_normalizes_case_and_padding() {
        assert_eq!(
            app_identity("MyTool", "Acme", "tool.exe"),
            app_identity("  mytool ", "ACME", "Tool.EXE")
        );
    }

    /// 分隔符要真的起作用：不能让字段边界被「串味」
    #[test]
    fn app_identity_does_not_bleed_across_fields() {
        assert_ne!(
            app_identity("a b", "c", "x.exe"),
            app_identity("a", "b c", "x.exe")
        );
    }

    /// 拿不到版本信息时退到文件名，仍然是确定的
    #[test]
    fn app_id_falls_back_to_file_name() {
        let dir = std::env::temp_dir().join("sealpack-appid-test");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("standalone.exe");
        std::fs::write(&exe, b"MZ").unwrap();

        let path = exe.to_string_lossy().to_string();
        let first = detect_app_id(&path);
        let second = detect_app_id(&path);
        assert_eq!(first, second, "同一个文件必须得到同一个 AppId");
        assert_eq!(first.len(), 36, "{first}");

        // 换一个文件名就是另一个身份
        let other = dir.join("another.exe");
        std::fs::write(&other, b"MZ").unwrap();
        assert_ne!(first, detect_app_id(&other.to_string_lossy()));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
