# 外部工具目录（应用内置）

随安装包分发的命令行工具放这里。**目前只有 ILMerge 与 ConfuserEx**，两者版本与
`src-tauri/src/download.rs` 的 `SOURCES` 声明一致（可用 `cargo test -- --ignored` 核对）。

| 工具 | 版本 | 体积 | 许可证 |
| --- | --- | --- | --- |
| ILMerge | 3.0.41 | 0.8 MB | MIT（[dotnet/ILMerge](https://github.com/dotnet/ILMerge)，已归档） |
| ConfuserEx | 1.6.0 | 4.8 MB | MIT（[mkaring/ConfuserEx](https://github.com/mkaring/ConfuserEx)） |

两个都是 MIT，随仓库与安装包分发没有问题。

## Inno Setup 为什么不在这里

官方**只提供安装程序**、没有便携压缩包（约 10 MB），装它还需要管理员授权；
而它常常是开发机上现成的。所以程序对它的策略是：

1. 先用「设置」里配置的路径；
2. 再找本机已安装的那一份（`tools.rs::system_candidates` 会枚举
   `Program Files` / `Program Files (x86)` / `%LOCALAPPDATA%\Programs` 下
   `Inno Setup <版本>` 目录，取版本号最高的一个），设置面板里给「使用本机」入口；
3. 都没有才走下载。

> **曾经踩过的坑**：本目录里放过一份手工拷贝的 Inno Setup **6.1**，而声明的下载版本是 **6.7.3**。
> 因为解析顺序是「内置 > 下载」，那份旧拷贝会一直压住正确版本 —— 而生成的脚本用了
> `EncryptionKeyDerivation`（Inno 6.5+ 才有），于是打包必然失败，报的还是
> `Unrecognized [Setup] section directive`。已经删掉。
>
> 教训：**内置工具必须与 `SOURCES` 声明的版本一致**，否则「三级回退」的第一级会静默压住正确的版本。
> 要放就放对版本，不要放「反正能用」的旧拷贝。

## 如果你想改为随包分发

把文件放成下面这个布局，重新 `tauri build` 即可；程序会优先用这里，
用户下载的版本落在用户目录，两者互不影响。

```
resources/
└── tools/
    ├── ILMerge/
    │   ├── ILMerge.exe
    │   └── System.Compiler.dll     ← 必须一起放，ILMerge 离了它不能启动
    ├── ConfuserEx/
    │   ├── Confuser.CLI.exe
    │   └── （其余 dll 一并放入）
    └── Inno/
        └── ISCC.exe                ← 注意版本必须 ≥ 6.5（见上）
```

路径约定来自 `src-tauri/src/tools.rs` 的 `ToolSpec::relative`，
新增一个工具时目录名要与那里对得上。

## 解析顺序

`设置 → 外部工具路径` 里填的值 > 本目录 > 用户下载目录。
详细说明见 `src-tauri/src/tools.rs` 的 `locate()`。
