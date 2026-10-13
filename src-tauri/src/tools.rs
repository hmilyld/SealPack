use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::download;
use crate::model::{ToolDownloadInfo, ToolInfo, ToolStatus};
use crate::settings::Settings;

/// 一个内置工具的规格
pub struct ToolSpec {
    pub key: &'static str,
    pub label: &'static str,
    /// 相对内置 tools 目录的路径
    pub relative: &'static str,
    /// 是否依赖 .NET Framework 运行时
    pub needs_dotnet: bool,
}

pub const TOOL_SPECS: [ToolSpec; 3] = [
    ToolSpec {
        key: "ilmerge",
        label: "ILMerge",
        relative: "ILMerge/ILMerge.exe",
        needs_dotnet: true,
    },
    ToolSpec {
        key: "confuser",
        label: "ConfuserEx",
        relative: "ConfuserEx/Confuser.CLI.exe",
        needs_dotnet: true,
    },
    ToolSpec {
        key: "iscc",
        label: "Inno Setup",
        relative: "Inno/ISCC.exe",
        needs_dotnet: false,
    },
];

pub fn spec_of(key: &str) -> Option<&'static ToolSpec> {
    TOOL_SPECS.iter().find(|s| s.key == key)
}

/// 内置工具在应用资源目录中的默认路径
pub fn default_path(tools_dir: &Path, spec: &ToolSpec) -> PathBuf {
    let mut path = tools_dir.to_path_buf();
    for segment in spec.relative.split('/') {
        path.push(segment);
    }
    path
}

/// 解析用户填写的路径。既接受可执行文件本身，也接受它所在的目录。
fn resolve_override(value: &str, fallback: &Path) -> Option<PathBuf> {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_dir() {
        // 传目录时自动补上默认文件名
        if let Some(name) = fallback.file_name() {
            return Some(path.join(name));
        }
    }
    Some(path)
}

/// 生效路径的来源
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// 用户在设置里指定的路径
    Custom,
    /// 随应用分发的内置工具
    Bundled,
    /// 自动下载到用户目录的工具
    Downloaded,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Custom => "custom",
            Origin::Bundled => "bundled",
            Origin::Downloaded => "downloaded",
        }
    }
}

/// 一个工具的定位结果
struct Located {
    /// 实际生效的路径
    path: PathBuf,
    origin: Origin,
    /// 随应用分发的内置路径（无论是否生效，都要报给界面当占位提示）
    bundled: PathBuf,
    overridden: bool,
}

/// 三级回退：用户指定的路径 → 应用内置 → 下载目录。
///
/// 第三级是必需的。应用装在 `Program Files` 下时内置目录是只读的，
/// 自动下载的工具只能落在用户目录里，而 `default_path` 描述的是内置位置 ——
/// 少了这一级，下载成功之后界面依然会显示「未找到」。
fn locate(
    spec: &ToolSpec,
    bundled_dir: &Path,
    download_dir: &Path,
    settings: &Settings,
) -> Located {
    let bundled = default_path(bundled_dir, spec);
    let custom = resolve_override(settings.override_for(spec.key), &bundled);

    if let Some(path) = custom {
        return Located {
            path,
            origin: Origin::Custom,
            bundled,
            overridden: true,
        };
    }

    if bundled.is_file() {
        return Located {
            path: bundled.clone(),
            origin: Origin::Bundled,
            bundled,
            overridden: false,
        };
    }

    let downloaded = default_path(download_dir, spec);
    if downloaded.is_file() {
        return Located {
            path: downloaded,
            origin: Origin::Downloaded,
            bundled,
            overridden: false,
        };
    }

    // 哪儿都没有：报内置路径，让「未找到」的提示指向随应用分发的位置
    Located {
        path: bundled.clone(),
        origin: Origin::Bundled,
        bundled,
        overridden: false,
    }
}

/// 三个外部命令行工具的最终定位结果
#[derive(Debug, Clone)]
pub struct Toolchain {
    pub ilmerge: PathBuf,
    pub confuser: PathBuf,
    pub iscc: PathBuf,
}

impl Toolchain {
    /// 三个外部命令行工具的最终定位结果。
    ///
    /// 返回 `Result` 而不是在内部 `expect`：`panic = "abort"` 的 release 配置下，
    /// 一次未来的重构失误会直接终止进程，而不是给出一条可读的错误。
    pub fn resolve(bundled_dir: &Path, download_dir: &Path, settings: &Settings) -> Result<Self> {
        let pick = |key: &str| -> Result<PathBuf> {
            let spec = spec_of(key).with_context(|| format!("内置工具定义缺失：{key}"))?;
            Ok(locate(spec, bundled_dir, download_dir, settings).path)
        };

        Ok(Self {
            ilmerge: pick("ilmerge")?,
            confuser: pick("confuser")?,
            iscc: pick("iscc")?,
        })
    }
}

