use std::path::Path;

use crate::defaults;
use crate::download;
use crate::excludes;
use crate::manifest::UpgradePlan;
use crate::model::{
    BuildOptions, EncryptOptions, FileNode, IgnorePreview, PackageOptions, PreflightCheck,
    PreflightReport, Project, ProjectList, Stage, StageOutcome, ToolStatus,
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
        build_options: BuildOptions::default(),
        schema_version: 3,
        build_history: Vec::new(),
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
    // 选项是唯一事实源：执行前再对齐一次，避免 150ms 的模板重建还没落地时
    // 把旧模板写进临时脚本。`generated == false` 时 normalize 不会碰手工模板。
    let project = normalize(project);
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
        size: 0,
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
        // 一次 metadata 同时拿 is_dir 与 size，避免每个文件多一次系统调用
        let metadata = entry.metadata().ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

        if is_dir {
            let (children, child_truncated) = build_tree(&path, depth + 1, budget);
            truncated |= child_truncated;
            dirs.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                size: 0,
                children,
                truncated: child_truncated,
            });
        } else {
            files.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                size,
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

/// 主程序版本信息里的 `ProductName`；拿不到就退回文件名。
/// 只用于「智能重命名」预填工程名，不参与 AppId 推导。
#[tauri::command]
pub async fn exe_product_name(path: String) -> Result<String, String> {
    let block = read_version_block(&path);
    if let Some(name) = block
        .as_deref()
        .and_then(|bytes| query_version_string(bytes, "ProductName"))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
    {
        return Ok(name);
    }
    Ok(Path::new(&path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default())
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
    let plan = excludes::plan(&project);
    Ok(IgnorePreview {
        auto: project.auto_ignores(),
        custom: project.custom_ignores(),
        combined: project.ignore_list(),
        packed_count: plan.packed_count,
        packed_bytes: plan.packed_bytes,
        excluded_count: plan.excluded_count,
        truncated: plan.truncated,
        rule_matched: plan.rule_matched,
    })
}

/// 计算升级差异（只读）。会扫描并哈希整个主程序目录，放到阻塞线程。
#[tauri::command]
pub async fn plan_upgrade(project: Project) -> Result<UpgradePlan, String> {
    tokio::task::spawn_blocking(move || crate::manifest::plan_upgrade(&project))
        .await
        .map_err(|err| format!("计算升级差异失败：{err}"))
}

fn check(id: &str, label: &str, status: &str, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        id: id.into(),
        label: label.into(),
        status: status.into(),
        detail: detail.into(),
    }
}

/// 模板里必须出现的占位符。
///
/// 新模板把文件段交给 `${files}`，`${root}` / `${ignore}` 只出现在
/// `packaging.rs` 展开出来的文本里，模板本身不需要包含它们；旧的手工模板
/// 仍然自己写 `Source` 行，才要求 `root` / `ignore`。
fn missing_package_placeholders(script: &str) -> Vec<&'static str> {
    let mut required = vec!["exe", "name", "version", "appId", "output"];
    if !script.contains("${files}") {
        required.push("root");
        required.push("ignore");
    }
    required
        .into_iter()
        .filter(|key| !script.contains(&format!("${{{key}}}")))
        .collect()
}

fn same_path(a: &str, b: &str) -> bool {
    let trim = |value: &str| value.replace('/', "\\").trim_end_matches('\\').to_string();
    trim(a).eq_ignore_ascii_case(&trim(b))
}

