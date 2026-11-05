# 开发

## 环境

| 需求 | 版本 | 说明 |
| --- | --- | --- |
| Windows | 10 1809+ / 11 | 应用本身只支持 Windows |
| Node.js | ≥ 22.6 | 一致性校验脚本用 Node 的类型剥离 |
| pnpm | 12.x | `package.json` 固定 `packageManager` |
| Rust | ≥ 1.77 | 见 `src-tauri/Cargo.toml` 的 `rust-version` |
| .NET Framework | 4.8+ | 只有运行 ILMerge / ConfuserEx 时需要 |

```bash
pnpm install
```

> 本项目使用 **pnpm**，仓库里只有 `pnpm-lock.yaml`。不要用 npm / yarn 生成锁文件。

## 命令

```bash
pnpm run app:dev          # Tauri 开发模式（Vite 固定 1420 端口）
pnpm run app:build        # NSIS 安装包 → src-tauri/target/release/bundle/nsis/
pnpm run build:preview    # tsc --noEmit + 浏览器预览 → dist-preview/
pnpm run check:render-parity
node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/SealPack/dist-preview" docs/shots
node scripts/preview-shot.mjs docs/shots/preview.png [步骤名]
cd src-tauri
cargo test
cargo test -- --ignored  # 外网下载 + fixture 重生成 + 真实 ISCC 编译
cargo fmt
cargo clippy --all-targets -- -D warnings
```

- 前端类型检查是 `tsc --noEmit`，只在 `build` / `build:preview` 里跑；tsconfig strict，`noUnusedLocals` / `noUnusedParameters` 会让构建失败。
- Rust 有格式与 lint 门禁；提交前跑 `cargo fmt` 与 `cargo clippy`。
- 单个 Rust 测试：`cargo test <过滤词>`，例如 `cargo test excludes::`。
- `packaging::tests::real_iscc_compiles_full_and_upgrade_scripts` 需要本机安装 Inno Setup 6；它会把完整包与升级包脚本各编译一次，验证 `[Code]` / `[InstallDelete]` / 显式 `Source` 行。
- `packaging::tests::real_install_upgrade_and_uninstall` 会真实安装到 `%TEMP%` 并写 HKCU 卸载项（随机 AppId，`Drop` 里跑卸载器）；它验证完整 v1 → 升级 v2 → 卸载的整条链路，按需单独运行。

## 只调试界面（不启动 Tauri）

浏览器预览用一套假的 Tauri IPC 层（`preview/mock.ts`）把界面跑起来，数据是写死的样例工程。

```bash
pnpm run dev          # 浏览器打开 http://localhost:1420/preview.html
# 或：pnpm run build:preview 后直接打开 dist-preview/preview.html
```

预览页参数：

| 参数 | 作用 |
| --- | --- |
| `?theme=light` / `dark` / `system` | 指定主题（写进 localStorage，由 ThemeProvider 接管） |
| `?material=on` | mock 回报 Mica 可用，走半透明 chrome 分支 |
| `?pick=none` | 文件选择框一律取消 |
| `?dialog=settings` | 自动打开设置对话框 |

`preview/entry.ts` 必须**动态 import** `../src/main.tsx`：静态 import 会被提升，mock 就装不上了。这个问题只有构建产物会暴露（dev 下 ESM 原生按声明顺序求值，看不出问题）。

## 界面回归探针

没有前端单元测试，安全网是 `scripts/ui-probe.mjs`：CDP 驱动真实 Chromium，断言主题、原生感、交互、文件树、打包语义、选项预设、预检与执行状态。

```bash
pnpm run build:preview
node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/SealPack/dist-preview" docs/shots
```

也可以对着 dev server：

```bash
pnpm run dev
node scripts/ui-probe.mjs http://localhost:1420 docs/shots
```

探针按 A–J 分组：

- **A 主题**：light / dark / system 三态、系统明暗跟随、持久化。
- **B 原生感**：标题栏 40px、状态栏 28px、正文 14px、`user-select:none`、箭头光标、五个步骤。
- **C 交互**：合并树渲染、目录三态、勾选变化、工程行右键菜单、Esc、步骤条方向键。
- **D 向导与文件树**：合并页隐藏主程序、合并清单、打包页正向勾选、自动项锁定、打包计数一致。
- **E 选项**：加密预设、模板重建、打包预设切换。
- **F 执行与预检**：预检清单、有警告先确认、单独执行后状态与产物。
- **G 持久化**：刷新后主题保持。
- **H 升级包**：产物切换、基线卡、新增/修改/删除差异、两者产出两个安装包。
- **I 设置**：设置弹窗存在、footer 在弹窗内、内容区高度受限。
- **J 工程管理**：右键重命名（智能预填产品名）、工程栏同步、删除确认只删配置。

截图写入 `docs/shots/`（gitignored）。README 用的精选截图是另一套，见 `scripts/capture-shots.mjs`。

探针踩过的坑：

- `press()` 返回「要 evaluate 的表达式字符串」，不是 Promise。
- 面板在 `display:none` 时元素拿不到焦点；测树之前先切到对应步骤。
- `file://` 下 localStorage 需要 `--allow-file-access-from-files`。
- Fluent 的 Dialog / Menu / Toast 都走 portal，选择器要在整个 document 里找。
- Fluent 组件对 `data-testid` 的透传不保证；优先用 `role` / `aria-label` / `title` / 自定义 `data-step`。
- 文本断言要小心 `innerText` 在 grid 里会换行（例如“打包”和“6 个文件”是两行）。

## 生成器一致性

`defaults.rs` 与 `preview/render.ts` 是同一套模板生成逻辑的两份实现。`check:render-parity` 用 Rust dump 的 fixture 与 TS 输出逐字比对。

```bash
pnpm run check:render-parity
# 改了生成器后重生成 fixture：
cd src-tauri && cargo test --lib dump_render_fixtures -- --ignored
```

## 目录结构

```
src/                      React 前端（见 docs/architecture.md 的模块地图）
preview/                  浏览器预览 mock 与渲染镜像
scripts/                  ui-probe / capture-shots / preview-shot / 一致性校验
src-tauri/src/            Rust 后端
src-tauri/resources/      内置工具、Inno 中文语言包
docs/                     指南、选项、架构、开发、数据安全、计划
docs/fixtures/            模板一致性 fixture
docs/shots/               探针截图（gitignored）
```

## README 截图

界面稳定后运行：

```bash
pnpm run build:preview
node scripts/capture-shots.mjs
```

截图写入 `docs/images/`，是提交到仓库的精选集。
