use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::hash;
use crate::model::{LogEvent, Project, Stage, StageEvent, StageOutcome};
use crate::runtime;
use crate::store::AppState;
use crate::template;
use crate::tools::Toolchain;

const EVENT_LOG: &str = "pipeline:log";
const EVENT_STAGE: &str = "pipeline:stage";

/// 执行一个阶段：合并 / 加密 / 打包
pub async fn run_stage(
    app: &AppHandle,
    state: &AppState,
    project: &Project,
    stage: Stage,
) -> Result<StageOutcome> {
    let toolchain = Toolchain::resolve(&state.tools_dir, &state.user_tools_dir, &state.settings())?;
    let work_dir = state.work_root.join(&project.id);
    std::fs::create_dir_all(&work_dir)
        .with_context(|| format!("无法创建临时目录 {}", work_dir.display()))?;

    emit_stage(app, stage, "running", format!("开始{}", stage.label()));
    emit_system(app, stage, format!("▶ 开始{}", stage.label()));

    // ILMerge 与 ConfuserEx 都是 .NET Framework 程序，缺少运行时会直接启动失败
    if matches!(stage, Stage::Merge | Stage::Encrypt) && !runtime::detect().dotnet_available {
        emit_system(
            app,
            stage,
            format!(
                "⚠ 未检测到 .NET Framework 4.x，{} 可能无法启动。可在「设置」中改用其他工具路径。",
                stage.label()
            ),
        );
    }

    let outcome = match stage {
        Stage::Merge => run_merge(app, project, &toolchain, &work_dir).await,
        Stage::Encrypt => run_encrypt(app, project, &toolchain, &work_dir).await,
        Stage::Package => run_package(app, project, &toolchain, &work_dir, &state.isl_dir).await,
    };

    match &outcome {
        Ok(o) => {
            emit_stage(app, stage, &o.status, o.message.clone());
            let prefix = if o.status == "ok" { "✔" } else { "•" };
            emit_system(app, stage, format!("{prefix} {}", o.message));
        }
        Err(err) => {
            let message = err.to_string();
            emit_stage(app, stage, "failed", message.clone());
            emit_system(app, stage, format!("✘ {message}"));
        }
    }

    outcome
}

// ---------------------------------------------------------------- 三个阶段

async fn run_merge(
    app: &AppHandle,
    project: &Project,
    toolchain: &Toolchain,
    _work_dir: &Path,
) -> Result<StageOutcome> {
    require_exe(project)?;

    if project.merge_dlls.is_empty() {
        return Ok(StageOutcome::skipped(
            Stage::Merge,
            "未勾选需要合并的程序集，已跳过合并",
        ));
    }
    if !toolchain.ilmerge.is_file() {
        bail!("未找到 ILMerge：{}", toolchain.ilmerge.display());
    }

    let backup = backup_once(project)?;
    emit_system(
        app,
        Stage::Merge,
        format!("已备份主程序 → {}", backup.display()),
    );

    // ILMerge /out:<主程序> <主程序> <待合并程序集...>
    let mut args: Vec<String> = vec![format!("/out:{}", project.exe_file)];
    args.push(project.exe_file.clone());
    args.extend(project.merge_dlls.iter().cloned());

    let code = exec_streaming(
        app,
        Stage::Merge,
        &toolchain.ilmerge,
        &args,
        Path::new(&project.root_path),
    )
    .await?;

    if code != 0 {
        return Ok(StageOutcome::failed(
            Stage::Merge,
            Some(code),
            "ILMerge 执行失败，请查看日志",
        ));
    }

    // 合并后原调试符号已失效
    let pdb = Path::new(&project.root_path).join(format!("{}.pdb", project.exe_stem()));
    if pdb.is_file() {
        let _ = std::fs::remove_file(&pdb);
        emit_system(
            app,
            Stage::Merge,
            format!("已清理调试符号 {}", pdb.display()),
        );
    }

    Ok(StageOutcome::ok(
        Stage::Merge,
        format!("合并完成，已并入 {} 个程序集", project.merge_dlls.len()),
        vec![project.exe_file.clone()],
    ))
}

