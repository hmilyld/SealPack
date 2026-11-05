//! 升级基线清单：记录一次安装包实际包含的文件与摘要。
//!
//! 升级包的唯一事实来源是「上一次安装后的完整状态」。本模块负责：
//!   · 打包成功后写 manifest（相对路径 + 大小 + SHA-256）；
//!   · 读取 manifest / 旧版本目录，计算新增 / 修改 / 未变 / 删除；
//!   · 给界面和预检提供一份只读的差异计划。
//!
//! 差异只看文件内容哈希，不看修改时间：复制、解压、时区都不会造成误判。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::excludes;
use crate::hash;
use crate::model::{relative_to, Project};

const MANIFEST_PREFIX: &str = "sealpack-manifest-";
const MANIFEST_FORMAT: u32 = 1;

/// 一个被打进安装包的文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    /// 相对主程序目录，使用反斜杠。
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// 一次安装包构建后的完整安装状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub app_id: String,
    pub app_name: String,
    pub version: String,
    /// Unix 秒。不引入 chrono，前端自己格式化。
    pub created_at: u64,
    pub require_admin: bool,
    pub packaging_mode: String,
    pub uninstallable: bool,
    pub files: Vec<ManifestFile>,
}

/// 给界面展示的基线摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSummary {
    pub path: String,
    pub app_id: String,
    pub app_name: String,
    pub version: String,
    pub created_at: u64,
    pub file_count: usize,
    pub total_bytes: u64,
    pub require_admin: bool,
    pub packaging_mode: String,
    pub uninstallable: bool,
    /// manifest | directory
    pub source: String,
}

/// 一个文件的差异状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub path: String,
    /// new | modified | unchanged | deleted
    pub status: String,
    pub size: u64,
    pub old_size: u64,
}

/// 打包页 / 预检用的升级计划。`error` 非空表示不能生成升级包。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradePlan {
    pub artifact: String,
    pub baseline: Option<ManifestSummary>,
    pub candidates: Vec<ManifestSummary>,
    pub files: Vec<DiffEntry>,
    pub new_count: usize,
    pub modified_count: usize,
    pub unchanged_count: usize,
    pub deleted_count: usize,
    /// 新增 + 修改文件的总字节数，也就是升级包大致要压的内容。
    pub total_bytes: u64,
    pub truncated: bool,
    pub error: String,
    pub warnings: Vec<String>,
}

struct Baseline {
    summary: ManifestSummary,
    files: BTreeMap<String, ManifestFile>,
}

/// 应用标识的有效值：选项为空时回退到工程 ID，与 `template::context` 保持一致。
pub fn effective_app_id(project: &Project) -> String {
    let id = project.package_options.app_id.trim();
    if id.is_empty() {
        project.id.clone()
    } else {
        id.to_string()
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// 版本号会进文件名；Windows 不允许 `<>:"/\|?*` 和控制字符。
fn sanitize_version(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim_matches(|ch| ch == '.' || ch == ' ');
    if trimmed.is_empty() {
        "unknown".into()
    } else {
        trimmed.to_string()
    }
}

pub fn manifest_path(output_dir: &str, version: &str) -> PathBuf {
    Path::new(output_dir).join(format!(
        "{MANIFEST_PREFIX}{}.json",
        sanitize_version(version)
    ))
}

/// 写入 manifest。先写临时文件再替换，避免取消 / 崩溃留下半截 JSON。
pub fn write_manifest(project: &Project, files: &[ManifestFile]) -> Result<PathBuf> {
    if project.output_dir.trim().is_empty() {
        bail!("未设置输出目录，无法写入基线清单");
    }
    let mut sorted = files.to_vec();
    sorted.sort_by_key(|a| a.path.to_lowercase());

    let manifest = Manifest {
        format: MANIFEST_FORMAT,
        app_id: effective_app_id(project),
        app_name: project.name.clone(),
        version: project.version.clone(),
        created_at: now_secs(),
        require_admin: project.package_options.require_admin,
        packaging_mode: project.package_options.packaging_mode.clone(),
        uninstallable: project.package_options.uninstallable,
        files: sorted,
    };

    let path = manifest_path(&project.output_dir, &project.version);
    let bytes = serde_json::to_vec_pretty(&manifest).context("序列化基线清单失败")?;
    write_atomic(&path, &bytes)?;
    Ok(path)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("无法创建目录 {}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).with_context(|| format!("无法写入 {}", tmp.display()))?;
    // Windows 的 rename 不能覆盖已存在文件，先删再换；失败时清理临时文件。
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            Err(err).with_context(|| format!("无法替换 {}", path.display()))
        }
    }
}

/// 读取并校验 manifest。工程外的路径、`..`、非法哈希都拒绝。
pub fn read_manifest(path: &Path) -> Result<Manifest> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("无法读取基线清单 {}", path.display()))?;
    let manifest: Manifest = serde_json::from_str(&text)
        .with_context(|| format!("基线清单格式不正确：{}", path.display()))?;

    if manifest.format == 0 || manifest.format > MANIFEST_FORMAT {
        bail!(
            "基线清单版本 {} 不受支持（当前支持 {}）",
            manifest.format,
            MANIFEST_FORMAT
        );
    }
    for file in &manifest.files {
        validate_relative(&file.path)?;
        if file.sha256.len() != 64 || !file.sha256.chars().all(|ch| ch.is_ascii_hexdigit()) {
            bail!("基线清单里的摘要无效：{}", file.path);
        }
    }
    Ok(manifest)
}

