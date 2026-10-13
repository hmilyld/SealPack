# 数据与安全

## 数据存放位置

| 内容 | 位置 |
| --- | --- |
| 工程配置 | `%APPDATA%\com.hmilyld.sealpack\projects\<工程 id>.json` |
| 全局设置（三个工具的路径） | `%APPDATA%\com.hmilyld.sealpack\settings.json` |
| 自动下载的工具 | `%APPDATA%\com.hmilyld.sealpack\tools\` |
| 阶段执行时的临时文件 | `%APPDATA%\com.hmilyld.sealpack\work\<工程 id>\` |
| 下载到的原始包（缓存） | `%APPDATA%\com.hmilyld.sealpack\work\downloads\` |
| 界面偏好（皮肤 / 明暗 / 材质） | WebView 的 `localStorage`，键名 `sealpack:design` |

`work\` 下的工程目录会在**程序启动时**清理超过 24 小时的（跳过 `downloads\` 缓存）——
异常退出（强杀、断电）可能留下临时文件，而加密配置与打包脚本里含明文口令。

## 口令是明文存放的

工程配置里的三个口令字段都是**明文**写入 `projects\<id>.json` 的：

| 字段 | 用途 |
| --- | --- |
| `password` | 安装包口令（Inno Setup 的 `Password`） |
| `snKeyPass` | 强名称密钥（`.pfx` 容器）的口令 |
| `renamePassword` | ConfuserEx `reversible` 重命名模式下的符号还原口令 |

这是为了让工具链能够无人值守地重跑（不需要每次输入口令）。界面上这三个字段用 `type="password"` 渲染，
但那只防肩窥，**不防读文件**。

因此：

- **不要把 `%APPDATA%\com.hmilyld.sealpack\` 纳入版本库或共享出去**；
- 安装包口令泄露 = 安装包加密失效，请按口令而非密钥来对待它；
- 若需要更强的保护，可以改用「工程里留空口令 + 运行时用 `安装包.exe /PASSWORD=…` 传入口令」的流程。

> 已知的改进方向：把这三类字段迁到 Windows 凭据管理器或 DPAPI 加密后再落盘。
> 这会改变工程文件的存储格式，需要配套的迁移方案，尚未实现。

## 外部工具下载的完整性

三个工具都不是本项目的产物，各有各的分发方式，`download.rs` 把它们收敛成一份声明
（`SOURCES`）：URL、期望字节数、SHA-256、包内结构、来源名与说明。

| 工具 | 来源 | 形态 | 包内结构 |
| --- | --- | --- | --- |
| ILMerge | NuGet 官方源 | `.nupkg`（本质是 zip） | 真正的文件在 `tools/net452/` 下 |
| ConfuserEx | 作者在 GitHub 的 Release | `.zip` | 扁平，解压即用 |
| Inno Setup | 官方 Release | `.exe` 安装程序 | 没有便携包，只能静默安装 |

执行流程只有一条：**取包（缓存命中就跳过网络）→ 核对校验值 → 按 `Layout` 铺到目标目录**。

几处刻意的设计：

- **校验值写死**。三个来源都是不可变的（NuGet 与 GitHub Release 都禁止覆盖同名资产），
  所以 SHA-256 可以固定。对不上就说明拿到的东西不是我们预期的那份 —— 与其把来路不明的二进制装进
  工具目录，不如直接失败。
- **缓存判据是校验值，不是「文件存在」**。半截下载同样能算出哈希，但算不出这个哈希。
  先写 `.part` 再改名，中途失败留下的残片不会污染缓存目录。
- **解压只取最外层的文件名**，包内的目录层级（`tools/net452/`）不会被复制过去。
  这一步同时消掉了 `..` 与绝对路径，不存在把文件写到目标目录之外的可能。
- **同一个工具不允许并发安装**（`IN_FLIGHT` 集合）。界面在下载期间会禁用按钮，但那只是第一道防线：
  双击、快捷键、或者后续版本里多开一个入口，都可能让两次安装同时往一个目录里写。
- **Inno Setup 的静默安装需要管理员授权**（它的安装脚本没有设置 `PrivilegesRequired`，
  默认按「为所有用户安装」处理，且只允许用对话框切换、不接受 `/CURRENTUSER`）。
  所以程序会先探测本机已装的那一份并提供「使用本机」入口 —— 既免掉 10 MB 下载，也免掉一次 UAC。
  失败时会把「需要批准 UAC」这句话接到真实错误后面，而不是只甩一个错误码。

## 日志打码

外部工具的命令行会原样打进日志面板，而其中可能带口令。`pipeline.rs::mask_secret` 在唯一的出口
按规则表 `SECRET_KEYS` 遮掉（`PASSWORD=` / `SNKEYPASS=` / `RENAMEPASSWORD=` / `KEYPASS=`，大小写不敏感）。

**新增敏感参数时必须同步这张表** —— 只认一种形态的话，将来加进来的参数会静默漏出去。
表的内容由单测逐键断言。

## 子进程与环境

- 三个外部工具都以 `CREATE_NO_WINDOW` 启动，不会闪出控制台窗口。
- 子进程输出可能是 UTF-8，也可能是系统 ANSI（简体中文 Windows 为 GBK），
  `decode_line` 先试 UTF-8、失败再按 GBK 解，避免日志里出现乱码。
- 合并与加密会**原地覆盖主程序**，所以首次执行前会自动备份为 `<主程序名>.bakup`，
  且该备份默认不进入安装包。仍建议在独立输出目录里操作。

## 渲染层的注入面

界面里所有拼进 `innerHTML` 的动态文本都先过 `src/util.ts` 的 `esc()`（工程名、路径、工具输出等）。
工程 Id 只允许 `[A-Za-z0-9-]`，因此不能借它做路径穿越（`store.rs::validate_id`）。

CSP 是 `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'`：

- 没有任何远程资源，字体全部本地打包；
- `style-src` 允许内联样式（组件大量使用内联 `style` 属性做几何计算）；
- `script-src 'self'` 不含 `'unsafe-inline'` —— `index.html` 里的首帧主题引导脚本能执行，
  依赖 Tauri 在构建时为内联脚本注入 CSP hash/nonce。**改动 CSP 时必须回归启动首帧。**
