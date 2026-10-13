use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use tauri::Manager;

use crate::model::{Project, ProjectList};
use crate::settings::Settings;

/// 应用级路径与运行期状态
#[derive(Clone)]
pub struct AppState {
    /// 工程配置目录
    pub projects_dir: PathBuf,
    /// 阶段执行时产生的临时文件目录
    pub work_root: PathBuf,
    /// 外部工具链目录（应用内置，装到 Program Files 时为只读）
    pub tools_dir: PathBuf,
    /// 自动下载的工具落点（用户级目录，始终可写）
    pub user_tools_dir: PathBuf,
    /// 随应用分发的 Inno Setup 语言包目录（官方发行版不含中文，见其中的 README）
    pub isl_dir: PathBuf,
    /// 全局设置文件
    pub settings_file: PathBuf,
}

impl AppState {
    pub fn resolve(app: &tauri::AppHandle) -> Result<Self> {
        let data_dir = app.path().app_data_dir().context("无法定位应用数据目录")?;

        let projects_dir = data_dir.join("projects");
        let work_root = data_dir.join("work");
        std::fs::create_dir_all(&projects_dir)
            .with_context(|| format!("无法创建目录 {}", projects_dir.display()))?;
        std::fs::create_dir_all(&work_root)
            .with_context(|| format!("无法创建目录 {}", work_root.display()))?;

        // 上次异常退出（强杀 / 断电）留下的临时目录里可能还有明文口令，
        // 启动时顺手清掉超过 24 小时的。
        clean_stale_work(&work_root);

        // 资源目录：打包后位于 resource_dir，开发期回退到 CARGO_MANIFEST_DIR
        let resource_dir = app.path().resource_dir().context("无法定位资源目录")?;

        Ok(Self {
            projects_dir: strip_verbatim(projects_dir),
            work_root: strip_verbatim(work_root),
            tools_dir: strip_verbatim(locate_dir(&resource_dir, "tools")),
            // 内置目录随应用分发，正式安装后位于 Program Files，普通用户没有写权限。
            // 所以自动下载的工具统一落到用户数据目录，与内置目录分开。
            user_tools_dir: strip_verbatim(data_dir.join("tools")),
            isl_dir: strip_verbatim(locate_dir(&resource_dir, "isl")),
            settings_file: strip_verbatim(data_dir.join("settings.json")),
        })
    }

    pub fn settings(&self) -> Settings {
        Settings::load(&self.settings_file)
    }

    /// 下载到的原始包存放处。放在 work 下，与临时文件同处，清理 work 时一并带走。
    pub fn download_cache(&self) -> PathBuf {
        self.work_root.join("downloads")
    }
}

/// 依次尝试若干候选位置，返回第一个存在的目录
fn locate_dir(resource_dir: &Path, name: &str) -> PathBuf {
    let candidates = [
        resource_dir.join(name),
        resource_dir.join("resources").join(name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(name),
    ];
    candidates
        .iter()
        .find(|p| p.is_dir())
        .cloned()
        .unwrap_or_else(|| resource_dir.join(name))
}

/// Windows 上 Tauri 返回的目录常带 `\\?\` 前缀（verbatim / extended-length path）。
/// 这类前缀对系统 API 合法，但显示给用户、或作为参数传给外部 CLI 时会显得怪异，
/// 个别程序甚至不认。去掉它，转回普通 `D:\…` / `\\server\share` 形式。
/// 这些目录都是英文短路径，去掉前缀不会触发 260 字符的长度限制。
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    let without = raw
        .strip_prefix("\\\\?\\")
        .map(|rest| {
            // \\?\UNC\server\share → \\server\share
            rest.strip_prefix("UNC\\")
                .map(|s| format!("\\\\{s}"))
                .unwrap_or_else(|| rest.to_string())
        })
        .unwrap_or_else(|| raw.to_string());
    PathBuf::from(without)
}

/// 工程 Id 只允许作为安全文件名使用
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        bail!("非法的工程标识：{id}");
    }
    Ok(())
}

pub fn project_file(dir: &Path, id: &str) -> Result<PathBuf> {
    validate_id(id)?;
    Ok(dir.join(format!("{id}.json")))
}

/// 读取全部工程，按名称排序；解析失败的文件单独报出来。
///
/// 早先解析失败是直接 `continue`，那个工程就从列表里消失了，而用户看不到任何
/// 解释 —— 只会在下次打开时发现「工程不见了」。这里把文件名一并返回，由界面告知。
pub fn list_projects(dir: &Path) -> ProjectList {
    let mut projects = Vec::new();
    let mut unreadable = Vec::new();

    let Ok(entries) = std::fs::read_dir(dir) else {
        return ProjectList {
            projects,
            unreadable,
        };
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let parsed = std::fs::read_to_string(&path)
            .map_err(|err| err.to_string())
            .and_then(|text| serde_json::from_str::<Project>(&text).map_err(|err| err.to_string()));

        match parsed {
            Ok(project) => projects.push(project),
            Err(_) => unreadable.push(name),
        }
    }

    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    ProjectList {
        projects,
        unreadable,
    }
}