fn validate_relative(path: &str) -> Result<()> {
    let normalized = path.replace('/', "\\");
    if normalized.trim().is_empty() {
        bail!("基线清单包含空路径");
    }
    if normalized.starts_with('\\') || Path::new(&normalized).is_absolute() {
        bail!("基线清单包含绝对路径：{path}");
    }
    // 相对路径里出现盘符、通配符或控制字符都不可能是真实文件名；
    // 它们会被原样写进 [InstallDelete]，必须挡在读取阶段。
    if normalized
        .chars()
        .any(|ch| matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control())
    {
        bail!("基线清单包含非法路径：{path}");
    }
    for part in normalized.split('\\') {
        if part.is_empty() || part == "." || part == ".." {
            bail!("基线清单包含非法路径：{path}");
        }
    }
    Ok(())
}

fn summarize(manifest: &Manifest, path: &Path) -> ManifestSummary {
    ManifestSummary {
        path: path.to_string_lossy().to_string(),
        app_id: manifest.app_id.clone(),
        app_name: manifest.app_name.clone(),
        version: manifest.version.clone(),
        created_at: manifest.created_at,
        file_count: manifest.files.len(),
        total_bytes: manifest.files.iter().map(|file| file.size).sum(),
        require_admin: manifest.require_admin,
        packaging_mode: manifest.packaging_mode.clone(),
        uninstallable: manifest.uninstallable,
        source: "manifest".into(),
    }
}

fn map_files(files: &[ManifestFile]) -> BTreeMap<String, ManifestFile> {
    let mut map = BTreeMap::new();
    for file in files {
        map.insert(file.path.to_lowercase(), file.clone());
    }
    map
}

/// 输出目录里所有可读的基线清单，新的在前。
pub fn list_candidates(output_dir: &str) -> Vec<ManifestSummary> {
    let dir = Path::new(output_dir);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with(MANIFEST_PREFIX) || !name.ends_with(".json") {
            continue;
        }
        if let Ok(manifest) = read_manifest(&path) {
            out.push(summarize(&manifest, &path));
        }
    }
    out.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.version.cmp(&a.version))
            .then_with(|| a.path.cmp(&b.path))
    });
    out
}

fn read_directory_baseline(
    dir: &Path,
) -> Result<(BTreeMap<String, ManifestFile>, ManifestSummary)> {
    if !dir.is_dir() {
        bail!("基线目录不存在：{}", dir.display());
    }
    let mut files = Vec::new();
    collect_dir_files(dir, dir, &mut files)?;
    if files.is_empty() {
        bail!("基线目录里没有文件：{}", dir.display());
    }
    files.sort_by_key(|a| a.path.to_lowercase());
    let total_bytes = files.iter().map(|file| file.size).sum();
    let summary = ManifestSummary {
        path: dir.to_string_lossy().to_string(),
        app_id: String::new(),
        app_name: String::new(),
        version: String::new(),
        created_at: 0,
        file_count: files.len(),
        total_bytes,
        require_admin: false,
        packaging_mode: String::new(),
        uninstallable: false,
        source: "directory".into(),
    };
    Ok((map_files(&files), summary))
}