/// 构建前预检：只做只读检查与一次输出目录写入探测，不启动任何外部工具。
#[tauri::command]
pub async fn preflight(
    state: tauri::State<'_, AppState>,
    project: Project,
) -> Result<PreflightReport, String> {
    let mut checks = Vec::new();
    let root = Path::new(&project.root_path);

    // ---- 主程序 / 工程信息
    if project.name.trim().is_empty() {
        checks.push(check(
            "name",
            "工程名称",
            "warn",
            "工程名称为空，安装包名称会不好辨认",
        ));
    } else {
        checks.push(check("name", "工程名称", "ok", project.name.clone()));
    }

    if project.exe_file.trim().is_empty() {
        checks.push(check("exe", "主程序", "error", "还没有选择主程序"));
    } else if !Path::new(&project.exe_file).is_file() {
        checks.push(check(
            "exe",
            "主程序",
            "error",
            format!("找不到主程序：{}", project.exe_file),
        ));
    } else {
        checks.push(check("exe", "主程序", "ok", project.exe_file.clone()));
    }

    if !root.is_dir() {
        checks.push(check(
            "root",
            "主程序目录",
            "error",
            format!("目录不存在：{}", project.root_path),
        ));
    } else {
        checks.push(check("root", "主程序目录", "ok", project.root_path.clone()));
    }

    if project.version.trim().is_empty() {
        checks.push(check(
            "version",
            "版本号",
            "warn",
            "版本号为空，安装包文件名与 AppVersion 会缺少版本",
        ));
    } else {
        checks.push(check("version", "版本号", "ok", project.version.clone()));
    }

    if project.package_options.app_id.trim().is_empty() {
        checks.push(check(
            "appId",
            "应用标识",
            "error",
            "AppId 为空，Inno 脚本会生成无效的 AppId",
        ));
    } else {
        checks.push(check(
            "appId",
            "应用标识",
            "ok",
            project.package_options.app_id.clone(),
        ));
    }

    // ---- 输出目录
    if project.output_dir.trim().is_empty() {
        checks.push(check(
            "output",
            "输出目录",
            "error",
            "还没有选择安装包输出目录",
        ));
    } else if same_path(&project.root_path, &project.output_dir) {
        checks.push(check(
            "output",
            "输出目录",
            "error",
            "输出目录不能等于主程序目录；否则无法自动排除构建产物",
        ));
    } else {
        match std::fs::create_dir_all(&project.output_dir) {
            Ok(()) => {
                let probe = Path::new(&project.output_dir).join(".sealpack-write-test");
                match std::fs::write(&probe, b"") {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&probe);
                        if crate::model::is_under(&project.root_path, &project.output_dir) {
                            checks.push(check(
                                "output",
                                "输出目录",
                                "warn",
                                "输出目录在主程序目录内，会自动排除，但仍建议放到外面",
                            ));
                        } else {
                            checks.push(check(
                                "output",
                                "输出目录",
                                "ok",
                                project.output_dir.clone(),
                            ));
                        }
                    }
                    Err(err) => checks.push(check(
                        "output",
                        "输出目录",
                        "error",
                        format!("输出目录不可写：{err}"),
                    )),
                }
            }
            Err(err) => checks.push(check(
                "output",
                "输出目录",
                "error",
                format!("无法创建输出目录：{err}"),
            )),
        }
    }

    // ---- 加密口令
    let encryption = project.package_options.encryption.as_str();
    if encryption != "no" && project.password.trim().is_empty() {
        checks.push(check(
            "password",
            "安装包口令",
            "warn",
            "安装包加密已开启但口令为空，编译或安装时可能失败",
        ));
    } else if encryption == "full" {
        checks.push(check(
            "password",
            "安装包口令",
            "info",
            "full 加密的安装包必须用 安装包.exe /PASSWORD=口令 启动",
        ));
    } else {
        checks.push(check("password", "安装包口令", "ok", "口令设置可用"));
    }

    // ---- 合并项
    if project.merge_dlls.is_empty() {
        checks.push(check(
            "merge",
            "合并项",
            "info",
            "未勾选程序集，合并阶段会自动跳过",
        ));
    } else {
        let missing: Vec<&String> = project
            .merge_dlls
            .iter()
            .filter(|path| !Path::new(path).is_file())
            .collect();
        let outside: Vec<&String> = project
            .merge_dlls
            .iter()
            .filter(|path| !crate::model::is_under(&project.root_path, path))
            .collect();

        if !missing.is_empty() {
            checks.push(check(
                "merge",
                "合并项",
                "error",
                format!("{} 个合并项找不到：{}", missing.len(), missing[0]),
            ));
        } else if !outside.is_empty() {
            checks.push(check(
                "merge",
                "合并项",
                "warn",
                format!("{} 个合并项不在主程序目录内：{}", outside.len(), outside[0]),
            ));
        } else {
            checks.push(check(
                "merge",
                "合并项",
                "ok",
                format!("{} 个程序集将合并进主程序", project.merge_dlls.len()),
            ));
        }
    }

    // ---- 排除项
    let custom = project.custom_ignores();
    let with_comma: Vec<&String> = custom.iter().filter(|item| item.contains(',')).collect();
    let outside: Vec<&String> = custom
        .iter()
        .filter(|item| !item.contains('*') && !item.contains('?'))
        .filter(|item| !crate::model::is_under(&project.root_path, item))
        .collect();
    if !with_comma.is_empty() {
        checks.push(check(
            "excludes",
            "排除项",
            "error",
            "排除项不能包含逗号；Inno 的 Excludes 用逗号分隔多项",
        ));
    } else if !outside.is_empty() {
        checks.push(check(
            "excludes",
            "排除项",
            "warn",
            format!("{} 个排除项不在主程序目录内：{}", outside.len(), outside[0]),
        ));
    } else {
        checks.push(check(
            "excludes",
            "排除项",
            "ok",
            format!("{} 项自定义排除", custom.len()),
        ));
    }

    // ---- 模板占位符
    let missing = missing_package_placeholders(&project.package_script);
    if project.package_script.trim().is_empty() {
        checks.push(check("template", "打包脚本", "error", "打包脚本为空"));
    } else if !missing.is_empty() {
        checks.push(check(
            "template",
            "打包脚本",
            "error",
            format!("脚本缺少占位符：{}", missing.join(", ")),
        ));
    } else {
        checks.push(check("template", "打包脚本", "ok", "必需占位符完整"));
    }

    // ---- 升级包
    if project.build_options.includes_upgrade() {
        let plan_project = project.clone();
        let plan =
            tokio::task::spawn_blocking(move || crate::manifest::plan_upgrade(&plan_project))
                .await
                .map_err(|err| format!("计算升级差异失败：{err}"))?;

        if !plan.error.is_empty() {
            checks.push(check("upgrade", "升级包", "error", plan.error));
        } else if let Some(baseline) = &plan.baseline {
            let version = if baseline.version.trim().is_empty() {
                "旧版本目录".to_string()
            } else {
                baseline.version.clone()
            };
            checks.push(check(
                "upgrade",
                "升级包",
                "ok",
                format!(
                    "基线 {} · 新增 {} / 修改 {} / 删除 {} / 未变 {}",
                    version,
                    plan.new_count,
                    plan.modified_count,
                    plan.deleted_count,
                    plan.unchanged_count
                ),
            ));
        }
        for warning in &plan.warnings {
            checks.push(check("upgrade:warn", "升级包", "warn", warning.clone()));
        }

        // 升级模式必须有的占位符：文件段、删除段、零向导指令、基线校验、输出名。
        let upgrade_required = [
            "files",
            "artifactSetup",
            "artifactCode",
            "artifactLabel",
            "baselineVersion",
        ];
        let upgrade_missing: Vec<&str> = upgrade_required
            .iter()
            .copied()
            .filter(|key| !project.package_script.contains(&format!("${{{key}}}")))
            .collect();
        if !upgrade_missing.is_empty() {
            checks.push(check(
                "upgrade:template",
                "升级模板",
                "error",
                format!(
                    "脚本缺少占位符：{}；请点「重新生成」或补上",
                    upgrade_missing.join(", ")
                ),
            ));
        } else {
            checks.push(check(
                "upgrade:template",
                "升级模板",
                "ok",
                "升级占位符完整",
            ));
        }
        if !project.package_script.contains("${installDelete}") {
            checks.push(check(
                "upgrade:delete",
                "升级清理",
                "warn",
                "脚本缺少 ${installDelete}，旧版本残留文件不会被删除",
            ));
        }
        if !project.package_script.contains("${runSection}") {
            checks.push(check(
                "upgrade:run",
                "升级启动项",
                "warn",
                "脚本缺少 ${runSection}，升级包可能仍会显示安装后启动项",
            ));
        }
    }

    if project.encrypt_config.trim().is_empty() {
        checks.push(check(
            "encryptConfig",
            "加密配置",
            "warn",
            "加密配置为空，加密阶段会失败",
        ));
    } else {
        checks.push(check("encryptConfig", "加密配置", "ok", "配置已生成"));
    }

    // ---- 工具链与运行时
    let merge_runs = !project.merge_dlls.is_empty();
    let encrypt_runs = !project.encrypt_options.enabled_protections().is_empty();

    match tools::Toolchain::resolve(&state.tools_dir, &state.user_tools_dir, &state.settings()) {
        Ok(toolchain) => {
            if merge_runs && !toolchain.ilmerge.is_file() {
                checks.push(check("tool:ilmerge", "ILMerge", "error", "找不到 ILMerge"));
            } else if merge_runs {
                checks.push(check(
                    "tool:ilmerge",
                    "ILMerge",
                    "ok",
                    toolchain.ilmerge.display().to_string(),
                ));
            }
            if encrypt_runs && !toolchain.confuser.is_file() {
                checks.push(check(
                    "tool:confuser",
                    "ConfuserEx",
                    "error",
                    "找不到 ConfuserEx",
                ));
            } else if encrypt_runs {
                checks.push(check(
                    "tool:confuser",
                    "ConfuserEx",
                    "ok",
                    toolchain.confuser.display().to_string(),
                ));
            }
            if !toolchain.iscc.is_file() {
                checks.push(check("tool:iscc", "Inno Setup", "error", "找不到 ISCC"));
            } else {
                checks.push(check(
                    "tool:iscc",
                    "Inno Setup",
                    "ok",
                    toolchain.iscc.display().to_string(),
                ));
            }
        }
        Err(err) => checks.push(check("tool", "工具链", "error", err.to_string())),
    }

    if (merge_runs || encrypt_runs) && !runtime::detect().dotnet_available {
        checks.push(check(
            "dotnet",
            ".NET Framework",
            "warn",
            "未检测到 .NET Framework 4.x；ILMerge / ConfuserEx 可能无法启动",
        ));
    }

    Ok(PreflightReport::new(checks))
}