async fn run_encrypt(
    app: &AppHandle,
    project: &Project,
    toolchain: &Toolchain,
    work_dir: &Path,
) -> Result<StageOutcome> {
    require_exe(project)?;

    if project.encrypt_config.trim().is_empty() {
        bail!("加密配置为空，请先填写 ConfuserEx 配置");
    }
    if !toolchain.confuser.is_file() {
        bail!("未找到 ConfuserEx：{}", toolchain.confuser.display());
    }

    let backup = backup_once(project)?;
    emit_system(
        app,
        Stage::Encrypt,
        format!("已备份主程序 → {}", backup.display()),
    );

    let config_path = work_dir.join("encrypt.crproj");
    let rendered = template::render(&project.encrypt_config, &template::context(project));
    std::fs::write(&config_path, rendered).context("无法写入临时加密配置")?;
    emit_system(
        app,
        Stage::Encrypt,
        format!("已生成临时配置 {}", config_path.display()),
    );

    let args = vec!["-n".to_string(), config_path.to_string_lossy().to_string()];
    let code = exec_streaming(
        app,
        Stage::Encrypt,
        &toolchain.confuser,
        &args,
        Path::new(&project.root_path),
    )
    .await?;

    let _ = std::fs::remove_file(&config_path);

    if code != 0 {
        return Ok(StageOutcome::failed(
            Stage::Encrypt,
            Some(code),
            "ConfuserEx 执行失败，请查看日志",
        ));
    }

    Ok(StageOutcome::ok(
        Stage::Encrypt,
        "加密完成",
        vec![project.exe_file.clone()],
    ))
}

async fn run_package(
    app: &AppHandle,
    project: &Project,
    toolchain: &Toolchain,
    work_dir: &Path,
    isl_dir: &Path,
) -> Result<StageOutcome> {
    require_exe(project)?;

    if project.package_script.trim().is_empty() {
        bail!("打包脚本为空，请先填写 Inno Setup 脚本");
    }
    if project.output_dir.trim().is_empty() {
        bail!("未设置安装包输出目录");
    }
    if !toolchain.iscc.is_file() {
        bail!("未找到 Inno Setup 编译器：{}", toolchain.iscc.display());
    }

    std::fs::create_dir_all(&project.output_dir)
        .with_context(|| format!("无法创建输出目录 {}", project.output_dir))?;

    // 语言包必须与脚本同目录 —— 生成的脚本用相对路径引用它，因为简体中文
    // 不在 Inno Setup 的官方发行版里（详见 defaults.rs 的说明）。
    let isl_src = isl_dir.join("ChineseSimplified.isl");
    if !isl_src.is_file() {
        bail!(
            "缺少 Inno Setup 中文语言包：{}\n它是随应用分发的资源，缺失说明安装不完整。",
            isl_src.display()
        );
    }
    let isl_dst = work_dir.join("ChineseSimplified.isl");
    std::fs::copy(&isl_src, &isl_dst)
        .with_context(|| format!("无法把语言包复制到 {}", isl_dst.display()))?;

    let script_path = work_dir.join("package.iss");
    let rendered = template::render(&project.package_script, &template::context(project));
    // Inno Setup 6 支持带 BOM 的 UTF-8 脚本
    write_utf8_bom(&script_path, &rendered)?;
    emit_system(
        app,
        Stage::Package,
        format!("已生成临时脚本 {}", script_path.display()),
    );

    let output_dir = Path::new(&project.output_dir);
    // 打包前先记下产出目录的样子，事后靠它找出「这次新产生/被改写的文件」。
    // 不去猜安装包叫什么名字 —— OutputBaseFilename 是可以被用户手改的。
    let before = snapshot_dir(output_dir);
    let started = build_started_at();

    let args = vec![script_path.to_string_lossy().to_string()];
    let code = exec_streaming(app, Stage::Package, &toolchain.iscc, &args, work_dir).await?;

    let _ = std::fs::remove_file(&script_path);
    let _ = std::fs::remove_file(&isl_dst);

    if code != 0 {
        return Ok(StageOutcome::failed(
            Stage::Package,
            Some(code),
            "Inno Setup 编译失败，请查看日志",
        ));
    }

    let mut artifacts: Vec<String> = changed_files(output_dir, &before, started)
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    if artifacts.is_empty() {
        artifacts.push(project.output_dir.clone());
    }

    // ---- 产出校验清单（哈希）
    //
    // 放在打包之后：这时候才存在「真正要发布给用户的东西」。
    // 注意把上一次的清单排除掉，否则会去哈希一份过期清单。
    let algo = project.package_options.checksum.to_ascii_lowercase();
    if hash::is_enabled(&algo) {
        let files: Vec<PathBuf> = artifacts
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .filter(|p| {
                !p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("checksums-"))
                    .unwrap_or(false)
            })
            .collect();

        if files.is_empty() {
            emit_system(
                app,
                Stage::Package,
                "⚠ 没有找到可校验的产出文件，已跳过校验清单",
            );
        } else {
            let manifest = output_dir.join(format!("checksums-{algo}.txt"));
            match hash::write_manifest(&algo, &files, &manifest) {
                Ok(path) => {
                    emit_system(
                        app,
                        Stage::Package,
                        format!("已生成 {} 校验清单 {}", algo.to_uppercase(), path.display()),
                    );
                    artifacts.push(path.to_string_lossy().to_string());
                }
                Err(err) => emit_system(app, Stage::Package, format!("⚠ 校验清单生成失败：{err}")),
            }
        }
    }

    Ok(StageOutcome::ok(
        Stage::Package,
        "安装包打包完成",
        artifacts,
    ))
}

