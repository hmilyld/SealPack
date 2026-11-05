use std::fs;
use std::path::Path;

use crate::model::{relative_to, Project};

/// 一个实际会进入安装包的文件。
///
/// `relative` 使用反斜杠、相对主程序目录，直接用于 manifest 与 Inno 的
/// `Source` / `[InstallDelete]`；`absolute` 用于哈希与读取。
#[derive(Debug, Clone)]
pub struct PackedFile {
    pub relative: String,
    pub absolute: String,
    pub size: u64,
}

/// 打包范围的统计结果：给界面显示「打包 N 个文件 · X MB」，
/// 同时给树表提供被通配符规则命中的路径。
#[derive(Debug, Default, Clone)]
pub struct PackPlan {
    pub packed_count: usize,
    pub packed_bytes: u64,
    pub excluded_count: usize,
    pub truncated: bool,
    pub rule_matched: Vec<String>,
    /// 完整包实际包含的文件清单（升级差异要用；统计接口忽略它）。
    pub files: Vec<PackedFile>,
}

const WALK_BUDGET: usize = 20_000;

/// 统计主程序目录下实际会进入安装包的文件。
///
/// 语义必须与 `defaults.rs::package_script` 里的
/// `Source: "{root}\*"; Excludes: "..."` 保持一致：
///   · 主程序始终打包（脚本里单独列了一条 `[Files]`）；
///   · 自动项（合并程序集、`.bakup`、根目录内的输出目录）排除；
///   · 自定义项支持相对路径与 Inno 通配符（`*` / `?`）。
pub fn plan(project: &Project) -> PackPlan {
    let root = Path::new(&project.root_path);
    if !root.is_dir() {
        return PackPlan::default();
    }

    let auto = project.auto_ignores();
    let custom = project.custom_ignores();
    let mut plan = PackPlan::default();
    let mut budget = WALK_BUDGET;

    walk(
        root,
        &project.root_path,
        &project.exe_file,
        &auto,
        &custom,
        &mut plan,
        &mut budget,
    );
    plan
}

fn walk(
    dir: &Path,
    root: &str,
    exe_file: &str,
    auto: &[String],
    custom: &[String],
    plan: &mut PackPlan,
    budget: &mut usize,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|entry| entry.file_name());

    for entry in items {
        if *budget == 0 {
            plan.truncated = true;
            return;
        }
        *budget -= 1;

        let path = entry.path();
        let full = path.to_string_lossy().to_string();
        let relative = relative_to(root, &full);
        let is_main = full.eq_ignore_ascii_case(exe_file);

        if !is_main {
            let auto_hit = auto.iter().find(|pattern| matches(&relative, pattern));
            let custom_hit = custom.iter().find(|pattern| matches(&relative, pattern));

            if auto_hit.is_some() || custom_hit.is_some() {
                if path.is_dir() {
                    count_excluded(&path, plan);
                } else {
                    plan.excluded_count += 1;
                    if custom_hit.is_some_and(|pattern| is_rule(pattern)) {
                        plan.rule_matched.push(relative);
                    }
                }
                continue;
            }
        }

        if path.is_dir() {
            walk(&path, root, exe_file, auto, custom, plan, budget);
        } else {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            plan.packed_count += 1;
            plan.packed_bytes += size;
            plan.files.push(PackedFile {
                relative,
                absolute: full,
                size,
            });
        }
    }
}

/// 被整目录规则命中时，递归数出里面有多少文件（只用于计数，不参与打包）。
fn count_excluded(dir: &Path, plan: &mut PackPlan) {
    let mut budget = WALK_BUDGET;
    count_excluded_inner(dir, plan, &mut budget);
}

fn count_excluded_inner(dir: &Path, plan: &mut PackPlan, budget: &mut usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            plan.truncated = true;
            return;
        }
        *budget -= 1;
        let path = entry.path();
        if path.is_dir() {
            count_excluded_inner(&path, plan, budget);
        } else {
            plan.excluded_count += 1;
        }
    }
}