/// 本机可能已经装了一份工具的位置。
///
/// 只有 Inno Setup 需要这一条，而且它不是锦上添花：官方只发安装程序、安装还要管理员授权，
/// 而 Inno Setup 是很多 Windows 开发机上现成就有的工具。能检测到就直接用，
/// 用户既不用下载 10 MB，也不用在 UAC 上点一次。
///
/// 之所以按「列目录找版本号最高的一份」而不是写死某个路径：安装版本会变
/// （6.x / 7.x 并存很常见），且 32 位、64 位、per-user 三种安装位置都可能出现。
fn system_candidates(spec: &ToolSpec) -> Vec<PathBuf> {
    if spec.key != "iscc" {
        return Vec::new();
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Ok(value) = std::env::var(var) {
            if !value.is_empty() {
                roots.push(PathBuf::from(value));
            }
        }
    }
    // per-user 安装落在 %LOCALAPPDATA%\Programs
    if let Ok(value) = std::env::var("LOCALAPPDATA") {
        if !value.is_empty() {
            roots.push(PathBuf::from(value).join("Programs"));
        }
    }

    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for root in roots {
        // Inno Setup 6 / Inno Setup 7
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(rest) = name.strip_prefix("Inno Setup ") else {
                    continue;
                };
                let version = match rest.split(|c: char| !c.is_ascii_digit()).next() {
                    Some(v) if !v.is_empty() => v.to_string(),
                    _ => continue,
                };
                out.push((version, entry.path().join("ISCC.exe")));
            }
        }
    }

    // 版本高的排前面：与其让用户装了两份还指着旧的那份，不如先试新的
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, path)| path).collect()
}

fn system_path_string(path: PathBuf) -> Option<String> {
    if path.is_file() {
        Some(path.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 汇总三个工具的可用状态，供设置界面展示
pub fn status(
    bundled_dir: &Path,
    download_dir: &Path,
    cache_dir: &Path,
    settings: &Settings,
) -> ToolStatus {
    let items = TOOL_SPECS
        .iter()
        .map(|spec| {
            let found = locate(spec, bundled_dir, download_dir, settings);
            let download = download::source_of(spec.key).map(|source| ToolDownloadInfo {
                version: source.version.to_string(),
                size: source.size,
                origin: source.origin.to_string(),
                note: source.note.to_string(),
                cached: download::is_cached(cache_dir, source),
                system_path: system_candidates(spec)
                    .into_iter()
                    .find_map(system_path_string),
            });

            ToolInfo {
                key: spec.key.to_string(),
                label: spec.label.to_string(),
                path: found.path.to_string_lossy().to_string(),
                default_path: found.bundled.to_string_lossy().to_string(),
                available: found.path.is_file(),
                overridden: found.overridden,
                needs_dotnet: spec.needs_dotnet,
                origin: found.origin.as_str().to_string(),
                download,
            }
        })
        .collect();

    ToolStatus {
        tools_dir: bundled_dir.to_string_lossy().to_string(),
        download_dir: download_dir.to_string_lossy().to_string(),
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Inno Setup 的探测要能找到本机已装的那份：装它要管理员授权，
    /// 而 Inno Setup 在很多开发机上是现成的 —— 找到它，用户既不用下载也不用点 UAC。
    /// 这条测试在当前开发机上应当是能找到的；CI 上找不到也不算失败，只是说明没装。
    #[test]
    fn detects_installed_innosetup() {
        let spec = spec_of("iscc").unwrap();
        let candidates = system_candidates(spec);
        let found = candidates.iter().find(|p| p.is_file());
        println!("候选：{candidates:?}\n命中：{found:?}");
        assert!(
            !candidates.is_empty(),
            "一个候选都没构造出来，说明安装位置的枚举漏了"
        );
    }

    /// 两个压缩包工具没有标准安装位置，不该构造出一堆假候选
    #[test]
    fn zip_tools_have_no_system_candidates() {
        for key in ["ilmerge", "confuser"] {
            let spec = spec_of(key).unwrap();
            assert!(
                system_candidates(spec).is_empty(),
                "{key} 不该有本机安装位置的候选"
            );
        }
    }

    /// 三级回退：自定义 > 内置 > 下载目录
    #[test]
    fn resolve_falls_back_bundled_then_downloaded() {
        let dir = std::env::temp_dir().join("sealpack-tools-resolve");
        let _ = std::fs::remove_dir_all(&dir);
        let bundled = dir.join("bundled");
        let downloaded = dir.join("downloaded");
        let cache = dir.join("cache");
        std::fs::create_dir_all(bundled.join("Inno")).unwrap();
        std::fs::create_dir_all(downloaded.join("Inno")).unwrap();

        let iscc_of = |s: &ToolStatus| s.items.iter().find(|i| i.key == "iscc").unwrap().clone();

        // 默认（未自定义）情况下三级依次尝试
        let settings = Settings::default();

        // 只有下载目录有 → 用下载目录
        std::fs::write(downloaded.join("Inno").join("ISCC.exe"), b"x").unwrap();
        assert_eq!(
            Toolchain::resolve(&bundled, &downloaded, &settings)
                .unwrap()
                .iscc,
            downloaded.join("Inno").join("ISCC.exe")
        );
        let s = status(&bundled, &downloaded, &cache, &settings);
        assert_eq!(iscc_of(&s).origin, "downloaded");
        assert!(iscc_of(&s).available);

        // 内置也有 → 内置优先
        std::fs::write(bundled.join("Inno").join("ISCC.exe"), b"x").unwrap();
        assert_eq!(
            Toolchain::resolve(&bundled, &downloaded, &settings)
                .unwrap()
                .iscc,
            bundled.join("Inno").join("ISCC.exe")
        );

        // 自定义路径优先级最高，即使它指向的文件并不存在
        // （报一个「未找到」出来，而不是静默回退 —— 否则用户永远不知道自己配错了）
        let settings = Settings {
            iscc_path: r"D:\Custom\ISCC.exe".to_string(),
            ..Settings::default()
        };
        assert_eq!(
            Toolchain::resolve(&bundled, &downloaded, &settings)
                .unwrap()
                .iscc,
            PathBuf::from(r"D:\Custom\ISCC.exe")
        );
        let s = status(&bundled, &downloaded, &cache, &settings);
        assert_eq!(iscc_of(&s).origin, "custom");
        assert!(iscc_of(&s).overridden);
        assert!(!iscc_of(&s).available);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