fn collect_dir_files(root: &Path, dir: &Path, out: &mut Vec<ManifestFile>) -> Result<()> {
    let entries = std::fs::read_dir(dir).with_context(|| format!("无法读取 {}", dir.display()))?;
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|entry| entry.file_name());
    for entry in items {
        let path = entry.path();
        if path.is_dir() {
            collect_dir_files(root, &path, out)?;
            continue;
        }
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        let relative = relative_to(&root.to_string_lossy(), &path.to_string_lossy());
        let digest = hash::file_digest("sha256", &path)?;
        out.push(ManifestFile {
            path: relative,
            size,
            sha256: digest,
        });
    }
    Ok(())
}

fn resolve_baseline(project: &Project, candidates: &[ManifestSummary]) -> Result<Baseline> {
    let explicit = project.build_options.baseline_path.trim();
    if !explicit.is_empty() {
        let path = Path::new(explicit);
        if path.is_file() {
            let manifest = read_manifest(path)?;
            return Ok(Baseline {
                summary: summarize(&manifest, path),
                files: map_files(&manifest.files),
            });
        }
        if path.is_dir() {
            let (files, summary) = read_directory_baseline(path)?;
            return Ok(Baseline { summary, files });
        }
        bail!("基线不存在：{explicit}");
    }

    let app_id = effective_app_id(project);
    let chosen = candidates
        .iter()
        .find(|item| item.app_id.eq_ignore_ascii_case(&app_id))
        .or_else(|| candidates.first())
        .cloned()
        .with_context(|| "输出目录里没有基线清单；请先打一次完整安装包，或手动选择旧版本目录")?;

    let manifest = read_manifest(Path::new(&chosen.path))?;
    Ok(Baseline {
        summary: chosen,
        files: map_files(&manifest.files),
    })
}

/// 计算当前完整包会包含的文件与摘要。`truncated` 时不要生成升级包。
pub fn collect_current(project: &Project) -> Result<(Vec<ManifestFile>, bool)> {
    let plan = excludes::plan(project);
    if plan.truncated {
        return Ok((Vec::new(), true));
    }

    let mut files = Vec::with_capacity(plan.files.len());
    for file in &plan.files {
        let digest = hash::file_digest("sha256", Path::new(&file.absolute))
            .with_context(|| format!("无法计算文件摘要：{}", file.absolute))?;
        files.push(ManifestFile {
            path: file.relative.clone(),
            size: file.size,
            sha256: digest,
        });
    }
    files.sort_by_key(|a| a.path.to_lowercase());
    Ok((files, false))
}

/// 逐文件比较；基线有、当前没有的算删除。
pub fn diff(current: &[ManifestFile], baseline: &BTreeMap<String, ManifestFile>) -> Vec<DiffEntry> {
    let mut out = Vec::with_capacity(current.len() + baseline.len());
    let mut seen = std::collections::HashSet::new();

    for file in current {
        let key = file.path.to_lowercase();
        seen.insert(key.clone());
        match baseline.get(&key) {
            Some(old) if old.sha256.eq_ignore_ascii_case(&file.sha256) => out.push(DiffEntry {
                path: file.path.clone(),
                status: "unchanged".into(),
                size: file.size,
                old_size: old.size,
            }),
            Some(old) => out.push(DiffEntry {
                path: file.path.clone(),
                status: "modified".into(),
                size: file.size,
                old_size: old.size,
            }),
            None => out.push(DiffEntry {
                path: file.path.clone(),
                status: "new".into(),
                size: file.size,
                old_size: 0,
            }),
        }
    }

    for (key, old) in baseline {
        if seen.contains(key) {
            continue;
        }
        out.push(DiffEntry {
            path: old.path.clone(),
            status: "deleted".into(),
            size: 0,
            old_size: old.size,
        });
    }

    out.sort_by_key(|a| a.path.to_lowercase());
    out
}