fn is_rule(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?')
}

/// Inno `Excludes` 的近似匹配：
///   · 含 `\` 的规则匹配完整相对路径，否则匹配文件名；
///   · `*` 匹配任意字符（包括 `\`），`?` 匹配单个字符；
///   · Windows 路径大小写不敏感。
pub fn matches(relative: &str, pattern: &str) -> bool {
    let relative = relative.replace('/', "\\").to_lowercase();
    let pattern = pattern.replace('/', "\\").to_lowercase();
    if pattern.is_empty() {
        return false;
    }

    let target = if pattern.contains('\\') {
        relative.as_str()
    } else {
        relative.rsplit('\\').next().unwrap_or(relative.as_str())
    };

    glob_match(pattern.as_bytes(), target.as_bytes())
}

fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    let mut p = 0;
    let mut t = 0;
    let mut star: Option<usize> = None;
    let mut mark = 0;

    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            mark = t;
        } else if let Some(star_pos) = star {
            p = star_pos + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }

    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BuildOptions, EncryptOptions, PackageOptions};

    fn project(root: &Path) -> Project {
        Project {
            id: "test".into(),
            name: "test".into(),
            root_path: root.to_string_lossy().to_string(),
            exe_file: root.join("app.exe").to_string_lossy().to_string(),
            output_dir: root.join("out").to_string_lossy().to_string(),
            password: String::new(),
            version: "1.0.0".into(),
            merge_dlls: vec![root.join("lib.dll").to_string_lossy().to_string()],
            exclude_paths: vec!["*.md".into()],
            encrypt_options: EncryptOptions::default(),
            package_options: PackageOptions::default(),
            encrypt_config: String::new(),
            package_script: String::new(),
            build_options: BuildOptions::default(),
            schema_version: 3,
            build_history: Vec::new(),
        }
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sealpack-excludes-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("docs")).unwrap();
        fs::create_dir_all(dir.join("out")).unwrap();
        fs::write(dir.join("app.exe"), b"app").unwrap();
        fs::write(dir.join("lib.dll"), b"lib").unwrap();
        fs::write(dir.join("readme.txt"), b"readme").unwrap();
        fs::write(dir.join("docs/a.txt"), b"a").unwrap();
        fs::write(dir.join("docs/b.md"), b"b").unwrap();
        fs::write(dir.join("out/setup.exe"), b"setup").unwrap();
        dir
    }

    #[test]
    fn plan_counts_packed_and_excluded_files() {
        let dir = fixture("counts");
        let plan = plan(&project(&dir));

        assert_eq!(plan.packed_count, 3, "app.exe + readme.txt + docs/a.txt");
        assert_eq!(
            plan.excluded_count, 3,
            "lib.dll + docs/b.md + out/setup.exe"
        );
        assert!(!plan.truncated);
        assert_eq!(plan.rule_matched, vec!["docs\\b.md"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_dir_inside_root_is_auto_excluded() {
        let dir = fixture("output");
        let project = project(&dir);
        let auto = project.auto_ignores();
        assert!(auto.iter().any(|item| item == "out\\*"), "{auto:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_dir_equal_root_is_not_excluded() {
        let dir = fixture("equal");
        let mut project = project(&dir);
        project.output_dir = project.root_path.clone();
        assert!(project.output_dir_ignore().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_matches_folder_and_file_patterns() {
        assert!(matches("docs\\a.txt", "docs\\*"));
        assert!(matches("docs\\sub\\a.txt", "docs\\*"));
        assert!(!matches("docs", "docs\\*"));
        assert!(matches("docs\\b.md", "*.md"));
        assert!(matches("a.pdb", "*.pdb"));
        assert!(matches("a.pdb", "a.?db"));
        assert!(!matches("a.pdbx", "*.pdb"));
    }
}
