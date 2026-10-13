# 开发

## 环境

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| Windows | 10 1809+ / 11 | 应用本身只支持 Windows；Rust 代码在其它平台上也能 `cargo check`（有几处 `#[cfg(not(windows))]` 兜底） |
| Node.js | ≥ 22.6 | 一致性校验脚本用到 Node 的类型剥离（`--experimental-strip-types`） |
| pnpm | 12.x | 包管理器。`package.json` 里钉了 `packageManager` 字段 |
| Rust | ≥ 1.77 | 见 `src-tauri/Cargo.toml` 的 `rust-version` |
| .NET Framework | 4.8+ | 只有运行 ILMerge / ConfuserEx 时需要，开发界面不需要 |

```bash
pnpm install
```

> 本项目使用 **pnpm**，仓库里只有 `pnpm-lock.yaml`。不要用 npm 或 yarn 生成锁文件 —— 两个包管理器
> 各自的锁文件会互相不一致，而 `tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand`
> 也假定 pnpm。

## 命令

```bash
pnpm run app:dev          # Tauri 开发模式（Vite dev server 固定 1420 端口）
pnpm run app:build        # 产出 NSIS 安装包 → src-tauri/target/release/bundle/nsis/
pnpm run build:preview    # 类型检查 + 构建浏览器预览 → dist-preview/（可直接 file:// 打开）
pnpm run check:render-parity   # 校验两侧模板生成器逐字一致

cd src-tauri
cargo test                     # Rust 单元测试
cargo test -- --ignored        # 需要外网的测试：真实下载工具 + 生成一致性 fixture
cargo fmt                      # 提交 Rust 代码前跑一下（CI 会检查）
cargo clippy --all-targets -- -D warnings
```

- **前端没有 lint 或 formatter**。类型检查是 `tsc --noEmit`，只在 `build` / `build:preview` 里跑。
  `tsconfig.json` 开了 `noUnusedLocals` / `noUnusedParameters`，未使用的变量会让构建失败。
- **Rust 有格式与 lint 门禁**：`cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings`
  都是干净的，CI 会卡住。`defaults.rs` 的测试模块有一处**限定在模块内**的
  `#[allow(clippy::field_reassign_with_default)]` —— 用例表那种「先取默认值再逐项覆盖」的写法更好读。
- 单跑一条 Rust 测试：`cargo test <过滤词>`，例如 `cargo test defaults::`。

## 只调试界面（不启动 Tauri）

浏览器预览用一套假的 Tauri IPC 层（`preview/mock.ts`）把界面跑起来，数据是写死的样例工程。

```bash
pnpm run dev          # 然后浏览器打开 http://localhost:1420/preview.html
# 或：pnpm run build:preview 后直接打开 dist-preview/preview.html（无需 dev server）
```

预览页支持以下查询参数，便于单独调试某一块界面：

| 参数 | 作用 |
| --- | --- |
| `?skin=swiss` / `?skin=terminal` | 指定设计 |
| `?theme=light` / `?theme=dark` | 指定主题（同时退出自动模式） |
| `?material=on` | 让 mock 回报「窗口材质可用」，走一遍半透明 chrome 的分支（浏览器里没有 DWM，默认恒为实色） |
| `?pick=none` | 让文件选择框一律返回「用户取消」，用于验证取消分支 |
| `?dialog=settings` | 自动打开设置面板 |
| `?dotnet=missing` | 模拟未安装 .NET Framework，用于验证环境告警横幅 |

覆盖结果会先写进 `localStorage`，再交给 `src/skin.ts` 的皮肤控制器读取，
所以预览参数与界面上的切换器不会互相打架。

`preview/entry.ts` 必须用**动态 import** 拉 `src/main.ts`：静态 import 会被提升，mock 就装不上了。
这个问题只有构建产物会暴露（dev 下 ESM 原生按声明顺序求值，看不出问题）。

## 界面回归探针

没有前端单元测试，安全网是 `scripts/ui-probe.mjs` —— 用 Chrome DevTools Protocol 驱动真实浏览器，
逐项断言计算样式与 DOM 状态（不是靠截图目测）。

**推荐路径：不需要 dev server**（也避免占用 1420 端口）：

```bash
pnpm run build:preview
node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/dist-preview" docs/shots
```

也可以沿用 dev server：

```bash
pnpm run dev                  # 另开一个终端
node scripts/ui-probe.mjs     # 默认 http://localhost:1420
```