/// 产出目录的文件快照：路径 → (大小, 修改时间)
type Snapshot = std::collections::HashMap<PathBuf, (u64, Option<SystemTime>)>;

/// 快照 / 差异扫描的深度上限。
/// `OutputDir` 指向某个子目录是合法配置，只扫顶层会漏掉真正的产出。
const SNAPSHOT_MAX_DEPTH: usize = 4;

fn snapshot_dir(dir: &Path) -> Snapshot {
    let mut map = Snapshot::new();
    collect_snapshot(dir, 0, &mut map);
    map
}

fn collect_snapshot(dir: &Path, depth: usize, out: &mut Snapshot) {
    if depth > SNAPSHOT_MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_snapshot(&path, depth + 1, out);
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        out.insert(path, (meta.len(), meta.modified().ok()));
    }
}

/// 本次构建的起始时刻（留 2 秒余量，抵消文件系统时间戳的粒度）。
///
/// 不早于它的文件才算「这次写出来的」。
fn build_started_at() -> SystemTime {
    SystemTime::now()
        .checked_sub(Duration::from_secs(2))
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// 这次打包新产生或内容有变化的文件。
///
/// 两个条件同时满足才算：① 与快照对不上（新增或大小 / 修改时间变了）；
/// ② 修改时间不早于本次构建。只看 ① 的话，构建前就躺在输出目录里的旧产物
/// 只要被动过一下就会被算进来，而校验清单的意义正是「发布物的摘要」——
/// 混进无关文件就失去意义了。
fn changed_files(dir: &Path, before: &Snapshot, started: SystemTime) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_changed(dir, 0, before, started, &mut out);
    out.sort();
    out
}

fn collect_changed(
    dir: &Path,
    depth: usize,
    before: &Snapshot,
    started: SystemTime,
    out: &mut Vec<PathBuf>,
) {
    if depth > SNAPSHOT_MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_changed(&path, depth + 1, before, started, out);
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let now = (meta.len(), meta.modified().ok());
        // 与快照完全一致 → 这次没动过
        if before.get(&path) == Some(&now) {
            continue;
        }
        // 动了，但改动早于本次构建（例如构建前就躺在输出目录里的旧产物）
        let fresh = meta.modified().map(|m| m >= started).unwrap_or(true);
        if fresh {
            out.push(path);
        }
    }
}

// ---------------------------------------------------------------- 辅助

fn require_exe(project: &Project) -> Result<()> {
    if project.exe_file.trim().is_empty() {
        bail!("尚未设置主程序文件");
    }
    if !Path::new(&project.exe_file).is_file() {
        bail!("主程序文件不存在：{}", project.exe_file);
    }
    Ok(())
}

/// 首次执行合并/加密前备份主程序，避免不可逆的原地覆盖
fn backup_once(project: &Project) -> Result<PathBuf> {
    let backup = project.backup_path();
    if !backup.exists() {
        std::fs::copy(&project.exe_file, &backup)
            .with_context(|| format!("备份主程序失败 → {}", backup.display()))?;
    }
    Ok(backup)
}

fn write_utf8_bom(path: &Path, content: &str) -> Result<()> {
    let mut bytes = Vec::with_capacity(content.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(content.as_bytes());
    std::fs::write(path, bytes).with_context(|| format!("无法写入 {}", path.display()))?;
    Ok(())
}

/// 需要在日志里打码的参数名（含分隔符，大小写不敏感）。
///
/// 命令行是会原样打进日志面板的，而这些参数可能带着口令。与其在每个调用点
/// 各自小心，不如在唯一的出口统一遮掉。
///
/// **新增敏感参数时必须同步这张表** —— 只认 `PASSWORD=` 的话，将来加进来的
/// `/SNKEYPASS=` 之类会静默漏出去。
const SECRET_KEYS: &[&str] = &["PASSWORD=", "SNKEYPASS=", "RENAMEPASSWORD=", "KEYPASS="];

fn mask_secret(arg: &str) -> String {
    let upper = arg.to_ascii_uppercase();
    for key in SECRET_KEYS {
        if let Some(pos) = upper.find(key) {
            let prefix = &arg[..pos + key.len()];
            let value = &arg[pos + key.len()..];
            if !value.is_empty() {
                return format!("{prefix}***");
            }
        }
    }
    arg.to_string()
}

/// 启动外部进程并把 stdout / stderr 逐行推送到前端
async fn exec_streaming(
    app: &AppHandle,
    stage: Stage,
    program: &Path,
    args: &[String],
    cwd: &Path,
) -> Result<i32> {
    let shown: Vec<String> = args.iter().map(|a| mask_secret(a)).collect();
    emit_system(
        app,
        stage,
        format!("$ {} {}", program.display(), shown.join(" ")),
    );

    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("无法启动 {}", program.display()))?;

    let stdout = child.stdout.take().context("无法读取子进程输出")?;
    let stderr = child.stderr.take().context("无法读取子进程错误输出")?;

    let out_task = tokio::spawn(stream_lines(app.clone(), stage, stdout, "stdout"));
    let err_task = tokio::spawn(stream_lines(app.clone(), stage, stderr, "stderr"));

    let status = child.wait().await.context("等待子进程结束失败")?;
    let _ = out_task.await;
    let _ = err_task.await;

    Ok(status.code().unwrap_or(-1))
}

