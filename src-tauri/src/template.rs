use crate::model::Project;

/// 占位符统一使用 `${key}` 语法，避免与 Inno Setup 的 `{app}` / `{#define}` 冲突。
pub fn render(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (key, value) in vars {
        out = out.replace(&format!("${{{key}}}"), value);
    }
    out
}

/// 构造模板渲染上下文
pub fn context(project: &Project) -> Vec<(&'static str, String)> {
    vec![
        ("id", project.id.clone()),
        // 应用标识：决定 Inno 把这次安装看成「升级已有应用」还是「另一个新应用」。
        // 留空时退回工程 ID —— 那只是没有主程序时的兜底，不是推荐值：
        // 工程 ID 每个工程都不同，会导致同一个 exe 每次打包都被当成新应用。
        (
            "appId",
            if project.package_options.app_id.trim().is_empty() {
                project.id.clone()
            } else {
                project.package_options.app_id.trim().to_string()
            },
        ),
        ("name", project.name.clone()),
        ("root", project.root_path.clone()),
        ("exe", project.exe_name()),
        ("exe_stem", project.exe_stem()),
        ("exe_path", project.exe_file.clone()),
        ("output", project.output_dir.clone()),
        ("version", project.version.clone()),
        ("password", project.password.clone()),
        ("ignore", project.ignore_list()),
    ]
}

/// 前端占位符面板使用的说明列表
pub fn placeholder_help() -> Vec<(&'static str, &'static str)> {
    vec![
        ("${id}", "工程标识（GUID）"),
        (
            "${appId}",
            "应用标识（AppId）：决定覆盖升级还是全新安装，默认由主程序推导",
        ),
        ("${name}", "工程名称"),
        ("${root}", "主程序所在目录"),
        ("${exe}", "主程序文件名（含扩展名）"),
        ("${exe_stem}", "主程序文件名（不含扩展名）"),
        ("${exe_path}", "主程序完整路径"),
        ("${output}", "安装包输出目录"),
        ("${version}", "版本号"),
        ("${password}", "安装包密码"),
        ("${ignore}", "打包排除项（待合并程序集 + 备份文件）"),
    ]
}