探针需要一个 Chromium 系浏览器：先看 `CHROME_PATH`，否则依次试常见安装位置
（Chrome 64/32 位、Edge 64/32 位）。**Edge 也能跑** —— 两者是同一个引擎、同一套 CDP
与命令行开关，实测截图逐字节一致。都找不到时会明确提示怎么指定，不会静默失败。

它按六组断言跑完，最后打印 `FAIL` 列表并以退出码反映结果（失败 1 / 通过 0）：

- **A. 设计切换** —— 用 `Emulation.setEmulatedMedia` 模拟系统明暗：自动模式实时跟随；
  手动后系统变化不再影响界面；每套设计各记自己的明暗；刷新后皮肤与模式都持久化。
- **B. 原生感** —— 标题栏高度、caption 按钮 46px 通高直角、状态栏、正文 12px、`user-select: none`、
  箭头光标、83/167/250ms 动效令牌、2px 焦点环；材质的两条路径（浏览器里必须降级为实色，
  `?material=on` 时必须半透明且 `html` / `body` 完全透明）。
- **C. 交互** —— 右键菜单的 `role=menu` 与键盘语义、文件树的 roving tabindex 与方向键导航、
  对话框 `Esc` 必须让调用方的 Promise 结束、对话框主操作在左、新建工程对话框的「浏览」按钮真的能浏览。
- **D. 向导** —— 五步结构与旧的三块操作区确实消失、点步骤条可跳步、文件树三个热区互不干扰、
  搜索收敛、折叠后底栏「当前显示」即时刷新且不动勾选、打包排除项的增删、
  加密开关驱动模板重建、手工改模板后的提示与「交回开关托管」、
  **全部执行**跑完三步并列出产出文件、终端皮肤下同一套结构仍然成立。
- **E. 选项面** —— 分组渲染且每项都有默认值标注与适用场景说明、参数项的条件显示、
  四档预设联动、参数真的落进模板（`<argument>` 逐个校验、`snKey` 必须在 `<module>` 上）、
  压缩档位 / LZMA 参数 / 分卷 / 整包加密 / 签名、绿色版丢掉快捷方式与卸载项、
  「恢复默认」把整组按 schema 重置、产出校验清单出现在产物里。
- **F. 修复回归** —— 盯的是「重构之后容易再坏掉」的接线与语义：步骤条的 tab 语义与方向键、
  合并页「重新扫描」按钮确实接了线（它曾经是个死按钮）、toast 是 live region、
  schema 里的 `writes` 真的被消费、口令字段用 `type="password"` 且所有控件都有标签关联。

截图写入 `docs/shots/`（该目录已 gitignore，每次运行重新生成）。
README 用的精选截图是另一套，见下。

### 探针踩过的坑（都写在脚本注释里）

- **别把毫秒写死成 `167ms`** —— 构建产物会被 Lightning CSS 压成 `.167s`，甚至 `.25s`，用 `isMs()` 换算再比。
- **`color-mix()` 的计算值不是 `rgba()`** 而是 `color(srgb r g b / a)`，判断半透明要解析 alpha 而不是匹配前缀。
- **树形缩进这类几何问题必须实测 `getBoundingClientRect()`**，不要靠缩放后的截图目测。
- **`press()` 返回的是「要 evaluate 的表达式字符串」，不是 Promise** —— 直接 `await press("Escape")` 什么都不会发生。
- **面板是 `display: none` 时元素拿不到焦点** —— 测文件树之前必须先切到那一步。
- **「视图变了」和「勾选变了」是两件事** —— 折叠目录只改变「看得见几个」，不该触发落盘；
  但底栏必须跟着刷新（这个 bug 真的发生过）。所以树导出两个回调：`onChange` 管勾选、`onView` 管折叠/筛选。
- **断言要挑不依赖前序状态的样本** —— mock 树里只有一个含文件的目录，前面的用例已经把它折起来了。
- **条件显示用 `hidden` + 显式 `display: none`** —— `.opt` 本身是 `display: flex`，只写 `[hidden]` 压不住。

## README 截图

```bash
pnpm run build:preview
node scripts/capture-shots.mjs
```

与探针共用同一套 CDP 手法，但只负责把几个有代表性的界面状态拍下来，写入 `docs/images/`
（**这个目录随仓库提交**，与探针的 `docs/shots/` 分开）。

## 生成器一致性

