# AGENTS.md

SealPack is a **Windows-only Tauri 2 desktop app**: vanilla TypeScript frontend (`src/`, no UI framework, Tailwind 4 for reset + a few utilities) + Rust backend (`src-tauri/`). It orchestrates three external tools (ILMerge → ConfuserEx → Inno Setup) and implements no crypto itself. Comments, docs, and UI strings are in Chinese — follow that convention.

## Commands

Package manager is **pnpm** (`package.json` pins `packageManager`). Only `pnpm-lock.yaml` exists.

```bash
pnpm run app:dev              # Tauri dev mode (Vite dev server on port 1420, strict)
pnpm run app:build            # NSIS installer → src-tauri/target/release/bundle/nsis/
pnpm run build:preview        # typecheck + build browser preview → dist-preview/ (openable via file://)
pnpm run check:render-parity  # preview/render.ts vs defaults.rs, byte-for-byte
cd src-tauri && cargo test              # Rust unit tests
cd src-tauri && cargo test -- --ignored # network tests + fixture regeneration
```

- There is **no lint or formatter**. Typecheck is `tsc --noEmit`, run only inside `build` / `build:preview`. tsconfig is strict with `noUnusedLocals` / `noUnusedParameters` — unused vars fail the build. Note `noUnusedLocals` does **not** flag unreferenced *exports*; dead exports only show up via grep.
- Single Rust test: `cargo test <filter>`, e.g. `cargo test defaults::`.
- `check:render-parity` needs `docs/fixtures/render-fixtures.json`, which is committed. Regenerate it after touching either generator: `cargo test --lib dump_render_fixtures -- --ignored`.
- **No CI / no pre-commit hooks** — nothing runs these checks for you.

## Minimum check before handing work back

```bash
pnpm run build:preview
pnpm run check:render-parity                                      # if you touched either generator
node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/dist-preview" docs/shots
cd src-tauri && cargo test
```

## UI regression (verify frontend changes here)

There are no frontend unit tests; the safety net is `scripts/ui-probe.mjs`, a CDP-driven probe asserting computed styles and DOM state across 6 groups (skin/theme, native feel, interaction, wizard, option surface, fix-regressions). It exits 1 on failure and writes screenshots to `docs/shots/` (gitignored). README screenshots are a separate, committed set: `node scripts/capture-shots.mjs` → `docs/images/`.

Probe pitfalls (also in its comments): `press()` returns an expression string to evaluate — not a Promise; compare durations with `isMs()` because Lightning CSS rewrites `167ms` → `.167s`; elements inside `display: none` panels can't take focus.

## Architecture facts an agent will get wrong

Read `docs/architecture.md` for the full list with rationale. The ones that bite most often:

- **Adding a config option = edit the schema only.** Encrypt/package options are declared in `src/types.ts` (`ENCRYPT_GROUPS` / `PACKAGE_GROUPS`) with `kind`/`def`/`when`/`writes`; the UI renders from it and the probe asserts from it. Do not hand-write render code per option.
- **Templates are generated, not authored.** The source of truth is Rust (`defaults.rs`: `encrypt_config` / `package_script`); the frontend calls `render_encrypt_config` / `render_package_script`. `preview/render.ts` is the browser-side mirror — **run `pnpm run check:render-parity` after touching either side** (it compares against committed fixtures in `docs/fixtures/render-fixtures.json`). User-edited templates are flagged `generated: false` and stop being overwritten.
- **Async writes back into module-level state need an epoch guard.** `ensureTree` / `refreshIgnores` write to `treeNode` / `ignores`; without the guard, switching projects mid-request mounts the previous project's tree and writes its paths into the new project's `mergeDlls`. Two separate counters (`scanEpoch` / `ignoreEpoch`) — selecting files triggers an ignore refresh, which must not invalidate an in-flight scan. Every early-return path must also clear `scanning`, or a discarded request leaves "扫描中…" on the step bar forever.
- **Snapshot `current` before any long await.** `runStage` / `runAll` capture the project and verify `current.id` before writing statuses, artifacts, or the save indicator; the project rail is disabled while `busy`.
- **Debounced saves must be flushed before switching projects.** `scheduleSave` is a 600ms debounce whose callback uses the captured `proj`; `selectProject` / `refreshProjects` call `flushPendingSave()` first, and deleting the current project calls `discardPendingSave()`.
- **Two skins share one DOM.** Swiss vs terminal differs 100% in CSS keyed off `data-skin` / `data-theme` on `<html>`; state lives solely in `src/skin.ts`. Never fork the DOM per skin. Cascade trap: `components.css` wraps its rules in `@layer components` while skins are **unlayered** — unlayered author styles beat layered ones at any specificity, so a skin's rest-state `background` beats the component's `:hover`. Skin `:hover` overrides must be written in the skin file itself.
- **Registering a Tauri command is two steps**: define in `commands.rs` *and* add to the `invoke_handler!` list in `lib.rs`.
- **Global shortcut handlers must not `stopPropagation`** — dialogs and the context menu handle their own `Esc`; swallowing it globally breaks them.
- **CSP is `script-src 'self'`** (no `'unsafe-inline'`). The first-frame theme bootstrap is an inline script in `index.html`; it works only because Tauri injects a CSP hash/nonce at build time. No remote fonts/CDNs will load — all fonts are local woff2 in `src/assets/fonts/` (regenerate via `scripts/fetch_fonts.py`).
- Window is created `visible: false`; the frontend must call `show()` after the first painted frame (Rust has a 1.5s fallback). Don't remove either half.

