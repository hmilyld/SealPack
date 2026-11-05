# 架构与设计决策

## 技术栈与形态

**Windows 桌面应用**：Rust 后端（Tauri 2）+ React 前端（React 18、TypeScript、Fluent UI React v9、Griffel、Zustand）。

选 Tauri 而不是 Electron 的理由不变：需要调用三个外部命令行工具、读写本地文件、窗口材质；渲染层只是「配置界面 + 日志面板」。

## 模块地图

```
前端 (src/)
├── main.tsx                挂载 React、安装桌面行为、首帧显示
├── App.tsx                 主题 / Toast / 右键菜单 Provider、事件订阅、快捷键
├── theme/                  FluentProvider、Windows 11 蓝色阶、系统/浅/深三态
├── styles/global.css       滚动条、选区、Mica、拖拽区等 Fluent 不负责的少量全局样式
├── api.ts                  Tauri 命令与事件封装、文件/目录/保存对话框
├── desktop.ts              桌面化行为层（快捷键 + 拦浏览器行为 + 首帧显示）
├── types.ts                共享类型 + 步骤元数据 + 选项 schema + 打包预设
├── util.ts                 路径相对化 / 是否在目录下 / 文件名
├── lib/
│   ├── defaults.ts         schema 默认值、预设匹配
│   ├── fileTree.ts         扁平化、三态、筛选、统计、通配符
│   ├── format.ts           字节数 / 时间格式化
│   └── summaries.ts        合并/加密/打包摘要与阶段状态文案
├── stores/
│   ├── projectStore.ts     工程列表、当前工程、600ms 防抖保存
│   ├── workspaceStore.ts   扫描树、scanEpoch、ignoreEpoch、排除项
│   ├── optionsStore.ts     选项变更、模板重建、预设/恢复默认
│   ├── buildStore.ts       阶段状态、日志、取消、构建历史
│   ├── settingsStore.ts    工具链、运行环境、设置
│   └── uiStore.ts          当前步骤、日志抽屉、浮层
└── components/
    ├── common/             Page、Panel、ContextMenu
    ├── shell/              TitleBar、ProjectRail、StepNav、StatusBar、LogDrawer、ResizeZones
    ├── tree/               FileTree（自绘扁平树 + 虚拟滚动）
    ├── steps/              Setup/Merge/Encrypt/Package/Run/Workspace
    ├── options/            OptionField、OptionGroups、PresetPicker、TemplateEditor、PackageOptions
    ├── upgrade/            UpgradePanel（基线卡 + 只读差异）
    ├── dialogs/            NewProjectDialog、SettingsDialog
    └── feedback/           ToastProvider

后端 (src-tauri/src/)
├── lib.rs               组装：插件、窗口、命令注册表、启动兜底
├── commands.rs          Tauri 命令层（工程、扫描、预检、取消、保存日志、执行）
├── model.rs             领域模型：Project / 选项 / 事件 / 预检 / 构建历史
├── store.rs             工程持久化、schemaVersion 迁移、取消状态、临时目录清理
├── defaults.rs          由选项生成模板（加密配置 / 打包脚本）+ Inno 边界常量
├── packaging.rs         按产物展开 ${files} / ${installDelete} / [Code] / [Run]
├── manifest.rs          升级基线清单：写入、读取、diff、版本/安装模式校验
├── template.rs          ${key} 占位符渲染
├── pipeline.rs          三阶段异步进程编排（备份、流式日志、产出识别、取消）
├── excludes.rs          打包范围统计 + 完整文件清单 + Inno Excludes 近似匹配
├── tools.rs             工具链定位（自定义 > 内置 > 下载目录）+ 本机探测
├── download.rs          外部工具自动下载（来源 / SHA-256 / 解压 / 安装）
├── hash.rs              产出校验清单（SHA-256 / SHA-1 / MD5）
├── runtime.rs           .NET Framework 运行时探测
└── settings.rs          全局设置
```

## 数据流

```
用户在向导里改开关
      │
      ├─ 写进 current.encryptOptions / packageOptions
      │
      ├─ generated == true → invoke render_encrypt_config / render_package_script
      │        （Rust defaults.rs 生成模板）→ 写回 current.encryptConfig / packageScript
      │
      ├─ 600ms 防抖 → invoke save_project → %APPDATA%\...\projects\<id>.json
      │
      ├─ 打包页（产物含升级包）→ invoke plan_upgrade（基线 + 只读差异）
      │
      ├─ 执行页 → invoke preflight（路径 / 模板占位符 / 工具链 / 运行时 / 升级基线）
      │        ├─ 有 error：禁用「全部执行」
      │        └─ 有 warn：确认一次后继续
      │
      └─ invoke run_stage
               ├─ Rust 先 save_project（落盘权威在 Rust），再进 pipeline
               ├─ 按阶段取工具链路径 → 备份主程序（首次）→ 写临时配置/脚本
               ├─ 启动子进程，stdout/stderr 逐行 emit "pipeline:log"
               ├─ emit "pipeline:stage" 汇报阶段状态
               ├─ 打包阶段：执行前后对比输出目录，找出实际产出 → 可选校验清单
               └─ 前端把本次结果写入 Project.buildHistory（最多 20 条）
```

