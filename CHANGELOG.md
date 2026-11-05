# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
发布新版本时，把 `[Unreleased]` 改成 `[版本号] - YYYY-MM-DD`；`release.yml` 会优先取与标签同名的版本段作为 GitHub Release 正文，找不到再退回 `[Unreleased]`。

## [Unreleased]

## [0.3.0] - 2026-11-05

### 新增

- 界面重写为 React 18 + Fluent UI React v9 + Griffel，只保留一套 Fluent 主题，支持跟随系统 / 浅色 / 深色。
- 打包页新增「产物」：完整安装包 / 升级包 / 两者。
- 升级包支持基线清单、SHA-256 自动 diff、零向导安装、`[InstallDelete]` 清理旧文件、目标机器旧版本校验。
- 工程右键新增「重新加载工程」「重命名…」「删除工程…」；重命名会智能预填主程序 `ProductName`。
- 构建历史按产物类型显示，并按路径去重；产物以标签横向排列，可直接在资源管理器中定位。
- 设置页工具分区、路径操作与下载按钮对齐；新增真实 ISCC 编译与安装/升级/卸载测试。
- 界面回归探针扩展到 A–J 组，覆盖主题、原生感、树、选项、预检、升级包、设置与工程管理。

### 变更

- 文件树整行点击即切换选中；「全部打包 / 全部排除」覆盖折叠目录与筛选之外的文件，锁定项保持不变。
- 主程序表单、选项路径框、设置页按钮统一控件高度；模板编辑器的 textarea 与边框高度对齐。
- 设计 token 增加字体角色（UI / Display / Mono）、边框层级、控件高度与动效时长；页面改为灰色画布 + 白色内容卡，次级分区不再堆卡片。
- 预检在模板使用 `${files}` 时不再要求模板文本里出现 `${root}` / `${ignore}`，修复默认工程的误报。
- 校验清单按产物命名，避免完整包与升级包互相覆盖。
- 窗口首帧底色统一为 `#f3f3f3`，与新的浅色画布一致。

### 修复

- 修复开发模式下运行日志每行重复一次（StrictMode 双挂载 + Tauri `listen()` 异步返回导致的重复订阅）。
- 修复构建历史里同一个主程序出现两次。
- 修复设置页打开时第一个 tab 出现初始焦点黑框。
- 修复 ConfuserEx 配置与 Inno Setup 脚本 textarea 高度和外框不一致。
- 修复「全部打包 / 全部排除」在折叠目录下不生效。
- 修复工程栏改名后列表不刷新的问题。

### 移除

- 移除 Tailwind、两套皮肤（Swiss / Terminal）、旧原生 TS 组件与内置字体资源。
- 移除标题栏的「开始构建」按钮；统一从执行页的「全部执行」进入构建。

### 验证

- `cargo test`：88 passed / 6 ignored
- `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`
- `pnpm run build:preview`
- `pnpm run check:render-parity`：22 用例 · 44 模板逐字一致
- `ui-probe`：61/61
- `pnpm run app:build`：NSIS 安装包