fn compare_versions(current: &str, baseline: &str) -> Option<std::cmp::Ordering> {
    let parse = |value: &str| -> Option<Vec<u64>> {
        let trimmed = value.trim().trim_start_matches(['v', 'V']);
        if trimmed.is_empty() {
            return None;
        }
        trimmed
            .split(['.', '-', '+'])
            .map(|part| part.parse::<u64>().ok())
            .collect()
    };
    let mut current = parse(current)?;
    let mut baseline = parse(baseline)?;
    // `1.0` 与 `1.0.0` 视为同一个版本：短的补零再比。
    while current.len() < baseline.len() {
        current.push(0);
    }
    while baseline.len() < current.len() {
        baseline.push(0);
    }
    Some(current.cmp(&baseline))
}

/// 生成一份只读升级计划（自己扫描并哈希当前文件）。`error` 非空表示不能生成升级包。
pub fn plan_upgrade(project: &Project) -> UpgradePlan {
    let mut plan = base_plan(project);
    if !project.build_options.includes_upgrade() {
        return plan;
    }
    if let Some(error) = precheck(project) {
        plan.error = error;
        return plan;
    }
    // 先找基线：找不到就不必白白哈希整个目录。
    let baseline = match resolve_baseline(project, &plan.candidates) {
        Ok(baseline) => baseline,
        Err(err) => {
            plan.error = err.to_string();
            return plan;
        }
    };
    match collect_current(project) {
        Ok((current, truncated)) => fill_plan(&mut plan, project, &current, truncated, baseline),
        Err(err) => plan.error = err.to_string(),
    }
    plan
}

/// 复用已经算好的当前文件清单（打包阶段只需要哈希一次）。
pub fn plan_upgrade_with(
    project: &Project,
    current: &[ManifestFile],
    truncated: bool,
) -> UpgradePlan {
    let mut plan = base_plan(project);
    if !project.build_options.includes_upgrade() {
        return plan;
    }
    if let Some(error) = precheck(project) {
        plan.error = error;
        return plan;
    }
    let baseline = match resolve_baseline(project, &plan.candidates) {
        Ok(baseline) => baseline,
        Err(err) => {
            plan.error = err.to_string();
            return plan;
        }
    };
    fill_plan(&mut plan, project, current, truncated, baseline);
    plan
}

fn base_plan(project: &Project) -> UpgradePlan {
    UpgradePlan {
        artifact: project.build_options.artifact().to_string(),
        candidates: list_candidates(&project.output_dir),
        ..Default::default()
    }
}

fn precheck(project: &Project) -> Option<String> {
    if project.package_options.packaging_mode != "single" {
        return Some("升级包只支持「单文件安装包」；绿色版和多卷安装包请改用完整安装包".into());
    }
    if !project.package_options.uninstallable {
        return Some("升级包需要卸载信息来识别旧版本；请打开「生成卸载程序」".into());
    }
    if project.version.trim().is_empty() {
        return Some("升级包需要版本号来校验目标机器上的旧版本".into());
    }
    None
}