「选项 → 模板」有两个实现：Rust 的 `src-tauri/src/defaults.rs` 与浏览器侧的 `preview/render.ts`。
两份实现一旦漂移，预览里看到的模板就不是用户实际会拿到的模板 —— 而这种漂移在预览里看起来「挺对」，
只会在真机上暴露。

```bash
cd src-tauri && cargo test --lib dump_render_fixtures -- --ignored   # 用 Rust 生成 fixture
pnpm run check:render-parity                                          # 与 TS 侧逐字比对
```

fixture（`docs/fixtures/render-fixtures.json`，22 个用例覆盖默认值、每条带参数的 protection、
条件参数、强名称签名、XML 转义、分卷、绿色版、加密三态、签名、LZMA 参数、未知取值回退、
以及官方边界值的收敛）**已随仓库提交**，所以第二条命令不装 Rust 也能跑。

**改任何一侧的生成器后都要跑一次。** 新增边界场景时，先在 `defaults.rs::fixture_cases` 里加用例，
再重新生成 fixture。

## Rust 单元测试

集中在几处最容易悄悄改坏、又最难在界面上发现的地方：

- `defaults::tests` —— 「选项 → 模板」的映射。逐条断言参数是否写对位置（`snKey` 在 `<module>` 上）、
  取值是否规范（`LZMAMatchFinder` 要大写、`elements` 要规整成 `SNPI` 的子集）、
  参数是否只在合法组合下出现（`depth` 只跟 `expression`/`x86` 走）、不认识的值是否退回默认、
  `[Files]` 里主程序不会被 `*` 那行重复收录，以及**一组 Inno 官方边界值**（字典大小、块线程数、
  分片大小、每盘片数、KDF 迭代次数）。
- `model::tests` —— `relative_to` 的语义（大小写不敏感、分隔符归一、多字节路径不 panic、
  前缀相同但不是子目录的情况），以及 `auto_ignores` / `ignore_list` 的相对化与去重。
- `pipeline::tests` —— 日志打码必须覆盖所有已知口令参数（漏一个就等于把口令写进日志面板），
  以及产出识别只认「本次新产生 / 本次被改写」的文件、且递归到子目录。
- `store::tests` —— `\\?\` 前缀归一、工程 Id 的路径穿越防护、读不出来的工程文件要被报出来、
  工作目录清理只动陈旧目录（不碰刚建的与下载缓存）。
- `hash::tests` —— 摘要算法用公开测试向量（`"abc"` 与空输入）钉住，另测跨 64KB 块边界不丢字节。
- `download::tests` —— 解压逻辑用真实形状的压缩包覆写（只取 `tools/net452/` 前缀、扁平整包、
  带 `..` 的条目不许逃出目标目录、前缀匹配不到要报错、垃圾输入要报错），
  外加声明自洽性：每个工具都有来源、SHA-256 长度合法、落点与 `ToolSpec` 一致、
  **安装类来源必须带权限提示**。
- `tools::tests` —— 三级回退（自定义 > 内置 > 下载目录）与 Inno Setup 的本机探测。

另有几条**默认忽略**的测试（`cargo test -- --ignored`）：3 条真实去 NuGet / GitHub / 官方源下载并解压，
确认字节数与校验值都对得上（`.nupkg` 里的 `System.Compiler.dll` 必须与 `ILMerge.exe` 一起取出，
ConfuserEx 的 16 个文件一个都不能少 —— 这两条只有拿真包才能验）；
1 条生成 `docs/fixtures/render-fixtures.json`。

> ILMerge 的 `.nupkg` 里带 `.signature.p7s`（stored 压缩），这是 NuGet 用来验签的，
> 与运行无关，解压时直接忽略。

## 构建

```bash
pnpm run app:build    # 产出 NSIS 安装包，位于 src-tauri/target/release/bundle/nsis/
```

CI 里由 `release.yml` 跑同一条命令（推 `v*` 标签时自动附到 Release）。本地打标签即可发版：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`tauri.conf.json` 里 `targets: ["nsis"]`、`installMode: "currentUser"`（装到当前用户目录，不需要管理员权限）。
`bundle.resources` 包含 `resources/tools`（内置的 ILMerge 与 ConfuserEx）与 `resources/isl`
（Inno Setup 中文语言包）—— 模板本身不随包分发，它们由 Rust 生成。

## 目录结构

```
├── index.html                  应用入口（含首帧设计引导脚本）
├── preview.html                浏览器 UI 预览入口
├── vite.config.ts              主构建配置（dev server 固定 1420）
├── vite.preview.config.ts      预览专用构建（base: "./" + 独立 outDir，不污染应用包）
├── .github/workflows/          CI（四条门禁）与 Release（构建安装包）
├── docs/
│   ├── images/                 README 用的精选截图（随仓库提交）
│   ├── fixtures/               Rust 侧生成结果的黄金样本（一致性校验用，随仓库提交）
│   ├── shots/                  探针截图（gitignore，每次运行重新生成）
│   └── *.md                    本文档与其它主题文档
├── preview/
│   ├── entry.ts                预览唯一入口（动态 import，保证 mock 先于界面装好）
│   ├── render.ts               浏览器侧的模板生成器（defaults.rs 的镜像）
│   └── mock.ts                 Tauri IPC 模拟层 + 假数据
├── scripts/
│   ├── fetch_fonts.py          下载并本地化拉丁字体子集
│   ├── make_icons.py           由矢量源生成各尺寸图标
│   ├── capture-shots.mjs       抓取 README 截图
│   ├── check-render-parity.mjs 校验两侧生成器逐字一致
│   └── ui-probe.mjs            CDP 驱动的界面回归探针
├── src/                        前端（TypeScript + TailwindCSS）
└── src-tauri/                  Rust 后端
    ├── resources/
    │   ├── tools/              外部工具链（ILMerge / ConfuserEx；Inno 由运行时下载或使用本机，见其中 README）
    │   └── isl/                Inno Setup 中文语言包（官方发行版不含中文）
    └── tauri.conf.json
