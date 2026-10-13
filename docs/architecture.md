# 架构与设计决策

## 技术栈与形态

**Windows 桌面应用**：Rust 后端（Tauri 2）+ 原生 TypeScript 前端（无 UI 框架，TailwindCSS 4 只用于重置与少量工具类）。
界面结构、状态与交互全部手写，两套视觉设计共用同一份 DOM。

选 Tauri 而不是 Electron 的理由很直接：需要调用三个外部命令行工具、需要读写本地文件、需要窗口材质，
而渲染层只是「配置界面 + 日志面板」—— 没有必要为此带一个完整的浏览器运行时。

## 模块地图

```
前端 (src/)
├── main.ts              界面编排与状态管理（五步向导、自绘标题栏、皮肤切换器、右键菜单装配）
├── types.ts             共享类型 + 步骤元数据 + 选项 schema（唯一的事实源）
├── api.ts               Tauri 命令与事件封装（含统一包错的文件选择入口）
├── desktop.ts           桌面化行为层（快捷键注册表 + 拦掉浏览器行为 + 首帧显示）
├── skin.ts              皮肤 / 主题 / 材质三个开关的单一状态源
├── util.ts              共用小工具（HTML 转义 / 取文件名 / 相对路径）
├── style.css            样式入口（按层导入）
├── styles/              tokens.css（兜底令牌）→ skins/*.css → components.css
└── components/
    ├── file-tree.ts     文件树（三个独立点击区 + 搜索 / 类型 / 只看已选）
    ├── file-picker.ts   文件选择器 = 文件树 + 一层「找人」的工具
    ├── log-panel.ts     运行日志面板（行数上限 + live region）
    ├── modal.ts         对话框外壳 + 确认 / 输入 / 新建工程
    ├── settings-dialog.ts  设置面板（工具路径 + 运行环境 + 下载）
    ├── context-menu.ts  自绘右键菜单
    └── toast.ts         提示条

后端 (src-tauri/src/)
├── lib.rs               组装：插件、窗口、命令注册表、启动兜底
├── commands.rs          Tauri 命令层（参数校验 + 选项↔模板对齐）
├── model.rs             领域模型：Project / EncryptOptions / PackageOptions / 事件载荷
├── store.rs             工程持久化、应用状态、临时目录清理
├── defaults.rs          由选项生成模板（加密配置 / 打包脚本）+ Inno 边界常量
├── template.rs          ${key} 占位符渲染
├── pipeline.rs          三阶段异步进程编排（备份、流式日志、产出识别）
├── tools.rs             工具链定位（自定义 > 内置 > 下载目录）+ 本机探测
├── download.rs          外部工具自动下载（来源声明 / 流式下载 / SHA-256 / 解压 / 静默安装）
├── hash.rs              产出校验清单（SHA-256 / SHA-1 / MD5，流式）
├── runtime.rs           .NET Framework 运行时探测（注册表）
└── settings.rs          全局设置（工具路径）
```

## 数据流

```
用户在向导里改开关
      │
      ├─ 选项写进 current.encryptOptions / current.packageOptions
      │
      ├─ 若 generated == true → invoke render_encrypt_config / render_package_script
      │        （Rust 侧 defaults.rs 生成模板文本）→ 写回 current.encryptConfig / packageScript
      │
      ├─ 600ms 防抖 → invoke save_project → %APPDATA%\...\projects\<id>.json
      │
      └─ 点「执行」→ invoke run_stage
               │
               ├─ Rust：先 save_project（落盘权威在这里），再进 pipeline
               ├─ 按阶段取工具链路径 → 备份主程序（首次）→ 写临时配置 / 脚本到 work/<id>/
               ├─ 启动子进程，stdout / stderr 逐行 emit "pipeline:log"
               ├─ emit "pipeline:stage" 汇报阶段状态
               └─ 打包阶段：执行前后对比输出目录，找出实际产出 → 可选生成校验清单
```

前端不持有模板语义：它只收集开关，模板永远由 Rust 生成。这条约束让「界面上的选项」与
「实际写进配置的东西」不可能漂移。

## 那些「不知道就会改错」的不变量

以下每一条都对应一次真实踩过的坑，改动相关代码前请先读。

### 1. 选项与模板都只有一处定义

- **加一个配置项 = 只改 schema**（`src/types.ts` 的 `ENCRYPT_GROUPS` / `PACKAGE_GROUPS`）。
  界面按它渲染，回归探针也按它断言，不要为某个选项手写渲染代码。
- **模板只由 Rust 生成**（`defaults.rs`）。前端调用 `render_*` 命令，不自己拼字符串。

### 2. 模板生成器有两份实现，靠脚本保持一致