fn fill_plan(
    plan: &mut UpgradePlan,
    project: &Project,
    current: &[ManifestFile],
    truncated: bool,
    baseline: Baseline,
) {
    if truncated {
        plan.truncated = true;
        plan.error = "目录过大，扫描被截断；无法可靠计算升级差异".into();
        return;
    }

    plan.files = diff(current, &baseline.files);
    for file in &plan.files {
        match file.status.as_str() {
            "new" => {
                plan.new_count += 1;
                plan.total_bytes += file.size;
            }
            "modified" => {
                plan.modified_count += 1;
                plan.total_bytes += file.size;
            }
            "deleted" => plan.deleted_count += 1,
            _ => plan.unchanged_count += 1,
        }
    }
    plan.baseline = Some(baseline.summary.clone());

    if baseline.summary.source == "manifest" {
        let app_id = effective_app_id(project);
        if !baseline.summary.app_id.eq_ignore_ascii_case(&app_id) {
            plan.error = format!(
                "基线属于另一个应用（{}），当前是 {}；AppId 不一致会导致并存安装",
                baseline.summary.app_id, app_id
            );
            return;
        }
        if baseline.summary.require_admin != project.package_options.require_admin {
            plan.error =
                "基线与当前工程的安装模式不一致（管理员 / 当前用户）；Inno 会把它当成另一个应用"
                    .into();
            return;
        }
        if baseline.summary.packaging_mode != project.package_options.packaging_mode {
            plan.error = "基线的打包模式与当前工程不一致".into();
            return;
        }
        if baseline.summary.uninstallable != project.package_options.uninstallable {
            plan.error = "基线的卸载设置与当前工程不一致".into();
            return;
        }
        match compare_versions(&project.version, &baseline.summary.version) {
            Some(std::cmp::Ordering::Less) => {
                plan.error = format!(
                    "基线版本 {} 比当前版本 {} 新，不能生成降级包",
                    baseline.summary.version, project.version
                );
                return;
            }
            Some(std::cmp::Ordering::Equal) => plan
                .warnings
                .push("基线与当前版本号相同，这是一次同版本重打包".into()),
            None => plan
                .warnings
                .push("版本号不是纯数字格式，无法比较新旧；请自行确认".into()),
            _ => {}
        }
    } else {
        plan.warnings
            .push("基线是旧版本目录：无法校验应用标识、安装模式和版本号；目录里的文件会被当作旧版本内容，删除项会从目标机器清理，请确认没有用户数据".into());
    }

    if plan.new_count + plan.modified_count == 0 {
        plan.error = "没有需要升级的文件；当前内容与基线一致".into();
    } else if plan.deleted_count > 20 && plan.deleted_count * 2 > baseline.files.len() {
        plan.warnings.push(format!(
            "将删除 {} 个文件（超过基线的 50%），请确认基线没有选错",
            plan.deleted_count
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BuildOptions, EncryptOptions, PackageOptions};

    fn temp_project(name: &str) -> (std::path::PathBuf, std::path::PathBuf, Project) {
        let dir = std::env::temp_dir().join(format!("sealpack-manifest-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src");
        let out = dir.join("out");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(src.join("Demo.exe"), b"exe").unwrap();
        std::fs::write(src.join("same.dll"), b"same").unwrap();
        std::fs::write(src.join("changed.dll"), b"new-content").unwrap();

        let package_options = PackageOptions {
            app_id: "app-1".into(),
            encryption: "no".into(),
            ..Default::default()
        };
        let build_options = BuildOptions {
            artifact: "upgrade".into(),
            ..Default::default()
        };

        let project = Project {
            id: "p".into(),
            name: "Demo".into(),
            root_path: src.to_string_lossy().to_string(),
            exe_file: src.join("Demo.exe").to_string_lossy().to_string(),
            output_dir: out.to_string_lossy().to_string(),
            password: String::new(),
            version: "1.1.0".into(),
            merge_dlls: Vec::new(),
            exclude_paths: Vec::new(),
            encrypt_options: EncryptOptions::default(),
            package_options,
            encrypt_config: String::new(),
            package_script: String::new(),
            build_options,
            schema_version: 3,
            build_history: Vec::new(),
        };
        (dir, src, project)
    }

    fn write_baseline(project: &Project, src: &Path) {
        let same = crate::hash::file_digest("sha256", &src.join("same.dll")).unwrap();
        let old_changed_path = src.join("old-changed.tmp");
        std::fs::write(&old_changed_path, b"old-content").unwrap();
        let old_changed = crate::hash::file_digest("sha256", &old_changed_path).unwrap();
        let _ = std::fs::remove_file(&old_changed_path);

        let manifest = Manifest {
            format: 1,
            app_id: "app-1".into(),
            app_name: "Demo".into(),
            version: "1.0.0".into(),
            created_at: 1,
            require_admin: false,
            packaging_mode: "single".into(),
            uninstallable: true,
            files: vec![
                ManifestFile {
                    path: "same.dll".into(),
                    size: 4,
                    sha256: same,
                },
                ManifestFile {
                    path: "changed.dll".into(),
                    size: 11,
                    sha256: old_changed,
                },
                ManifestFile {
                    path: "old.dll".into(),
                    size: 3,
                    sha256: "a".repeat(64),
                },
            ],
        };
        let path = manifest_path(&project.output_dir, "1.0.0");
        std::fs::write(path, serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
    }

    fn file(path: &str, size: u64, sha: &str) -> ManifestFile {
        ManifestFile {
            path: path.into(),
            size,
            sha256: sha.repeat(64 / sha.len().max(1)),
        }
    }

    #[test]
    fn sanitize_version_removes_windows_invalid_chars() {
        assert_eq!(sanitize_version("1.0.0"), "1.0.0");
        assert_eq!(sanitize_version("v1/2:3"), "v1_2_3");
        assert_eq!(sanitize_version("..."), "unknown");
        assert_eq!(sanitize_version("  1.0  "), "1.0");
    }

    #[test]
    fn diff_classifies_all_four_states() {
        let current = vec![
            file("same.dll", 10, "aa"),
            file("changed.dll", 20, "bb"),
            file("new.dll", 30, "cc"),
        ];
        let baseline = map_files(&[
            file("same.dll", 10, "aa"),
            file("changed.dll", 10, "dd"),
            file("old.dll", 40, "ee"),
        ]);
        let entries = diff(&current, &baseline);
        let status = |path: &str| {
            entries
                .iter()
                .find(|entry| entry.path == path)
                .map(|entry| entry.status.as_str())
                .unwrap()
        };
        assert_eq!(status("same.dll"), "unchanged");
        assert_eq!(status("changed.dll"), "modified");
        assert_eq!(status("new.dll"), "new");
        assert_eq!(status("old.dll"), "deleted");
    }

    #[test]
    fn manifest_rejects_traversal_and_absolute_paths() {
        assert!(validate_relative(r"sub\a.dll").is_ok());
        assert!(validate_relative(r"..\a.dll").is_err());
        assert!(validate_relative(r"C:\a.dll").is_err());
        assert!(validate_relative(r"C:a.dll").is_err());
        assert!(validate_relative(r"a*.dll").is_err());
        assert!(validate_relative(r"\a.dll").is_err());
        assert!(validate_relative("").is_err());
    }

    #[test]
    fn compare_versions_handles_dotted_numbers() {
        assert_eq!(
            compare_versions("1.2.0", "1.1.9"),
            Some(std::cmp::Ordering::Greater)
        );
        assert_eq!(
            compare_versions("1.2.0", "1.2.0"),
            Some(std::cmp::Ordering::Equal)
        );
        assert_eq!(
            compare_versions("1.2.0", "1.10.0"),
            Some(std::cmp::Ordering::Less)
        );
        // 尾部零不改变版本语义
        assert_eq!(
            compare_versions("1.0", "1.0.0"),
            Some(std::cmp::Ordering::Equal)
        );
        assert_eq!(compare_versions("beta", "1.0"), None);
    }

    #[test]
    fn plan_upgrade_uses_manifest_hashes() {
        let (dir, src, project) = temp_project("plan");
        write_baseline(&project, &src);

        let plan = plan_upgrade(&project);
        assert!(plan.error.is_empty(), "{}", plan.error);
        assert_eq!(plan.new_count, 1, "Demo.exe 不在基线里");
        assert_eq!(plan.modified_count, 1, "changed.dll 内容变了");
        assert_eq!(plan.deleted_count, 1, "old.dll 从当前内容里消失");
        assert_eq!(plan.unchanged_count, 1, "same.dll 没变");
        assert_eq!(plan.baseline.as_ref().unwrap().version, "1.0.0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_upgrade_blocks_install_mode_mismatch() {
        let (dir, src, mut project) = temp_project("mode");
        write_baseline(&project, &src);
        project.package_options.require_admin = true;

        let plan = plan_upgrade(&project);
        assert!(plan.error.contains("安装模式"), "{}", plan.error);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_upgrade_blocks_portable_and_missing_baseline() {
        let (dir, _src, mut project) = temp_project("portable");
        project.package_options.packaging_mode = "portable".into();
        let plan = plan_upgrade(&project);
        assert!(plan.error.contains("单文件"), "{}", plan.error);

        project.package_options.packaging_mode = "single".into();
        let plan = plan_upgrade(&project);
        assert!(plan.error.contains("没有基线"), "{}", plan.error);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
