//! 外部工具的自动下载。
//!
//! 三个工具都不是本项目的产物，各有各的分发方式，这里把它们收敛成一份声明：
//!
//! | 工具 | 来源 | 形态 | 包内结构 |
//! |---|---|---|---|
//! | ILMerge | NuGet 官方源 | `.nupkg`（本质是 zip） | 真正的文件在 `tools/net452/` 下 |
//! | ConfuserEx | 作者在 GitHub 的 Release | `.zip` | 扁平，解压即用 |
//! | Inno Setup | 官方 Release | `.exe` 安装程序 | 没有便携包，只能静默安装 |
//!
//! 差异全部落在 [`Layout`] 里，执行流程只有一条：
//! 取包（缓存命中就跳过网络）→ 核对校验值 → 按 `Layout` 铺到目标目录。
//!
//! 关于校验值：三个来源都是不可变的（NuGet 与 GitHub Release 都禁止覆盖同名资产），
//! 所以 `sha256` 可以写死。对不上就说明拿到的东西不是我们预期的那份 —— 与其把来路不明的
//! 二进制装进工具目录，不如直接失败。
//!
//! 关于 Inno Setup 为什么能静默安装：官方安装脚本里写着 `PrivilegesRequiredOverridesAllowed=dialog`，
//! 而 Inno 在设置了该指令后会把自身清单降为 `asInvoker`（已实测确认），因此不需要管理员权限。
//! 再配合它自己的便携模式（`/PORTABLE=1`，官方脚本 `isportable.iss` 里 `Uninstallable=not PortableCheck`），
//! 装完不写注册表、不建快捷方式、不生成卸载项，产物就是工具目录里的一份普通文件。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::hash;
use crate::tools::{spec_of, ToolSpec};

/// 进度事件名
pub const EVENT_PROGRESS: &str = "tools:progress";

/// 下载时带上的 UA。GitHub 与 NuGet 都会拒绝没有 UA 的请求。
const USER_AGENT: &str = concat!("SealPack/", env!("CARGO_PKG_VERSION"));

/// 进度事件的节流步长。逐个 chunk 上报会把事件通道塞满，反而拖慢下载本身。
const PROGRESS_STEP: u64 = 256 * 1024;

/// 进度事件。
///
/// `total == 0` 表示既没有 `Content-Length`、声明的大小也不可用，
/// 前端此时应显示不确定进度而不是 0%。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    pub key: String,
    /// download / verify / extract / install / done
    pub phase: String,
    pub received: u64,
    pub total: u64,
    pub message: String,
}

/// 包内文件如何铺到目标目录
pub enum Layout {
    /// 压缩包：只取该前缀下的文件，去掉前缀后平铺（ILMerge 的 `tools/net452/`）
    ZipUnder(&'static str),
    /// 压缩包：整包平铺（ConfuserEx）
    ZipFlat,
    /// 官方安装程序：静默安装，用 `/DIR=` 直接装进目标目录
    Installer(&'static [&'static str]),
}

pub struct ToolSource {
    pub key: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    /// 期望字节数：给进度条当分母，也让「拿到的是别的东西」在下载前就能看出来
    pub size: u64,
    pub layout: Layout,
    /// 展示给用户的来源名
    pub origin: &'static str,
    /// 面向用户的说明：为什么是这个来源、有什么前置条件
    pub note: &'static str,
    /// 安装/解压失败时补充的一句话。安装类来源需要说清权限，压缩包类没有。
    pub failure_hint: &'static str,
}