/// 清理临时工作目录里陈旧的工程子目录，返回删掉的个数。
///
/// 阶段执行会在 `work/<project-id>/` 下写临时文件（加密配置与打包脚本里可能带
/// 明文口令）。正常路径会删除它们，但进程被强杀 / 断电时会残留 —— 而 work 目录
/// 此前从不清理，于是明文口令会一直躺在磁盘上。
///
/// 只删超过 24 小时的：本程序没有单实例锁，正在运行的另一个实例可能还在用它。
/// `downloads/` 是工具包缓存，不是临时文件，跳过。
pub fn clean_stale_work(root: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(24 * 3600))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|n| n.to_str()) == Some("downloads") || !path.is_dir() {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        if modified >= cutoff {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed += 1,
            // GUI 进程没有控制台，这条只在开发时看得到；关键是不要静默失败到
            // 「以为清干净了、其实没有」的地步
            Err(err) => eprintln!("清理工作目录 {} 失败：{err}", path.display()),
        }
    }
    removed
}

pub fn load_project(dir: &Path, id: &str) -> Result<Project> {
    let file = project_file(dir, id)?;
    let text = std::fs::read_to_string(&file)
        .with_context(|| format!("无法读取工程文件 {}", file.display()))?;
    let project = serde_json::from_str(&text).context("工程文件格式不正确")?;
    Ok(project)
}

pub fn save_project(dir: &Path, project: &Project) -> Result<()> {
    let file = project_file(dir, &project.id)?;
    let text = serde_json::to_string_pretty(project).context("序列化工程失败")?;
    std::fs::write(&file, text).with_context(|| format!("无法写入 {}", file.display()))?;
    Ok(())
}

pub fn delete_project(dir: &Path, id: &str) -> Result<()> {
    let file = project_file(dir, id)?;
    if file.exists() {
        std::fs::remove_file(&file).with_context(|| format!("无法删除 {}", file.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EncryptOptions, PackageOptions};

    fn sample_project(id: &str, name: &str) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            root_path: r"D:\App".into(),
            exe_file: r"D:\App\t.exe".into(),
            output_dir: r"D:\Out".into(),
            password: String::new(),
            version: "1.0.0.0".into(),
            merge_dlls: Vec::new(),
            exclude_paths: Vec::new(),
            encrypt_options: EncryptOptions::default(),
            package_options: PackageOptions::default(),
            encrypt_config: String::new(),
            package_script: String::new(),
        }
    }

    /// 去掉 Windows 的 `\\?\` verbatim 前缀；UNC 形式要转回普通共享路径。
    #[test]
    fn strip_verbatim_normalizes_paths() {
        assert_eq!(
            strip_verbatim(PathBuf::from(
                r"\\?\D:\Codespace\SealPack\tools\ILMerge\ILMerge.exe"
            )),
            PathBuf::from(r"D:\Codespace\SealPack\tools\ILMerge\ILMerge.exe"),
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\tools\ISCC.exe")),
            PathBuf::from(r"\\server\share\tools\ISCC.exe"),
        );
        // 本来就是普通路径，原样返回
        assert_eq!(
            strip_verbatim(PathBuf::from(r"C:\Program Files\SealPack\tools")),
            PathBuf::from(r"C:\Program Files\SealPack\tools"),
        );
    }

    /// 工程 Id 只允许安全文件名，防止 `../` 之类的路径穿越
    #[test]
    fn project_id_is_validated() {
        assert!(validate_id("11111111-2222-3333-4444-555555555555").is_ok());
        assert!(validate_id("../evil").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("").is_err());
    }

    /// 读不出来的工程文件要报给界面，而不是让工程从列表里静默消失
    #[test]
    fn list_projects_reports_unreadable_files() {
        let dir = std::env::temp_dir().join("sealpack-list-projects");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        save_project(&dir, &sample_project("b-id", "Beta")).unwrap();
        save_project(&dir, &sample_project("a-id", "alpha")).unwrap();
        std::fs::write(dir.join("broken.json"), "{ 这不是 json").unwrap();
        // 非 json 后缀的文件不该被当成工程
        std::fs::write(dir.join("readme.txt"), b"x").unwrap();

        let list = list_projects(&dir);
        // 按名称排序（忽略大小写）
        assert_eq!(
            list.projects
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "Beta"]
        );
        assert_eq!(list.unreadable, vec!["broken.json"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只清陈旧目录，别把刚建的（另一个实例可能正在用）和下载缓存清掉
    #[test]
    fn clean_stale_work_keeps_fresh_dirs_and_cache() {
        let dir = std::env::temp_dir().join("sealpack-work-clean");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("downloads")).unwrap();
        std::fs::create_dir_all(dir.join("11111111-2222-3333-4444-555555555555")).unwrap();
        std::fs::write(dir.join("stray.txt"), b"x").unwrap();

        // 都是刚建的，一个都不该删
        assert_eq!(clean_stale_work(&dir), 0);
        assert!(dir.join("downloads").is_dir());
        assert!(dir.join("11111111-2222-3333-4444-555555555555").is_dir());
        assert!(dir.join("stray.txt").is_file());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