```

## CI

`.github/workflows/` 下两个工作流。

### `ci.yml` —— 推 `main` 与每个 PR

| Job | 运行环境 | 内容 |
| --- | --- | --- |
| `frontend` | ubuntu-latest | `pnpm install --frozen-lockfile` → `build:preview`（含 `tsc --noEmit`）→ `check:render-parity` |
| `rust` | windows-latest | `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` → `cargo test` |
| `ui-probe` | windows-latest | 构建预览 → 跑 CDP 探针；截图作为产物保留 7 天（失败时也上传，便于对照） |

两个 Windows job 而不是 Linux：Windows 是唯一的目标平台。放到 ubuntu 上要额外装
`webkit2gtk` 之类的系统依赖，而且测的不是真实环境。GitHub 的 Windows runner 自带 Edge，
探针脚本会自己探测到它。

`concurrency` 按分支分组且 `cancel-in-progress`：连续推几次不会排队跑一堆已经过时的任务。

### `release.yml` —— 推 `v*` 标签或手动触发

`pnpm run app:build` 产出 NSIS 安装包：

- **推 `v*` 标签** → 构建后创建 GitHub Release（`--generate-notes` 自动汇总变更）并附上安装包；
  若 Release 已存在则改为补传（`--clobber`），所以「先手写 Release、再让 CI 补产物」也行。
- **手动触发** → 只上传为工作流产物，用来随时验证打包链路是否还通。

### 刻意不放进 CI 的东西

`cargo test -- --ignored` 里那三条联网测试（真实下载 NuGet / GitHub / 官方源并核对 SHA-256）
**没有**进 CI：它们依赖外网与第三方站点的可用性，让它们卡住 PR 只会制造噪声。需要时手动跑。

## 交付前的最小检查清单

```bash
pnpm run build:preview                                            # 含 tsc --noEmit
pnpm run check:render-parity                                      # 若动过模板生成器
node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/dist-preview" docs/shots
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

全绿再提交（CI 会再跑一遍同样的东西）。改过界面就顺带看一眼 `docs/shots/` 里对应的截图，
确认观感没有意外变化。

**另外两类改动必须额外验证：**

- **改了打包脚本的 `[Setup]` 指令或语言包引用** → 用真实 ISCC 编译一次。
  单测只能证明字符串写对了，证明不了「ISCC 是否认识这条指令」「语言包文件在不在」。
  最省事的做法是照 `docs/options.md` 附录 A 的方式，用生成器产出一份脚本、
  把占位符换成实际路径、再交给 `ISCC.exe` 编译。
- **改了内置工具目录** → 用 `cargo test -- --ignored` 核对版本与校验值。
  解析顺序是「内置 > 下载」，放一份旧版本会静默压住正确的版本。
