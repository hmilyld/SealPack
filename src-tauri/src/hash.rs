use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256};

/// 支持的产出校验算法。`none` 表示不生成清单。
///
/// 这里是「哈希方式」在 SealPack 里的落点：ConfuserEx 的反篡改用整模块校验和
/// 保护方法体、Inno Setup 用 PBKDF2-HMAC-SHA256 从口令派生密钥，而打包完成后
/// 再给产出文件算一份摘要，用户就能对外发布「下载后请核对 SHA-256」。
pub const ALGORITHMS: &[&str] = &["sha256", "sha1", "md5"];

pub fn is_enabled(algo: &str) -> bool {
    ALGORITHMS.iter().any(|a| a.eq_ignore_ascii_case(algo))
}

/// 算法的展示名（写进清单头部）
fn label(algo: &str) -> &'static str {
    match algo.to_ascii_lowercase().as_str() {
        "sha1" => "SHA-1",
        "md5" => "MD5",
        _ => "SHA-256",
    }
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 流式计算文件摘要。
///
/// 安装包动辄几百 MB，甚至分卷后上 GB，所以按块读、边读边喂给 hasher，
/// 不把整个文件读进内存。
fn digest_with<D: Digest + Default>(path: &Path) -> Result<String> {
    let mut hasher = D::default();
    let mut file = File::open(path).with_context(|| format!("无法读取 {}", path.display()))?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .with_context(|| format!("读取 {} 失败", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(to_hex(&hasher.finalize()))
}

/// 按算法计算单个文件的摘要
pub fn file_digest(algo: &str, path: &Path) -> Result<String> {
    match algo.to_ascii_lowercase().as_str() {
        "sha1" => digest_with::<Sha1>(path),
        "md5" => digest_with::<Md5>(path),
        _ => digest_with::<Sha256>(path),
    }
}

/// 生成校验清单，返回清单文件路径。
///
/// 格式沿用 `sha256sum` 的 `<摘要>  <文件名>`（两个空格），这样
/// `sha256sum -c checksums.txt` / `certutil -hashfile` 之类现成工具能直接校验。
pub fn write_manifest(algo: &str, files: &[PathBuf], out_path: &Path) -> Result<PathBuf> {
    let mut body = String::new();
    body.push_str(&format!("# SealPack 产出校验清单（{}）\n", label(algo)));
    body.push_str(&format!(
        "# 校验方式：与本文件同目录下执行 `certutil -hashfile <文件名> {}`\n",
        label(algo).to_lowercase().replace('-', "")
    ));
    body.push_str("# 或使用 sha256sum / sha1sum / md5sum 的 `-c` 参数。\n\n");

    for file in files {
        let name = file
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let digest = file_digest(algo, file)?;
        body.push_str(&format!("{digest}  {name}\n"));
    }

    std::fs::write(out_path, body)
        .with_context(|| format!("无法写入校验清单 {}", out_path.display()))?;
    Ok(out_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用公开的测试向量校验实现 —— 摘要算错的清单比没有清单更糟。
    /// 三个向量都是 "abc" 的标准结果。
    #[test]
    fn matches_known_vectors_for_abc() {
        let dir = std::env::temp_dir().join("sealpack-hash-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("abc.bin");
        std::fs::write(&file, b"abc").unwrap();

        assert_eq!(
            file_digest("sha256", &file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            file_digest("sha1", &file).unwrap(),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            file_digest("md5", &file).unwrap(),
            "900150983cd24fb0d6963f7d28e17f72"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空文件也要能算（SHA-256 的空输入向量）
    #[test]
    fn handles_empty_file() {
        let dir = std::env::temp_dir().join("sealpack-hash-empty");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("empty.bin");
        std::fs::write(&file, b"").unwrap();

        assert_eq!(
            file_digest("sha256", &file).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 跨块边界的文件：确认流式读取没有丢字节（块大小是 64KB）
    #[test]
    fn reads_across_chunk_boundary() {
        let dir = std::env::temp_dir().join("sealpack-hash-chunk");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.bin");
        let data = vec![0x5au8; 64 * 1024 + 1234];
        std::fs::write(&file, &data).unwrap();

        let mut hasher = Sha256::default();
        hasher.update(&data);
        assert_eq!(
            file_digest("sha256", &file).unwrap(),
            to_hex(&hasher.finalize())
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn algorithm_whitelist() {
        assert!(is_enabled("sha256"));
        assert!(is_enabled("SHA1"));
        assert!(is_enabled("md5"));
        assert!(!is_enabled("none"));
        assert!(!is_enabled("crc32"));
    }

    #[test]
    fn manifest_lists_digest_and_name() {
        let dir = std::env::temp_dir().join("sealpack-hash-manifest");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Setup.exe");
        std::fs::write(&file, b"abc").unwrap();
        let manifest = dir.join("checksums-sha256.txt");

        write_manifest("sha256", std::slice::from_ref(&file), &manifest).unwrap();
        let body = std::fs::read_to_string(&manifest).unwrap();

        assert!(body.contains(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  Setup.exe"
        ));
        assert!(body.contains("SHA-256"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
