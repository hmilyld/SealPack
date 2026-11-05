# AGENTS.md

SealPack 是 **Windows-only 的 Tauri 2 桌面应用**：前端 **React 18 + TypeScript + Fluent UI React v9 + Griffel + Zustand**（`src/`），后端 Rust（`src-tauri/`）。它编排三个外部工具（ILMerge → ConfuserEx → Inno Setup），本身不实现加密算法。注释、文档与 UI 文案使用中文，请保持这个约定。

## 命令

包管理器是 **pnpm**（`package.json` 固定了 `packageManager`），仓库里只有 `pnpm-lock.yaml`。

```bash
pnpm run app:dev              # Tauri 开发模式（Vite 1420 端口，strict）
pnpm run app:build            # NSIS 安装包 → src-tauri/target/release/bundle/nsis/
pnpm run build:preview        # tsc --noEmit + 浏览器预览 → dist-preview/
pnpm run check:render-parity  # preview/render.ts vs defaults.rs，逐字比对
node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/SealPack/dist-preview" docs/shots
node scripts/preview-shot.mjs docs/shots/preview.png [步骤名]   # 快速目测截图
cd src-tauri && cargo test
cd src-tauri && cargo test -- --ignored   # 外网下载 + fixture 重生成
```

- 前端类型检查是 **`tsc --noEmit`**（不是 `vue-tsc`），只在 `build` / `build:preview` 里跑。tsconfig 是 strict，`noUnusedLocals` / `noUnusedParameters` 会让未使用变量直接失败。
- **没有前端 lint / formatter**；保持现有风格即可。Rust 有 `cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings`，CI 会卡住。
- 单个 Rust 测试：`cargo test <过滤词>`，例如 `cargo test excludes::`。
- `check:render-parity` 依赖 `docs/fixtures/render-fixtures.json`。改 `defaults.rs` 或 `preview/render.ts` 后必须重跑；重生成 fixture：`cargo test --lib dump_render_fixtures -- --ignored`。
- CI 在 PR 与 `v*` 标签上跑；推 `main` 不触发。发版由 `release.yml` 构建 NSIS 安装包。

## 交付前最低检查

```bash
pnpm run build:preview
node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/SealPack/dist-preview" docs/shots
pnpm run check:render-parity
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
```

## UI 回归探针

没有前端单元测试，安全网是 `scripts/ui-probe.mjs`：CDP 驱动真实 Chromium，断言主题、原生感、交互、树、选项、预检与执行状态。它按 A–J 分组输出 PASS/FAIL，失败退出码 1，并把截图写到 `docs/shots/`（gitignored）。README 截图是另一套，走 `scripts/capture-shots.mjs`。

预览页参数：

| 参数 | 作用 |
| --- | --- |
| `?theme=light` / `dark` / `system` | 指定主题（写进 localStorage，由 ThemeProvider 接管） |
| `?material=on` | mock 回报 Mica 可用，走半透明 chrome 分支 |
| `?pick=none` | 文件选择框一律取消，用于验证取消分支 |
| `?dialog=settings` | 自动打开设置对话框 |

探针踩过的坑：

- **`press()` 返回的是要 evaluate 的表达式字符串**，不是 Promise。
- 面板在 `display:none` 时元素拿不到焦点；测树之前先切到对应步骤。
- 主题持久化写在 `localStorage["sealpack:theme"]`；`file://` 下必须带 `--allow-file-access-from-files`。
- Fluent 的 `Dialog` / `Menu` / `Toast` 都走 portal，选择器要在整个 document 里找。
- Fluent 组件对 `data-testid` 的透传不保证；优先用 `role` / `aria-label` / `title` / 稳定的自定义属性（如 `data-step`）。

## 架构事实（容易改错的点）

### 前端