浏览器预览没有 Rust，所以 `preview/render.ts` 是 `defaults.rs` 的镜像。两边一旦漂移，
预览里看到的模板就不是用户实际会拿到的模板 —— 而这种漂移在预览里看起来「挺对」。

`pnpm run check:render-parity` 用 Rust dump 出来的 fixture 与 TS 侧的输出做**逐字比对**。
改任何一边都要跑它。详见[开发](development.md#生成器一致性)。

### 3. 异步写回全局状态需要代次守卫

`ensureTree` / `refreshIgnores` 都是异步的，而它们写回的目标（`treeNode` / `ignores`）是模块级的。
切换工程时若旧请求晚于新请求返回，就会把上一个工程的目录树挂到当前工程上，
`picker.onChange` 会把 A 的路径写进 B 的 `mergeDlls`。

所以两者各有一个单调递增的 `epoch`，回来时对不上就直接丢弃。**两个计数器必须分开** ——
勾选文件会触发排除项刷新，共用一个计数器会让在途的扫描自我作废。

另一处细节：每条早退路径都必须把 `scanning = false` 落地，否则一个被作废的请求会把
「扫描中…」永久留在步骤条上。

### 4. 长任务前必须快照 `current`

`runStage` / `runAll` 在入口捕获 `proj`，之后每次写回（状态、产出、保存指示）都先校验
`current.id === proj.id`。运行期间左侧工程列表会被禁用，但快捷键与程序化路径仍可能触发切换，
校验是最后一道防线。

### 5. 防抖保存必须在切换工程前结算

`scheduleSave` 是 600ms 防抖，回调里用的是**捕获的** `proj`。而 `selectProject` 会替换 `current`，
所以它必须先 `flushPendingSave()` —— 否则「改完字段立刻切走」那次修改既不会被保存、也不会留在界面上。
删除当前工程时用 `discardPendingSave()`（保存了也马上删）。

### 6. 样式层的层叠陷阱

`components.css` 的规则全部包在 `@layer components` 里，而 `skins/*.css` 是**无层**（unlayered）的。
CSS 层叠规则里，无层的作者样式在任何优先级下都胜过有层的作者样式 —— 所以皮肤里的一条普通规则
能压过组件层的 `:hover`。

**推论**：皮肤要覆盖某个组件的 hover / active 态，必须写在皮肤文件里。

样式加载顺序：`style.css` → `tokens.css` → `skins/*.css` → `components.css`。
`tokens.css` 给出全套兜底值不是多余的 —— 自定义属性未定义时整条声明会失效（不是回退到可见的初始值），
表现为元素莫名没有边框。

### 7. 两套皮肤共用一份 DOM

皮肤与主题挂在 `<html data-skin data-theme data-themeMode>` 上，是根元素属性。
对话框与提示条虽然挂在 `<body>` 上，也会**同时**切换，不存在「部分元素还是旧皮肤」的中间态。
**永远不要为某套皮肤 fork DOM。**

### 8. 全局快捷键表不 `stopPropagation`

快捷键在 `window` 的**捕获**阶段处理，只 `preventDefault`。浮层（对话框、右键菜单）需要自己处理 `Esc`，
全局表把它吞掉的话对话框就关不上了。

### 9. 窗口 `visible: false` 的两半都不能删

窗口以 `visible: false` 创建，前端在「写皮肤 → 两帧 rAF → `show()`」之后才显示，所以启动不会闪白底；
Rust 侧另有一个 1.5s 的兜底显示，前端脚本出错也不会让窗口永不出现。

`index.html` 里的内联引导脚本是首帧主题的唯一来源，它依赖 Tauri 在构建时为内联脚本注入 CSP hash/nonce
（CSP 是 `script-src 'self'`，没有 `'unsafe-inline'`）。**改 CSP 或换页面宿主时必须回归启动首帧。**

### 10. 注册 Tauri 命令是两步

在 `commands.rs` 定义**并且**加进 `lib.rs` 的 `invoke_handler!` 列表。少一步就是「命令不存在」的运行时错误。

### 11. 工具链三级回退

任何地方解析工具路径的顺序都是：**用户设置 > 应用内置 `resources/tools` > 用户下载目录
（`%APPDATA%\com.hmilyld.sealpack\tools`）**。

第三级是必需的：应用装在 `Program Files` 下时内置目录只读，自动下载的工具只能落到用户目录，
少了这一级「下载成功但界面仍显示未找到」。

### 12. 取值一律白名单收敛

工程 JSON 是可以手改的，所以所有枚举值在写进模板前都过一遍白名单，不认识的退回默认值
（`defaults.rs::pick`）。已知的坑都用测试钉住了：`snKey` 在 `<module>` 上、
`Encryption=full` 仍要写 `Password`。

### 13. Inno 的边界值集中在 `defaults.rs` 顶部

`LZMA_DICT_MIN_KB` / `LZMA_DICT_MAX_KB` / `LZMA_THREADS_MAX` / `SLICE_MIN_BYTES` /
`SLICE_MAX_BYTES` / `SLICES_MIN` / `SLICES_MAX` 都抄自 Inno 官方文档，`preview/render.ts` 有同名常量。
**改一处必须改另一处，并跑一致性校验。**

### 14. 中文语言包必须随应用分发

简体中文**不在** Inno Setup 的官方发行版里（官方 `Languages\` 只带 29 种语言），
所以脚本里不能用 `compiler:Languages\ChineseSimplified.isl` —— 那在任何标准安装上都会
`Couldn't open include file`。本应用自带一份翻译（`src-tauri/resources/isl/`），
打包阶段复制到临时脚本旁边，用相对路径引用（ISCC 按脚本所在目录解析）。

推论：**改动 `[Languages]` 那一行或 `isl` 资源目录时，必须用真实 ISCC 编译一次验证**
（仅靠单测只能证明字符串写对了，证明不了文件在不在）。

### 15. 内置工具必须与声明的下载版本一致

工具解析顺序是「用户设置 > 内置 > 下载目录」，所以内置目录里放一份**旧版本**会静默压住
下载到的正确版本。曾经发生过：内置 Inno Setup 6.1 而声明 6.7.3，导致生成的脚本里
`EncryptionKeyDerivation`（6.5+ 才有）被判为未知指令，打包直接失败。

### 16. 工程 JSON 不写 serde 默认值

本程序完整写出所有字段，缺字段说明文件被改坏了，应当报错而不是悄悄补默认值。
所以 `Project` / `EncryptOptions` / `PackageOptions` 上没有任何 `#[serde(default)]`；
`Settings::load` 在解析失败时回退到默认值，但会往 stderr 留一条痕。

## 桌面化设计的取舍

浏览器引擎给的默认值本身就是「网页味」的主要来源。`desktop.ts` 把这些默认值逐条换成桌面程序的习惯：

| 拦掉的浏览器行为 | 说明 |
| --- | --- |
| `Ctrl+R` / `F5` / `F7` / `F12` | 刷新与开发者工具 |
| `Ctrl+P` / `Ctrl+F` / `Ctrl+U` | 打印 / 查找 / 查看源码 |
| `Ctrl+Shift+I/J/C` | 开发者工具与元素检查 |
| `Ctrl` `+` / `-` / `0` 与 `Ctrl+滚轮` | 浏览器缩放 —— 固定密度的桌面工具没有「缩放」这个概念，所以是拦掉而不是改键 |
| 拖出界面内容 / 拖入文件导航 | 阻止 `dragstart` 与 `dragover` / `drop`（`.drop-target` 除外） |
| 右键原生菜单 | 由自绘菜单替代 |
| 无焦点时按 `Backspace` | 阻止「后退」 |
| 界面文字被拖选 | `body` 默认 `user-select: none`，只放开输入框、脚本编辑区、运行日志与 `.selectable` |

度量层向 Fluent / WinUI 3 靠（依据 Fluent 规范）：

| 项 | 取值 | 依据 |
| --- | --- | --- |
| 标题栏高度 | 36–38px | Fluent 32px；这里要留出皮肤切换器，但仍在同一量级 |
| 窗口按钮 | 46px 宽 × 通高 × 直角 | Fluent caption 按钮；关闭键 hover `#C42B1C`、按下 `#B02518` |
| 状态栏 | 24px，工具链 / 版本 / 版权 | 本地工具把状态放窗口底部，而不是塞进标题栏 |
| 正文字号 / 行高 | 12px / 1.4 | 桌面工具密度，不是网页的 13–14px / 1.5 |
| 圆角 | 4px 控件 / 3px 小件 | Fluent Windows 的 4/8/8 体系收一档 |
| 动效 | 83 / 167 / 250ms | Fluent motion；进场 `cubic-bezier(0,0,0,1)`、退场 `cubic-bezier(1,0,1,1)` |
| 焦点环 | 2px 双描边 | Fluent 的焦点是双描边，不是彩色光晕 |
| 光标 | 界面元素一律箭头 | 手型光标是网页习惯；`::selection` 也用设计主色而非浏览器蓝 |

浮层一律「阴影 + 1px 描边」成对出现，避免只有阴影时在浅底上糊成一片。

字体全部**本地打包**（`src/assets/fonts/`，拉丁子集 12 个 woff2，由 `scripts/fetch_fonts.py` 生成），
因为 CSP 是 `default-src 'self'`，运行时拉不到 Google Fonts；中文回落到系统字体。
