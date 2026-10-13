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

// ---------------------------------------------------------------- 版本号探测

#[cfg(windows)]
fn detect_version(path: &str) -> Option<String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };

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

        let sub: Vec<u16> = "\\".encode_utf16().chain(std::iter::once(0)).collect();
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len: u32 = 0;
        if VerQueryValueW(
            buffer.as_ptr() as *const c_void,
            sub.as_ptr(),
            &mut ptr,
            &mut len,
        ) == 0
        {
            return None;
        }
        // VS_FIXEDFILEINFO 至少需要 24 字节才能取到 ProductVersion
        if ptr.is_null() || len < 24 {
            return None;
        }

        let base = ptr as *const u32;
        let ms = *base.add(4);
        let ls = *base.add(5);
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
}

#[cfg(not(windows))]
fn detect_version(_path: &str) -> Option<String> {
    None
}