/// 取消当前正在执行的阶段：置标志并杀掉进程树。
#[tauri::command]
pub async fn cancel_build(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.cancel.cancel();
    if let Some(pid) = state.cancel.pid() {
        crate::store::kill_process_tree(pid);
    }
    Ok(())
}

/// 把运行日志写到用户选择的位置（UTF-8 with BOM，记事本可直接看中文）。
#[tauri::command]
pub async fn save_log(path: String, content: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("无法创建目录 {}：{err}", parent.display()))?;
    }

    let mut data = Vec::with_capacity(content.len() + 3);
    data.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    data.extend_from_slice(content.as_bytes());
    std::fs::write(&target, data).map_err(|err| format!("无法写入日志 {}：{err}", target.display()))
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

    #[tokio::test]
    async fn exe_product_name_falls_back_to_file_stem() {
        let dir = std::env::temp_dir().join("sealpack-product-name");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("Standalone.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        let name = exe_product_name(exe.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(name, "Standalone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 新模板用 ${files} 展开文件段，root / ignore 不在模板文本里，
    /// 预检不能因此误报「缺少 root」。
    #[test]
    fn generated_package_script_needs_no_root_in_template() {
        let script = crate::defaults::package_script(&PackageOptions::default());
        assert!(script.contains("${files}"), "{script}");
        assert!(
            missing_package_placeholders(&script).is_empty(),
            "{:?}",
            missing_package_placeholders(&script)
        );
    }

    /// 旧的手工模板自己写 [Files]，root / ignore 仍然是必需的。
    #[test]
    fn old_package_template_still_requires_root_and_ignore() {
        let script = "#define MyAppName \"${name}\"\n\
#define MyAppVersion \"${version}\"\n\
#define MyAppExeName \"${exe}\"\n\
AppId={{${appId}}\n\
OutputDir=${output}\n\
[Files]\n\
Source: \"${exe}\"; DestDir: \"{app}\"\n";
        let missing = missing_package_placeholders(script);
        assert!(missing.contains(&"root"), "{missing:?}");
        assert!(missing.contains(&"ignore"), "{missing:?}");
    }
}