- **选项 schema 是唯一事实源**：加密/打包选项在 `src/types.ts` 的 `ENCRYPT_GROUPS` / `PACKAGE_GROUPS`，带 `kind` / `def` / `when` / `writes`。UI 按 schema 渲染，不要为单个选项手写控件。
- **模板只由 Rust 生成**：`defaults.rs::encrypt_config` / `package_script` 是唯一实现；前端调用 `render_encrypt_config` / `render_package_script`。`preview/render.ts` 是浏览器镜像，改任一边都要跑一致性校验。
- **模板被手改后停止覆盖**：`generated == false` 时以模板为准；`optionsStore` 的 `setGenerated` 负责切换。
- **状态分 store**：`projectStore`（工程、600ms 防抖保存）、`workspaceStore`（扫描树、epoch、排除项）、`optionsStore`（选项与模板重建）、`buildStore`（阶段、日志、取消、历史）、`settingsStore`（工具链/运行时）、`uiStore`（步骤/浮层/抽屉）。`projectStore.update` 要同步 `projects` 列表（工程栏显示的是列表副本）；`projectStore.reload` 先 `flush` 再从磁盘重读，当前工程还要调用 `workspaceStore.rescan` 重扫目录；删除工程只删 JSON，不动主程序与输出目录。
- **异步写回要代次守卫**：`ensureTree` / `refreshIgnores` 各有一个单调递增 epoch；回来时对不上就丢弃。**两个计数器必须分开**——勾选文件会触发排除项刷新，共用一个会让在途扫描自我作废。每条早退路径都要把 `scanning` 落地。
- **长任务前快照工程**：`buildStore.runStage` / `runAll` 捕获 `project.id`，写回前校验；运行期间工程栏锁定。
- **防抖保存必须 flush**：`projectStore.select` / `refresh` 前 `flush()`；删除当前工程用 `discard()`。
- **只有一套主题**：`ThemeProvider` 用 `FluentProvider` + `createLightTheme` / `createDarkTheme`；状态是 `system | light | dark`，存 `sealpack:theme`。**不要恢复 `data-skin` / 两套皮肤**。
- **样式 token 只有两层**：应用级尺寸/字号/圆角在 `src/styles/tokens.css`，语义色在 `src/theme/semantic.ts`；组件内部颜色用 Fluent `tokens.*`。组件里不写裸 hex；间距只用 4/8/12/16/20/24/32；字号只用 11/12/14/18/20；圆角只用 4/6/8/10。字体角色：`--app-font-ui`（Segoe UI Variable Text）、`--app-font-display`（Display，页面标题）、`--app-font-mono`（Cascadia Mono，路径/日志/代码）。边框层级：`--app-border-subtle/default/strong`。
- **文件树是自绘扁平树**：`components/tree/FileTree.tsx` + `lib/fileTree.ts`，用 `@tanstack/react-virtual` 做虚拟滚动。不用 Fluent `FlatTree` 的原因：30px 行高、三态勾选、大小/状态列、锁定项和 8000 节点性能都需要完全控制。**整行点击 = 切换选中；箭头 = 展开/折叠；勾选框 = 切换选中**；锁定行只聚焦。
- **打包页勾选 = 打包**（正向语义）：自动项（合并程序集、`.bakup`、根目录内的输出目录）锁定为未勾选；主程序锁定为已勾选。排除项写具体相对路径；`*.pdb` / `docs\*` 这类规则单独作为 chips，不展开成树。
- **合并页隐藏主程序**：`FileTree` 的 `hidden` 属性传入 `exeFile`；否则用户会看到“合并进自己”。
- **预检是 Rust 命令**：`preflight` 检查路径、模板占位符、工具链、运行时；产物含升级包时还会算基线差异并检查安装模式/版本。有 error 禁用「全部执行」，有 warn 才弹确认。不要在前端重复实现路径检查。
- **取消构建**：`CancelState`（`AtomicBool` + PID）在 `store.rs`；`cancel_build` 用 `taskkill /PID <pid> /T /F` 杀进程树；`StageStatus` 新增 `"cancelled"`。只杀父进程会留下 ISCC 子进程。
- **构建历史**：存在 `Project.buildHistory`，上限 20 条；`buildStore` 在每次 `runStage` / `runAll` 后记录。历史里不写口令；产物类型取 `StageOutcome.artifact`，不要硬编码 `installer`；产物按 Windows 路径去重（合并/加密都会报告主程序），否则同一个 exe 会出现两次。
- **升级包只在打包阶段分叉**：`defaults.rs` 只生成一套模板；`packaging.rs` 按产物展开 `${files}` / `${installDelete}` / `${artifactSetup}` / `${artifactCode}` / `${artifactLabel}` / `${runSection}`。合并/加密不感知升级包。
- **升级差异全自动**：`manifest.rs` 用基线清单的 SHA-256 逐文件比对；新增/修改进包，删除进 `[InstallDelete]`，未变化不重复打包。界面只读，不做手工勾选。
- **每次成功打包写基线**：输出目录 `sealpack-manifest-<版本>.json` 描述**完整安装状态**（不是增量）。升级包只支持 `single + uninstallable`；绿色版、分卷、关闭卸载程序由预检拦截。
- **升级安装器校验旧版本**：`[Code]` 查 `<AppId>_is1` 卸载注册表；没有旧版本直接中止，版本不一致弹确认，安装模式必须与基线一致。
- **保存日志**：`save_log` 写 UTF-8 with BOM，方便记事本看中文；口令在日志里已打码。
- **对话框主操作在右**：Fluent 的约定是取消在左、主操作在右；探针按这个断言。
- **全局快捷键不 `stopPropagation`**：`desktop.ts` 只在 window 捕获阶段 `preventDefault`；浮层自己处理 Esc。
- **窗口 `visible:false` 的两半都不能删**：前端首帧后 `show()`；Rust 1.5s 兜底。`index.html` 的内联主题脚本依赖 Tauri 注入 CSP hash/nonce。
- **CSP 是 `script-src 'self'`**：没有远程字体/CDN；字体用系统 Segoe UI Variable / Cascadia Mono。`style-src` 允许内联，Griffel 才能工作。
- **注册 Tauri 命令是两步**：`commands.rs` 定义 + `lib.rs` 的 `invoke_handler!` 列表。