前端不持有模板语义：它只收集开关，模板永远由 Rust 生成。这条约束让「界面上的选项」与「实际写进配置的东西」不可能漂移。

## 那些「不知道就会改错」的不变量

### 1. 选项与模板都只有一处定义

- **加一个配置项 = 只改 schema**（`src/types.ts` 的 `ENCRYPT_GROUPS` / `PACKAGE_GROUPS`）。
- **模板只由 Rust 生成**（`defaults.rs`）。前端调用 `render_*`，不自己拼字符串。

### 2. 模板生成器有两份实现，靠脚本保持一致

浏览器预览没有 Rust，所以 `preview/render.ts` 是 `defaults.rs` 的镜像。改任何一边都要跑 `pnpm run check:render-parity`。

### 3. 异步写回全局状态需要代次守卫

`workspaceStore.ensureTree` / `refreshIgnores` 各有一个单调递增的 epoch。切换工程时旧请求晚于新请求返回，会挂错树、写错路径。**两个计数器必须分开**——勾选文件会触发排除项刷新，共用一个会让在途扫描自我作废。每条早退路径都必须把 `scanning` 落地。

### 4. 长任务前必须快照工程

`buildStore.runStage` / `runAll` 在入口捕获 `project.id`，之后每次写回（状态、产物、历史）都先校验。运行期间工程栏被禁用，但快捷键与程序化路径仍可能切走。

### 5. 防抖保存必须在切换工程前结算

`projectStore` 的 `scheduleSave` 是 600ms 防抖，回调用捕获的工程。`select` / `refresh` 必须先 `flush()`；删除当前工程用 `discard()`。

### 6. 只有一套主题

`ThemeProvider` 用 `FluentProvider` + `createLightTheme` / `createDarkTheme`；状态是 `system | light | dark`，存 `localStorage["sealpack:theme"]`。**没有 `data-skin`，不要恢复两套皮肤。** Mica 由 `data-material` 控制，只影响标题栏/工程栏/状态栏。

### 7. 文件树是自绘扁平树

`components/tree/FileTree.tsx` + `lib/fileTree.ts`，`@tanstack/react-virtual` 虚拟滚动。不用 Fluent `FlatTree` 的原因：30px 行高、三态勾选、大小/状态列、锁定项、8000 节点性能都需要完全控制。

**打包页勾选 = 打包**（正向语义）；自动项锁定为未勾选，主程序锁定为已勾选。合并页通过 `hidden` 隐藏主程序。整行点击 = 切换选中；展开箭头 = 展开/折叠；勾选框 = 切换选中。锁定行只聚焦，不改变勾选。

### 8. 预检是 Rust 命令，不在前端重复实现

`commands.rs::preflight` 检查主程序、根目录、输出目录可写、AppId、模板占位符、工具链、.NET 运行时；产物含升级包时还会算基线差异并检查安装模式/版本。前端只负责展示与「有 warn 才确认」。路径检查不要在前端再写一份。

### 9. 取消构建必须杀进程树

`store.rs::CancelState` 保存 `AtomicBool` 与当前 PID；`cancel_build` 用 `taskkill /PID <pid> /T /F` 杀整棵进程树。只杀父进程会留下 ISCC 子进程，下一次构建会被文件占用卡住。`StageStatus` 新增 `"cancelled"`，不要把它当 `"failed"`。

### 10. 构建历史与 schemaVersion

`Project.buildHistory` 存最近 20 次记录；`Project.schemaVersion` 是唯一允许 `#[serde(default)]` 的字段。旧工程由 `store.rs::migrate_project` 补 `buildHistory` / `buildOptions` 并升到 3，再严格反序列化。**不要给普通字段加 serde 默认值**——缺字段说明文件被改坏了。

### 11. 保存日志

`save_log` 写 UTF-8 with BOM，方便记事本看中文；日志里的 `/PASSWORD=` 已由 `pipeline.rs::mask_secret` 打码。日志可能包含本地路径，保存前提示用户。

### 12. 排除项匹配有两份实现