async fn stream_lines<R>(app: AppHandle, stage: Stage, reader: R, stream: &'static str)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut segments = BufReader::new(reader).split(b'\n');
    while let Ok(Some(bytes)) = segments.next_segment().await {
        let line = decode_line(&bytes);
        if line.trim().is_empty() {
            continue;
        }
        let _ = app.emit(
            EVENT_LOG,
            LogEvent {
                stage,
                stream: stream.to_string(),
                line,
            },
        );
    }
}

/// 子进程输出可能是 UTF-8，也可能是系统 ANSI（简体中文 Windows 为 GBK）
fn decode_line(bytes: &[u8]) -> String {
    let trimmed = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    match std::str::from_utf8(trimmed) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let (text, _, _) = encoding_rs::GBK.decode(trimmed);
            text.into_owned()
        }
    }
}

fn emit_system(app: &AppHandle, stage: Stage, line: impl Into<String>) {
    let _ = app.emit(
        EVENT_LOG,
        LogEvent {
            stage,
            stream: "system".into(),
            line: line.into(),
        },
    );
}

fn emit_stage(app: &AppHandle, stage: Stage, status: &str, message: impl Into<String>) {
    let _ = app.emit(
        EVENT_STAGE,
        StageEvent {
            stage,
            status: status.into(),
            message: message.into(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 打码表必须覆盖所有已知的口令参数 —— 漏一个就等于把口令原样写进日志面板。
    #[test]
    fn mask_secret_covers_every_known_key() {
        assert_eq!(mask_secret("/PASSWORD=hunter2"), "/PASSWORD=***");
        assert_eq!(mask_secret("password=hunter2"), "password=***");
        assert_eq!(mask_secret("/SNKEYPASS=abc"), "/SNKEYPASS=***");
        assert_eq!(mask_secret("/RENAMEPASSWORD=abc"), "/RENAMEPASSWORD=***");
        assert_eq!(mask_secret("/KEYPASS=abc"), "/KEYPASS=***");

        // 不含口令的参数原样保留
        assert_eq!(mask_secret("/VERYSILENT"), "/VERYSILENT");
        assert_eq!(mask_secret(r"D:/Out/package.iss"), r"D:/Out/package.iss");
        // 键名在但值为空：不动它（免得把残片也改掉）
        assert_eq!(mask_secret("/PASSWORD="), "/PASSWORD=");
        // 多字节值不能因为按字节切片而 panic
        assert_eq!(mask_secret("/PASSWORD=口令"), "/PASSWORD=***");
        assert_eq!(mask_secret("路径"), "路径");
    }

    /// 产出识别：只认「本次新产生」与「本次被改写」的，递归到子目录
    #[test]
    fn changed_files_reports_new_and_rewritten_only() {
        let dir = std::env::temp_dir().join("sealpack-changed-files");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("old.exe"), b"old").unwrap();
        std::fs::write(dir.join("sub").join("nested.txt"), b"nested").unwrap();

        let before = snapshot_dir(&dir);
        let started = build_started_at();

        // 什么都没动 → 一个都不报
        assert!(changed_files(&dir, &before, started).is_empty());

        std::fs::write(dir.join("new.exe"), b"new").unwrap();
        std::fs::write(dir.join("old.exe"), b"rewritten-and-longer").unwrap();
        std::fs::write(dir.join("sub").join("fresh.txt"), b"fresh").unwrap();

        let found: Vec<String> = changed_files(&dir, &before, started)
            .into_iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        // 顶层新增、顶层改写、子目录新增；未动的 nested.txt 不出现
        assert_eq!(found, vec!["new.exe", "old.exe", "fresh.txt"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 早于本次构建就存在的文件，即便与快照对不上（例如被别的程序碰过）也不该算作产出
    #[test]
    fn changed_files_ignores_files_older_than_the_build() {
        let dir = std::env::temp_dir().join("sealpack-changed-files-old");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stale.exe"), b"stale").unwrap();

        // 空快照 + 「构建开始于未来」→ 该文件不是本次构建的产物
        let before = Snapshot::new();
        let started = SystemTime::now() + Duration::from_secs(3600);
        assert!(changed_files(&dir, &before, started).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