pub const SOURCES: [ToolSource; 3] = [
    ToolSource {
        key: "ilmerge",
        version: "3.0.41",
        url: "https://api.nuget.org/v3-flatcontainer/ilmerge/3.0.41/ilmerge.3.0.41.nupkg",
        sha256: "9121fe69cbde20180aff5f7ff0ca18c857c6b6de375ae3fbe48ff189b51f1637",
        size: 346_561,
        layout: Layout::ZipUnder("tools/net452/"),
        origin: "NuGet 官方源",
        note: "ILMerge 必须与同目录的 System.Compiler.dll 一起使用，两者会一并取出。依赖 .NET Framework 运行时。",
        failure_hint: "",
    },
    ToolSource {
        key: "confuser",
        version: "1.6.0",
        url: "https://github.com/mkaring/ConfuserEx/releases/download/v1.6.0/ConfuserEx-CLI.zip",
        sha256: "a00de7cddc740f7edb1baab4c6c9073553dcc88f7e873d15b7fd34ddd33753d7",
        size: 1_943_620,
        layout: Layout::ZipFlat,
        origin: "作者 GitHub 发布页",
        note: "命令行版压缩包，解压即用、不需要安装。依赖 .NET Framework 运行时。",
        failure_hint: "",
    },
    ToolSource {
        key: "iscc",
        version: "6.7.3",
        url: "https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe",
        sha256: "9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732",
        size: 10_592_232,
        layout: Layout::Installer(&[
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            "/SP-",
            "/PORTABLE=1",
            "/NOICONS",
        ]),
        origin: "Inno Setup 官方发布页",
        note: "官方只提供安装程序、没有便携压缩包，装它需要管理员授权（会弹出 UAC）：它的安装脚本没有设置 PrivilegesRequired，默认按「为所有用户安装」处理，且只允许用对话框切换，不接受 /CURRENTUSER 这类命令行开关。装到本程序的工具目录，不写全局注册表。若你不想授权，可直接用手动安装的那一份。",
        failure_hint: "安装 Inno Setup 需要管理员授权。如果刚才没有批准 UAC 提示，可以重试并选择「是」；或者直接使用本机已安装的版本（见下方「使用本机」）。",
    },
];

pub fn source_of(key: &str) -> Option<&'static ToolSource> {
    SOURCES.iter().find(|s| s.key == key)
}