### Rust 后端

- `Cargo.toml` 的 `indexmap = { features = ["std"] }` 是 schemars/tauri-build 的 workaround，不要删。
- `reqwest` 用 `native-tls`（SChannel），`zip` 只开 `deflate`；不要改成 rustls。
- 工具版本与下载地址在 `download.rs::SOURCES` 用 SHA-256 钉死；内置目录布局必须匹配 `tools.rs::ToolSpec::relative`。
- 工具解析顺序：**用户设置 > 内置 `resources/tools` > 用户下载目录**。内置旧版本会静默压住下载的正确版本（真实踩过：Inno 6.1 vs 6.7.3）。
- 简体中文语言包随应用分发（`resources/isl/ChineseSimplified.isl`），Inno 官方发行版不带；改 `[Languages]` 或 isl 必须用真实 ISCC 编译验证。
- Inno 边界值集中在 `defaults.rs` 顶部，`preview/render.ts` 有同名常量；改一处必须改另一处并跑一致性校验。
- **安装包的 `AppId` 不能由工程 id 推导**：工程 id 是随机 UUID；`AppId` 来自主程序产品身份（`commands.rs::detect_app_id`），否则重新打包会装出第二份。
- **工程 JSON 不写 serde 默认值**：`Project` / `EncryptOptions` / `PackageOptions` / `BuildOptions` 上没有 `#[serde(default)]`。唯一的例外是 `Project.schemaVersion`（旧文件缺字段），由 `store.rs::migrate_project` 补齐 `buildHistory` / `buildOptions` 并升到 3，再严格反序列化。真正损坏的文件仍然报错。
- **排除项匹配有两份实现**：Rust `excludes.rs::matches` 与前端 `PackageStep` / `preview/mock.ts` 的 `matchPattern`。语义：含 `\` 匹配完整相对路径，否则匹配文件名；`*` 含 `\`，`?` 单字符；大小写不敏感。改一处要同步另一处。
- **输出目录在根目录内时自动排除**：`Project::output_dir_ignore` 返回 `相对路径\*`；输出目录等于根目录时拒绝排除并由预检报错。
- 值处理：工程 JSON 可手改，枚举值在写模板前过白名单（`defaults.rs::pick`）；`snKey` / `snKeyPass` 在 `<module>` 上；Inno `Encryption=full` 仍要 `Password`。
- `Settings::load` 解析失败会回退默认值，但往 stderr 留痕。

## 文档地图

| 文件 | 内容 |
| --- | --- |
| `README.md` | 软件介绍 + 截图（只留介绍，不放实现细节） |
| `docs/plans/ui-redesign.md` | 本次 React/Fluent 重写与升级包计划、进度 |
| `docs/guide.md` | 使用指南：五步向导、文件树、排除项、快捷键、主题 |
| `docs/options.md` | 每个选项的语义 + 模板生成规则 + Inno 边界值附录 |
| `docs/architecture.md` | 模块地图、数据流、不变量清单 |
| `docs/development.md` | 环境、命令、构建、测试、探针、一致性校验、目录结构 |
| `docs/data-and-security.md` | 数据位置、口令明文、下载校验、日志打码、注入面 |