## Rust backend gotchas

- `Cargo.toml` carries an `indexmap = { features = ["std"] }` workaround (build + normal deps) for a schemars/tauri-build feature conflict — don't remove it.
- `reqwest` is pinned to `default-features = false` + `native-tls` (SChannel; rustls would need a C toolchain). Same for `zip`: `deflate` only.
- Tool versions and download URLs are pinned with SHA-256 in `download.rs` `SOURCES`; bundled-tool directory layout must match `ToolSpec::relative` in `tools.rs` (see `src-tauri/resources/tools/README.md`).
- Tool resolution order everywhere: user setting > bundled `resources/tools` > user download dir (`%APPDATA%\com.hmilyld.sealpack\tools`). **A stale copy in `resources/tools` silently shadows the downloaded correct version** — this actually happened with Inno Setup 6.1 vs the declared 6.7.3, and the symptom was `Unrecognized [Setup] section directive "EncryptionKeyDerivation"`. Keep bundled copies at the declared versions (or absent).
- **The Simplified Chinese language pack ships with the app** (`resources/isl/ChineseSimplified.isl`), because Inno Setup's official distribution does **not** include it — `compiler:Languages\ChineseSimplified.isl` fails on any stock install. `run_package` copies it next to the generated `.iss` and the script references it by relative path (ISCC resolves relative to the script's directory). Changing the `[Languages]` line or the isl resource requires a real `ISCC.exe` compile to verify.
- **All Inno Setup boundary values live in named constants at the top of `defaults.rs`** (`LZMA_DICT_MIN_KB`, `SLICE_MAX_BYTES`, …), mirrored in `preview/render.ts`. They were verified against the official docs (`https://jrsoftware.org/ishelp/`, `topic_setup_*`) — re-check there before changing, and keep both sides in sync.
- Value handling: project JSON is hand-editable, so all enum values are whitelisted and unknown values fall back to defaults (`defaults.rs::pick`). Known traps pinned by tests: `snKey`/`snKeyPass` belong on ConfuserEx's `<module>` element, not `<project>`; Inno's `Encryption=full` still requires `Password` at compile time (`/PASSWORD=` is a *runtime* switch).
- **No `#[serde(default)]` anywhere.** The app writes every field, so a missing field means a corrupted file — fail loudly instead of silently defaulting. `Settings::load` falls back to defaults but logs to stderr.

## Docs map

| File | Contents |
| --- | --- |
| `README.md` | 软件介绍 + 截图（只留介绍，不放实现细节） |
| `docs/guide.md` | 使用指南：五步向导、文件树、排除项、快捷键、两套设计 |
| `docs/options.md` | 每个选项的语义 + 模板生成规则 + Inno 指令与边界值核实附录 |
| `docs/architecture.md` | 模块地图、数据流、不变量清单 |
| `docs/development.md` | 环境、命令、构建、测试、探针、一致性校验、目录结构 |
| `docs/data-and-security.md` | 数据位置、口令明文、下载校验、日志打码、注入面 |