/// 安装类来源的静默参数；压缩包类返回 None。
///
/// 只在测试里用：`SOURCES` 是编译期常量数据，运行时按 `Layout` 直接匹配就够了，
/// 给它专开一个访问器反而是多余的公共面。
#[cfg(test)]
impl ToolSource {
    pub fn installer_args(&self) -> Option<Vec<&'static str>> {
        match self.layout {
            Layout::Installer(args) => Some(args.to_vec()),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------- 并发保护

static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// 同一个工具不允许并发安装。
///
/// 界面在下载期间会禁用按钮，但那只是第一道防线：双击、快捷键、或者后续版本里
/// 多开一个入口，都可能让两次安装同时往一个目录里写，结果是半新半旧的 DLL 混在一起。
/// 与其事后排查，不如在入口处直接拒绝。
struct InFlight(String);

impl InFlight {
    fn enter(key: &str) -> Result<Self> {
        let set = IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()));
        let mut guard = set.lock().map_err(|_| anyhow::anyhow!("内部状态异常"))?;
        if !guard.insert(key.to_string()) {
            bail!("该工具正在下载中，请等待当前任务结束");
        }
        Ok(Self(key.to_string()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Some(set) = IN_FLIGHT.get() {
            if let Ok(mut guard) = set.lock() {
                guard.remove(&self.0);
            }
        }
    }
}

// ---------------------------------------------------------------- 入口

/// 下载并安装一个工具，返回可执行文件的最终路径。
///
/// `tools_dir` 是落点根目录（用户级、始终可写），`cache_dir` 存放下载到的原始包。
/// `app` 是进度事件的出口，传 `None` 表示不推送（单测与调试用）。
pub async fn install(
    app: Option<&AppHandle>,
    tools_dir: &Path,
    cache_dir: &Path,
    key: &str,
) -> Result<PathBuf> {
    let spec = spec_of(key).with_context(|| format!("未知工具：{key}"))?;
    let source = source_of(key).with_context(|| format!("工具 {key} 没有配置下载来源"))?;

    let _guard = InFlight::enter(key)?;

    let target = install_dir(tools_dir, spec);
    std::fs::create_dir_all(&target)
        .with_context(|| format!("无法创建目录 {}", target.display()))?;
    std::fs::create_dir_all(cache_dir)
        .with_context(|| format!("无法创建目录 {}", cache_dir.display()))?;

    let archive = cache_dir.join(archive_name(source.url));

    // 缓存命中就跳过网络。判据是校验值而不是「文件存在」——
    // 半截下载同样能算出哈希，但算不出这个哈希。
    if archive_is_valid(&archive, source) {
        emit(
            app,
            key,
            "download",
            source.size,
            source.size,
            "已命中本地缓存，跳过下载",
        );
    } else {
        // 清掉残留（可能是上次被中断的 .part 改名而来），避免拿它当缓存
        let _ = std::fs::remove_file(&archive);
        download(app, source, &archive).await?;
    }

    match source.layout {
        Layout::ZipUnder(prefix) => {
            emit(app, key, "extract", 0, 0, "正在解压…");
            let count = extract_zip(&archive, prefix, &target)?;
            emit(app, key, "extract", 1, 1, &format!("已解出 {count} 个文件"));
        }
        Layout::ZipFlat => {
            emit(app, key, "extract", 0, 0, "正在解压…");
            let count = extract_zip(&archive, "", &target)?;
            emit(app, key, "extract", 1, 1, &format!("已解出 {count} 个文件"));
        }
        Layout::Installer(args) => {
            emit(
                app,
                key,
                "install",
                0,
                0,
                "正在安装（可能弹出管理员授权，请选择「是」）…",
            );
            run_installer(&archive, args, &target).await.map_err(|err| {
                if source.failure_hint.is_empty() {
                    return err;
                }
                // 把「要管理员授权」这句话接到真实错误后面，而不是各写各的 ——
                // 用户看到「错误码 2」完全不知道该干嘛，看到它才知道该去批准 UAC。
                anyhow::anyhow!(
                    "{err}。{hint}",
                    hint = source.failure_hint
                )
            })?;
        }
    }

    let exe = crate::tools::default_path(tools_dir, spec);
    if !exe.is_file() {
        bail!(
            "下载与安装都已完成，但没有在 {} 找到 {}。请尝试重新下载，或改为手动指定路径。",
            target.display(),
            exe.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
        );
    }

    emit(app, key, "done", 1, 1, &format!("{} 已就绪", spec.label));
    Ok(exe)
}

// ---------------------------------------------------------------- 下载

async fn download(app: Option<&AppHandle>, source: &ToolSource, dest: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .context("无法创建 HTTP 客户端")?;

    let mut resp = client
        .get(source.url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .with_context(|| format!("请求下载地址失败：{}", source.url))?;

    if !resp.status().is_success() {
        bail!(
            "下载失败：服务器返回 HTTP {}（{}）",
            resp.status().as_u16(),
            source.url
        );
    }

    // 没有 Content-Length 时退回声明的大小，至少让进度条有个分母
    let total = resp
        .content_length()
        .filter(|n| *n > 0)
        .unwrap_or(source.size);

    // 先写 .part 再改名：中途失败留下的残片不会污染缓存目录，
    // 也就不会被下次的「缓存命中」判断误认成完整的包。
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("无法写入 {}", tmp.display()))?;

    emit(app, source.key, "download", 0, total, "正在下载…");

    let mut received: u64 = 0;
    let mut reported: u64 = 0;
    loop {
        let chunk = resp.chunk().await.context("下载中断")?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .await
            .with_context(|| format!("写入 {} 失败", tmp.display()))?;
        received += chunk.len() as u64;

        if received - reported >= PROGRESS_STEP {
            reported = received;
            emit(
                app,
                source.key,
                "download",
                received,
                total,
                &format!("正在下载 {} / {}", human(received), human(total)),
            );
        }
    }
    file.flush().await.context("刷新下载文件失败")?;
    drop(file);
    if received != source.size {
        let _ = std::fs::remove_file(&tmp);
        bail!(
            "下载不完整：期望 {} 字节，实际收到 {} 字节。请检查网络后重试。",
            source.size,
            received
        );
    }

    emit(app, source.key, "verify", 0, 0, "正在核对校验值…");
    let digest = hash::file_digest("sha256", &tmp).context("无法计算下载文件的校验值")?;
    if !digest.eq_ignore_ascii_case(source.sha256) {
        let _ = std::fs::remove_file(&tmp);
        bail!(
            "下载文件的校验值不符，已丢弃。\n期望 SHA-256：{}\n实际 SHA-256：{}\n可能是网络中间环节被替换，请稍后重试。",
            source.sha256,
            digest
        );
    }

    tokio::fs::rename(&tmp, dest)
        .await
        .with_context(|| format!("无法保存到 {}", dest.display()))?;
    Ok(())
}

/// 缓存里的包是否可以直接复用
fn archive_is_valid(archive: &Path, source: &ToolSource) -> bool {
    if !archive.is_file() {
        return false;
    }
    // 大小先过一道，省掉大文件的哈希开销
    match std::fs::metadata(archive) {
        Ok(meta) if meta.len() == source.size => {}
        _ => return false,
    }
    hash::file_digest("sha256", archive)
        .map(|d| d.eq_ignore_ascii_case(source.sha256))
        .unwrap_or(false)
}

/// 缓存里是否已经有一份这个包。
///
/// 这里只看大小、不算哈希：它唯一的用途是给界面一个「重新下载会跳过网络」的提示，
/// 而调用它的 `tool_status` 在启动时也会跑一遍 —— 为了一个提示去哈希 10 MB 不值当。
/// 真正决定要不要复用缓存的是 [`archive_is_valid`]，它会把校验值算清楚。
pub fn is_cached(cache_dir: &Path, source: &ToolSource) -> bool {
    std::fs::metadata(cache_dir.join(archive_name(source.url)))
        .map(|meta| meta.len() == source.size)
        .unwrap_or(false)
}

// ---------------------------------------------------------------- 解压

/// 把压缩包铺到目标目录，返回写出的文件数。
///
/// `prefix` 为空表示整包平铺；非空表示只取该前缀下的条目并去掉前缀。
/// 无论哪种，都只取最外层的文件名 —— 目标目录是要被当作工具目录使用的，
/// 包内的目录层级（`tools/net452/`）不该被复制过去。
///
/// 「拍平」是有意为之，代价是包内不同目录下的同名文件会互相覆盖。
/// 这个风险由「来源固定 + SHA-256 固定校验」兜住：拿到的东西一定是我们声明的那份，
/// 不是任意第三方压缩包，所以不存在被构造出恶意重名条目的空间。
fn extract_zip(archive: &Path, prefix: &str, target: &Path) -> Result<usize> {
    let file = std::fs::File::open(archive)
        .with_context(|| format!("无法打开 {}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .context("压缩包格式不正确，可能是下载不完整")?;

    std::fs::create_dir_all(target)
        .with_context(|| format!("无法创建目录 {}", target.display()))?;

    let mut written = 0usize;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .with_context(|| format!("读取压缩包第 {} 个条目失败", index + 1))?;
        if entry.is_dir() {
            continue;
        }

        let name = entry.name().to_string();
        let Some(relative) = name.strip_prefix(prefix) else {
            continue;
        };
        // 取 file_name() 而不是直接拼路径：`..` 与绝对路径会在这一步被消掉，
        // 不存在把文件写到目标目录之外的可能。
        let Some(base) = Path::new(relative)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty() && !s.starts_with('.'))
        else {
            continue;
        };

        let out = target.join(base);
        let mut sink = std::fs::File::create(&out)
            .with_context(|| format!("无法写入 {}", out.display()))?;
        std::io::copy(&mut entry, &mut sink)
            .with_context(|| format!("解压 {name} 失败"))?;
        written += 1;
    }

    if written == 0 {
        bail!("压缩包里没有找到预期的文件（前缀 {prefix:?}），可能来源已变更");
    }
    Ok(written)
}

// ---------------------------------------------------------------- 安装

async fn run_installer(installer: &Path, args: &[&str], target: &Path) -> Result<()> {
    std::fs::create_dir_all(target)
        .with_context(|| format!("无法创建目录 {}", target.display()))?;

    let mut command = tokio::process::Command::new(installer);
    command
        .args(args)
        .arg(format!("/DIR={}", target.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let status = command
        .status()
        .await
        .with_context(|| format!("无法启动安装程序 {}", installer.display()))?;

    if !status.success() {
        bail!(
            "安装程序返回错误码 {}（{}）",
            status.code().unwrap_or(-1),
            installer.display()
        );
    }
    Ok(())
}

// ---------------------------------------------------------------- 辅助

/// 工具的落位目录：`ToolSpec.relative` 的父目录（`Inno/ISCC.exe` → `Inno`）。
/// 压缩包解到这里，安装程序也装到这里。
fn install_dir(root: &Path, spec: &ToolSpec) -> PathBuf {
    match Path::new(spec.relative).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => root.join(parent),
        _ => root.to_path_buf(),
    }
}

/// 从 URL 末段取文件名，并去掉查询串
fn archive_name(url: &str) -> String {
    let tail = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .rsplit('/')
        .next()
        .unwrap_or("");
    if tail.is_empty() {
        "tool.bin".to_string()
    } else {
        tail.to_string()
    }
}

fn human(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let value = bytes as f64;
    if value >= MB {
        format!("{:.1} MB", value / MB)
    } else if value >= KB {
        format!("{:.0} KB", value / KB)
    } else {
        format!("{bytes} B")
    }
}

/// 推送进度事件。
///
/// 收 `Option` 而不是引用：安装流程本身不依赖 Tauri，
/// 少了这个依赖，整条「下载 → 校验 → 解压」链路才能在单测里被真实跑一遍。
fn emit(
    app: Option<&AppHandle>,
    key: &str,
    phase: &str,
    received: u64,
    total: u64,
    message: &str,
) {
    let Some(app) = app else { return };
    let _ = app.emit(
        EVENT_PROGRESS,
        ToolProgress {
            key: key.to_string(),
            phase: phase.to_string(),
            received,
            total,
            message: message.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 声明必须与工具规格一一对应，否则界面上会出现「有按钮但点了报未知工具」的行
    #[test]
    fn every_spec_has_a_source() {
        for spec in crate::tools::TOOL_SPECS.iter() {
            let source = source_of(spec.key)
                .unwrap_or_else(|| panic!("{} 缺少下载来源声明", spec.key));
            assert!(!source.url.is_empty(), "{} 的下载地址为空", spec.key);
            assert_eq!(
                source.sha256.len(),
                64,
                "{} 的 SHA-256 长度不对",
                spec.key
            );
            assert!(source.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(source.size > 0, "{} 的期望大小未填写", spec.key);
            // 落位目录必须与工具规格指向同一处，否则装完仍然「未找到」
            let dir = install_dir(Path::new("T"), spec);
            let exe = crate::tools::default_path(Path::new("T"), spec);
            assert_eq!(dir.join(exe.file_name().unwrap()), exe);
        }
    }

    /// 安装类来源必须说清权限、静默参数也必须是对的。
    ///
    /// Inno Setup 的安装脚本没设 `PrivilegesRequired`（默认「为所有用户安装」= 要管理员），
    /// 且 `PrivilegesRequiredOverridesAllowed` 只写了 `dialog`，所以 `/CURRENTUSER`
    /// 这类命令行开关一律不被接受 —— 上面 SOURCES 里的注释就是这条结论。
    /// 少了 failure_hint，用户只会看到一句「错误码 2」，完全不知道该去批准 UAC。
    #[test]
    fn installer_sources_explain_the_privilege_requirement() {
        let source = source_of("iscc").expect("缺少 iscc 的来源声明");
        let args = source.installer_args().expect("iscc 应声明为安装类来源");

        let has = |needle: &str| args.iter().any(|a| *a == needle);
        assert!(has("/VERYSILENT"), "要静默");
        assert!(has("/SUPPRESSMSGBOXES"), "要抑制提示框");
        assert!(has("/PORTABLE=1"), "便携模式，不写全局注册表");
        assert!(
            !args.iter().any(|a| a.starts_with("/CURRENTUSER")),
            "Inno Setup 的安装器只允许用对话框切换安装模式，不接受 /CURRENTUSER"
        );
        assert!(!source.failure_hint.is_empty(), "iscc 缺少失败时的权限提示");
        assert!(source.note.contains("管理员"), "iscc 的说明要提管理员授权");

        // 压缩包类不许带安装类的权限提示，那是张冠李戴
        for other in SOURCES.iter().filter(|s| s.installer_args().is_none()) {
            assert!(
                other.failure_hint.is_empty(),
                "{} 是压缩包，不该带安装类的权限提示",
                other.key
            );
        }
    }

    #[test]
    fn install_dir_follows_relative_path() {
        let spec = spec_of("iscc").unwrap();
        assert_eq!(install_dir(Path::new("root"), spec), PathBuf::from("root/Inno"));

        let spec = spec_of("ilmerge").unwrap();
        assert_eq!(
            install_dir(Path::new("root"), spec),
            PathBuf::from("root/ILMerge")
        );
    }

    #[test]
    fn archive_name_ignores_query_and_path() {
        assert_eq!(
            archive_name("https://api.nuget.org/v3-flatcontainer/ilmerge/3.0.41/ilmerge.3.0.41.nupkg"),
            "ilmerge.3.0.41.nupkg"
        );
        assert_eq!(
            archive_name("https://example.com/a/b.zip?token=abc#frag"),
            "b.zip"
        );
        assert_eq!(archive_name("https://example.com/"), "tool.bin");
    }

    #[test]
    fn human_reads_naturally() {
        assert_eq!(human(346_561), "338 KB");
        assert_eq!(human(10_592_232), "10.1 MB");
        assert_eq!(human(512), "512 B");
    }

    // ---- 解压：这是整个模块里最容易出错的部分，所以用真实形状的包来测

    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn write_temp(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join("sealpack-download-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// 模拟 ILMerge 的 .nupkg：只取 tools/net452/ 下的两个文件，忽略文档
    #[test]
    fn extracts_only_the_wanted_prefix() {
        let zip = build_zip(&[
            ("ILMerge.nuspec", b"<xml/>"),
            ("docs/ilmerge-manual.md", b"# manual"),
            ("tools/net452/ILMerge.exe", b"MZ-fake-ilmerge"),
            ("tools/net452/System.Compiler.dll", b"MZ-fake-compiler"),
        ]);
        let archive = write_temp("prefix.nupkg", &zip);
        let target = std::env::temp_dir().join("sealpack-download-test/prefix-out");
        let _ = std::fs::remove_dir_all(&target);

        let count = extract_zip(&archive, "tools/net452/", &target).unwrap();
        assert_eq!(count, 2);

        let mut names: Vec<String> = std::fs::read_dir(&target)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["ILMerge.exe", "System.Compiler.dll"]);

        // 目录层级没有被复制过来：工具目录必须是一层平的
        assert!(!target.join("tools").exists());
        assert!(!target.join("docs").exists());
        assert_eq!(
            std::fs::read(target.join("ILMerge.exe")).unwrap(),
            b"MZ-fake-ilmerge"
        );

        let _ = std::fs::remove_dir_all(&target);
    }

    /// 模拟 ConfuserEx 的扁平包：整包平铺
    #[test]
    fn flat_layout_takes_everything() {
        let zip = build_zip(&[
            ("Confuser.CLI.exe", b"MZ"),
            ("Confuser.Core.dll", b"MZ"),
            ("Confuser.CLI.exe.config", b"<config/>"),
        ]);
        let archive = write_temp("flat.zip", &zip);
        let target = std::env::temp_dir().join("sealpack-download-test/flat-out");
        let _ = std::fs::remove_dir_all(&target);

        assert_eq!(extract_zip(&archive, "", &target).unwrap(), 3);
        assert!(target.join("Confuser.CLI.exe").is_file());
        assert!(target.join("Confuser.Core.dll").is_file());

        let _ = std::fs::remove_dir_all(&target);
    }

    /// 包内条目带 `..` 时不能写到目标目录之外
    #[test]
    fn refuses_to_escape_the_target_directory() {
        let zip = build_zip(&[
            ("../../evil.exe", b"MZ"),
            ("Confuser.CLI.exe", b"MZ"),
        ]);
        let archive = write_temp("traversal.zip", &zip);
        let root = std::env::temp_dir().join("sealpack-download-test/traversal");
        let target = root.join("out");
        let _ = std::fs::remove_dir_all(&root);

        let count = extract_zip(&archive, "", &target).unwrap();
        assert_eq!(count, 2);
        // 两个条目都只保留最外层文件名，落在目标目录里
        assert!(target.join("evil.exe").is_file());
        assert!(!root.parent().unwrap().join("evil.exe").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 前缀对不上时必须报错，而不是留下一个空的工具目录假装成功
    #[test]
    fn errors_when_prefix_matches_nothing() {
        let zip = build_zip(&[("somewhere/else.exe", b"MZ")]);
        let archive = write_temp("mismatch.zip", &zip);
        let target = std::env::temp_dir().join("sealpack-download-test/mismatch-out");
        let _ = std::fs::remove_dir_all(&target);

        let err = extract_zip(&archive, "tools/net452/", &target).unwrap_err();
        assert!(err.to_string().contains("没有找到预期的文件"));

        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn rejects_garbage_input() {
        let archive = write_temp("garbage.bin", b"this is definitely not a zip");
        let target = std::env::temp_dir().join("sealpack-download-test/garbage-out");
        assert!(extract_zip(&archive, "", &target).is_err());
    }

    /// 缓存判据必须同时看大小与校验值
    #[test]
    fn cache_requires_matching_digest() {
        let source = source_of("ilmerge").unwrap();
        let dir = std::env::temp_dir().join("sealpack-download-test/cache");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("ilmerge.nupkg");

        // 不存在
        assert!(!archive_is_valid(&archive, source));
        // 存在但内容不符
        std::fs::write(&archive, b"nope").unwrap();
        assert!(!archive_is_valid(&archive, source));
        // 大小对了但内容不符
        std::fs::write(&archive, vec![0u8; source.size as usize]).unwrap();
        assert!(!archive_is_valid(&archive, source));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 端到端：真的去网上下载
    //
    // 单元测试里的 zip 是自己造的，只能证明「解析逻辑对不对」；
    // 而真实世界的包有数据描述符、不同的压缩级别、条目顺序也不同，
    // 出了事只在用户机器上暴露。所以这里跑真的网络请求，
    // 但用 `#[ignore]` 关掉 —— 正常跑测试不该依赖外网。
    // 执行：`cargo test --lib -- --ignored --nocapture`

    /// 清理上一次留下的产物，避免缓存命中让测试变成空跑
    fn fresh_tools_dir(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("sealpack-e2e-{name}"));
        let _ = std::fs::remove_dir_all(&base);
        let tools = base.join("tools");
        let cache = base.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        (tools, cache)
    }

    #[tokio::test]
    #[ignore = "需要外网：真实下载 ILMerge 并解压"]
    async fn network_downloads_ilmerge_from_nuget() {
        let (tools, cache) = fresh_tools_dir("ilmerge");
        let exe = install(None, &tools, &cache, "ilmerge").await.unwrap();

        // 两个文件都要在：少了 System.Compiler.dll，ILMerge 启动即失败
        let dll = tools.join("ILMerge").join("System.Compiler.dll");
        assert!(exe.is_file(), "ILMerge.exe 未解出：{exe:?}");
        assert!(dll.is_file(), "System.Compiler.dll 未解出：{dll:?}");
        assert_eq!(
            std::fs::metadata(&dll).unwrap().len(),
            734_640,
            "System.Compiler.dll 字节数与官方包不一致"
        );
        // 下载的原始包按声明大小落盘
        assert_eq!(
            std::fs::metadata(cache.join("ilmerge.3.0.41.nupkg"))
                .unwrap()
                .len(),
            source_of("ilmerge").unwrap().size
        );

        // 第二次走缓存：不再有网络也能装（把“校验值”当唯一判据的收益就在这）
        let again = install(None, &tools, &cache, "ilmerge").await.unwrap();
        assert_eq!(again, exe);

        let _ = std::fs::remove_dir_all(&tools.parent().unwrap());
    }

    #[tokio::test]
    #[ignore = "需要外网：真实下载 ConfuserEx 并解压"]
    async fn network_downloads_confuser_cli_from_github() {
        let (tools, cache) = fresh_tools_dir("confuser");
        let exe = install(None, &tools, &cache, "confuser").await.unwrap();

        assert!(exe.is_file(), "Confuser.CLI.exe 未解出：{exe:?}");
        // 扁平包里的 16 个文件都应落位 —— CLI 少一个 dll 就跑不起来
        let count = std::fs::read_dir(tools.join("ConfuserEx")).unwrap().count();
        assert_eq!(count, 16, "解出的文件数与压缩包不一致");
        assert_eq!(
            std::fs::metadata(cache.join("ConfuserEx-CLI.zip")).unwrap().len(),
            source_of("confuser").unwrap().size
        );

        let _ = std::fs::remove_dir_all(&tools.parent().unwrap());
    }

    /// Inno Setup 只提供安装程序，而安装需要管理员授权。
    /// 这里只验「下载 + 校验值」这一段 —— 它是纯 HTTP + 磁盘，能在这里验；
    /// 安装那一步要么在当前机器上以管理员重跑，要么走 `tools::status` 报的本机已有版本。
    /// 结论记录在 SOURCES 里 iscc 的 note 与 failure_hint 中。
    #[tokio::test]
    #[ignore = "需要外网；只验下载与校验值，不跑安装"]
    async fn network_downloads_innosetup_installer() {
        let (tools, cache) = fresh_tools_dir("iscc");
        let source = source_of("iscc").unwrap();
        let archive = cache.join(archive_name(source.url));

        download(None, source, &archive).await.unwrap();

        assert_eq!(
            std::fs::metadata(&archive).unwrap().len(),
            source.size,
            "下载到的安装程序字节数与声明不符"
        );
        // 校验值在 download() 内部已经核对过，这里再确认一次文件确实留了下来
        assert_eq!(
            crate::hash::file_digest("sha256", &archive).unwrap(),
            source.sha256
        );

        let _ = std::fs::remove_dir_all(&tools.parent().unwrap());
    }
}
