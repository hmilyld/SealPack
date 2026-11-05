# SealPack UI 重写与升级包计划

> 状态：执行中  
> 分支：`feat/ui-redesign`  
> 目标：React + Fluent UI React v9 + Griffel 重写界面；Phase 2 增加目标软件的安装包/升级包产物。

## 已确认的决策

| 项 | 决定 |
| --- | --- |
| 前端 | React 18.3 + TypeScript + Vite + Fluent UI React v9 + Griffel + Zustand |
| 样式 | 只用 Griffel + Fluent token；不引入 Tailwind / shadcn |
| 主题 | `FluentProvider` + `createLightTheme` / `createDarkTheme`；固定 Windows 11 蓝 |
| 字体 | Segoe UI Variable / Cascadia Mono（系统字体） |
| 导航 | 顶部五步 + 左侧工程栏 |
| 密度 | 正文 14px / 1.5；树行 30px；控件 32px |
| 合并树 | 目录树表；勾选 = 合并 |
| 打包树 | 目录树表；**勾选 = 打包**；自动项锁定 |
| 构建方式 | 全新安装包 / 增量升级包 / 全量升级包 / 安装包+增量 |
| 全新安装包 | Inno modern 向导 |
| 升级包 | 零向导页；`Encryption=yes` 时保留一次口令；强制关闭旧程序 |
| 打包模式 | 升级包只支持 `single`；绿色版/分卷禁用 |
| 数据迁移 | `schemaVersion` + 自动迁移；构建方式/历史存工程 JSON |
| 交付 | 同一分支；`SealPack-Docs` 延后 |

## Phase 1A：核心 UI

- [x] 依赖与工程配置（React、Fluent、Zustand、Vite、tsconfig、入口）
- [x] Fluent 主题、全局样式、Mica、字体
- [x] 树表组件（三态、正向勾选、锁定项、键盘、虚拟滚动）
- [x] 外壳（标题栏、工程栏、五步步骤条、内容区、日志抽屉、状态栏）
- [x] 主程序页
- [x] 合并页（树 + 合并清单）
- [x] 加密页（预设 + schema 选项 + 高级模板）
- [x] 打包页（树 + 安装包选项）
- [x] 执行页（阶段卡 + 日志）
- [x] 设置、新建工程、右键菜单、Toast、快捷键
- [x] Rust 小改：`FileNode.size`、`IgnorePreview` 计数、输出目录自动排除
- [x] 预览 mock、探针 A–G、docs/AGENTS
- [x] README 截图更新（已用新界面截图替换）
- [ ] 确认/输入对话框抽成通用组件（当前新建/设置/预检确认各自内联）

## Phase 1B：增强

- [x] 构建预检清单（Rust `preflight` + UI）
- [x] 打包预设（标准发布 / 快速联调 / 最小体积 / 绿色版）
- [x] 取消构建（`CancelState` + `cancel_build` + 进程树）
- [x] 构建历史（`Project.buildHistory` + `schemaVersion` 迁移 + UI）
- [x] 保存日志（`save_log` + UI）
- [x] 探针 A–G 断言
- [x] `docs/architecture.md` / `docs/guide.md` / `docs/development.md` / `docs/data-and-security.md` / `docs/options.md` 同步
- [ ] 取消构建的真实长进程 ignored 测试
- [ ] 设置对话框内容区滚动与底部按钮的间距微调

## 样式审计与 token 统一

- [x] 应用级 token 抽到 `src/styles/tokens.css`（4pt 间距、字号/行高、圆角、布局尺寸、层级）
- [x] 语义色抽到 `src/theme/semantic.ts`（success/warning/danger/info/folder/highlight/closeHover）
- [x] 组件内裸 hex / 裸 rgba 清零（仅保留品牌色阶、Windows 关闭色、首帧底色）
- [x] 字号统一到 11/12/14/18/20；行高 16/18/20/21/26/28
- [x] 间距统一到 4/8/12/16/20/24/32；去掉 6/10/14/18px 离散值
- [x] 圆角统一到 4/6/8/10；面板 8、菜单/预设卡 6、控件 4
- [x] 标题语义化（Page h1 / Panel h2 / Empty h1）
- [x] 图标按钮补 `aria-label`；自定义按钮/树行补 Fluent 焦点环
- [x] `prefers-reduced-motion` 降级
- [x] 文档补充「设计 token 与样式约定」

## Phase 2：升级包

- [x] `BuildOptions { artifact, baselinePath }`、`schemaVersion` 3 迁移；不引入第二套模板
- [x] `manifest.rs`：写/读基线清单、SHA-256 diff、版本/安装模式校验、路径安全
- [x] `defaults.rs` 单模板 + `${files}` / `${installDelete}` / `${artifactSetup}` / `${artifactCode}` / `${artifactLabel}` / `${runSection}`
- [x] `packaging.rs` 按产物展开文件段、删除段、零向导指令、旧版本校验 `[Code]`
- [x] `pipeline.rs` 一次快照、`both` 双编译、`[InstallDelete]`、基线清单、按产物命名校验清单、取消检查
- [x] `commands.rs` `plan_upgrade`、预检升级项、模板占位符检查
- [x] 打包页产物三选一、基线卡、只读差异（新增/修改/删除/未变）、自动基线/手动换基线
- [x] 构建历史 `StageOutcome.artifact`；探针 H 组；docs
- [x] 真实 ISCC 两版覆盖安装 + 卸载验证（ignored 测试：完整 v1 → 升级 v2 → 卸载）
- [ ] 独立文档站 `SealPack-Docs` 更新（按约定延后）
- [ ] 版本号 0.2.0 → 0.3.0（待定）

## 验收命令

```bash
pnpm run build:preview
node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/SealPack/dist-preview" docs/shots
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
# 真实安装链路（需要 Inno Setup 6；会写 %TEMP% 与 HKCU，测试内会卸载）
cd src-tauri && cargo test --lib packaging::tests::real_install_upgrade_and_uninstall -- --ignored
pnpm run check:render-parity
pnpm run app:build
```

## 不变量

- 模板只由 Rust 生成；前端只收集开关。
- 升级包只在打包阶段分叉：一套模板 + `packaging.rs` 展开；基线清单描述完整安装状态。
- 升级差异只看 SHA-256；界面只读，不做手工勾选。
- 防抖保存切工程前 `flush()`。
- `scanEpoch` / `ignoreEpoch` 分开。
- 长任务前快照 `project.id`，运行期间锁工程切换。
- 全局快捷键只 `preventDefault`，不 `stopPropagation`。
- 窗口 `visible:false`，首帧后 `show()`。
- CSP `script-src 'self'`，不引远程字体/CDN。
- 预览 mock 与 CDP 探针是前端安全网，不能丢。
