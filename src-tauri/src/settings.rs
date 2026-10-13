use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// 全局设置（与具体工程无关，保存在应用数据目录的 settings.json）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 自定义 ILMerge 路径；留空表示使用应用内置工具
    pub ilmerge_path: String,
    /// 自定义 ConfuserEx 路径；留空表示使用应用内置工具
    pub confuser_path: String,
    /// 自定义 Inno Setup 编译器路径；留空表示使用应用内置工具
    pub iscc_path: String,
}

impl Settings {
    /// 读取全局设置。文件不存在（首次运行）时用默认值。
    ///
    /// 文件存在但解析失败说明它被改坏了：仍然用默认值继续（不至于让程序打不开），
    /// 但要留一条痕 —— 否则用户会以为自己的工具路径配置生效了。
    pub fn load(file: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(file) else {
            return Self::default();
        };
        match serde_json::from_str::<Settings>(&text) {
            Ok(settings) => settings,
            Err(err) => {
                eprintln!("设置文件 {} 解析失败，已回退到默认设置：{err}", file.display());
                Self::default()
            }
        }
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("无法创建目录 {}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(self).context("序列化设置失败")?;
        std::fs::write(file, text).with_context(|| format!("无法写入 {}", file.display()))?;
        Ok(())
    }

    pub fn override_for(&self, key: &str) -> &str {
        match key {
            "ilmerge" => &self.ilmerge_path,
            "confuser" => &self.confuser_path,
            "iscc" => &self.iscc_path,
            _ => "",
        }
    }
}