Rust `excludes.rs::matches` 与前端 `PackageStep` / `preview/mock.ts` 的 `matchPattern`。语义：含 `\` 匹配完整相对路径，否则匹配文件名；`*` 含 `\`，`?` 单字符；大小写不敏感。改一处要同步另一处。

### 13. 输出目录在根目录内时自动排除

`Project::output_dir_ignore` 返回 `相对路径\*`，避免上一轮安装包被打进下一轮。输出目录等于根目录时拒绝排除，由预检报错。

### 14. 注册 Tauri 命令是两步

在 `commands.rs` 定义**并且**加进 `lib.rs` 的 `invoke_handler!` 列表。

### 15. 全局快捷键表不 `stopPropagation`

快捷键在 `window` 的**捕获**阶段处理，只 `preventDefault`。浮层（对话框、右键菜单）自己处理 `Esc`。

### 16. 窗口 `visible: false` 的两半都不能删

窗口以 `visible: false` 创建，前端在「写主题 → 两帧 rAF → `show()`」之后才显示；Rust 侧另有 1.5s 兜底。

`index.html` 的内联主题脚本依赖 Tauri 在构建时为内联脚本注入 CSP hash/nonce（CSP 是 `script-src 'self'`，没有 `'unsafe-inline'`）。改 CSP 或换页面宿主时必须回归启动首帧。

### 17. Rust 侧的发布约束

- 工具链顺序：用户设置 > 内置 `resources/tools` > 用户下载目录；内置旧版本会静默压住下载的正确版本。
- Inno 边界值集中在 `defaults.rs` 顶部，`preview/render.ts` 有同名常量。
- 中文语言包随应用分发，`[Languages]` 用相对路径引用。
- `AppId` 由主程序产品身份推导，不能由工程 id 推导。

### 18. 升级包只在打包阶段分叉

- `defaults.rs` 只生成一套模板；`packaging.rs` 按产物展开 `${files}` / `${installDelete}` / `${artifactSetup}` / `${artifactCode}` / `${artifactLabel}` / `${runSection}`。
- `manifest.rs` 负责基线清单的写入、读取与差异；差异只看 SHA-256，不看修改时间。
- 每次成功打包都写 `sealpack-manifest-<版本>.json`，它描述**完整安装状态**，不是增量。
- 升级包只支持 `single + uninstallable`；绿色版、分卷、关闭卸载程序由预检拦截。
- 升级安装器在 `[Code]` 里查 `<AppId>_is1`：没有旧版本直接中止，版本不一致弹确认。
- 构建历史用 `StageOutcome.artifact`，不要再硬编码 `installer`。

## 桌面化设计的取舍

| 项 | 取值 | 依据 |
| --- | --- | --- |
| 标题栏 | 40px | Fluent 标题栏 + 构建/主题/设置入口 |
| caption 按钮 | 46×40 | Fluent caption 按钮；关闭 hover `#C42B1C` |
| 状态栏 | 28px | 工具链 / 版本 / 版权 |
| 正文 | 14px / 20px 行高 | Fluent `fontSizeBase300`，桌面工具密度 |
| 树行 | 30px | 三列信息 + 勾选框仍可点 |
| 圆角 | 4px 控件 / 8px 卡片 | Fluent |
| 动效 | Fluent duration tokens | 不用一套固定毫秒 |
| 焦点 | Fluent 2px 焦点指示器 | 不用彩色光晕 |
| 光标 | 界面元素一律箭头 | 手型是网页习惯 |
| 字体 | Segoe UI Variable / Cascadia Mono | 系统字体，无远程依赖 |

浮层一律「阴影 + 1px 描边」成对出现；对话框主操作在右、取消在左。

## 设计 token 与样式约定

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 应用 token | `src/styles/tokens.css` | 间距（4/8/12/16/20/24/32）、字号（11/12/14/18/20）、行高、圆角（4/6/8/10）、字体角色（UI/Display/Mono）、边框层级、控件高度/标题栏/状态栏/树行/侧栏尺寸、层级、动效时长、Windows 关闭色 |
| 语义色 | `src/theme/semantic.ts` | success / warning / danger / info / folder / highlight / closeHover，全部映射到 Fluent token 或 token 文件里的变量 |
| 组件内部 | Fluent `tokens.*` | 颜色、边框、焦点、动效曲线、阴影；组件不自己发明颜色 |

约定：

- **组件里不写裸 hex**；唯一的裸色在 `tokens.css`（Windows 关闭色）与 `brand.ts`（品牌色阶）。
- **间距只用 4pt 刻度**；不再出现 6/10/14/18px 这类离散步长。
- **字号只用 11/12/14/18/20**；正文 14/20（根节点 14/21），辅助说明 12/18，元信息 11/16，等宽数据 12/20。
- **圆角只用 4/6/8/10**：控件 4、菜单/预设卡 6、面板/对话框 8。
- **每屏只有一个主操作**：页面头部的次要操作统一 `size="small"`；标题栏因空间受限用 `small` 是唯一例外。
- **状态不只靠颜色**：Badge 带文字（打包 / 已排除 / 自动排除），工具链圆点旁边有名称。
- **焦点可见**：自定义按钮/树行统一 `2px colorStrokeFocus2` 描边；Fluent 组件用自带焦点环。
- **尊重 reduced motion**：`global.css` 在 `prefers-reduced-motion: reduce` 下把动画/过渡压到 0.01ms。
- **数字用 tabular-nums**：文件大小、计数、版本号、校验值。

审计时用以下命令找漏网：

```bash
# 组件里不应再有裸 hex / rgba
rg '#[0-9a-fA-F]{3,8}|rgba\(' src/components src/theme src/styles
# 不应再有离散步长
rg 'gap: "(6|10|14|18)px"|padding: "(6|10|14|18)px' src/components
```
