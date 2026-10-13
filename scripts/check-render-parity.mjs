#!/usr/bin/env node
/**
 * 校验浏览器侧 `preview/render.ts` 与 Rust 侧 `defaults.rs` 的生成结果**逐字一致**。
 *
 * 背景：预览环境没有 Rust，所以模板生成器有两份实现（Rust 一份、TS 一份）。
 * 两份实现一旦漂移，浏览器里看到的模板就不是用户实际会拿到的模板 ——
 * 而这种漂移在预览里看起来「挺对」，只会在真机上才暴露。
 * 这个脚本把它变成一条可执行断言。
 *
 * 用法：
 *   cd src-tauri && cargo test --lib dump_render_fixtures -- --ignored   # 生成 fixture
 *   node scripts/check-render-parity.mjs                                # 比对
 *
 * 依赖 Node 的类型剥离（Node ≥ 22.6）：直接 import `.ts` 源码，不需要构建。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEncryptConfig, renderPackageScript } from "../preview/render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "docs", "fixtures", "render-fixtures.json");

let raw;
try {
  raw = readFileSync(fixturePath, "utf8");
} catch {
  console.error(`找不到 fixture：${fixturePath}`);
  console.error("请先生成：cd src-tauri && cargo test --lib dump_render_fixtures -- --ignored");
  process.exit(2);
}

const { cases } = JSON.parse(raw);

/** 打印第一处差异的上下文 —— 整份模板太长，逐字打出来反而看不清问题在哪 */
function report(name, kind, expected, actual) {
  console.log(`FAIL  ${name} · ${kind}`);
  const a = expected.split("\n");
  const b = actual.split("\n");
  const lineCount = Math.max(a.length, b.length);
  for (let i = 0; i < lineCount; i += 1) {
    if (a[i] === b[i]) continue;
    console.log(`  Rust  第 ${i + 1} 行：${JSON.stringify(a[i] ?? null)}`);
    console.log(`  浏览器第 ${i + 1} 行：${JSON.stringify(b[i] ?? null)}`);
    break;
  }
  console.log(`  Rust 共 ${a.length} 行 / 浏览器共 ${b.length} 行`);
}

let failed = 0;
for (const testCase of cases) {
  const encrypt = renderEncryptConfig(testCase.encryptOptions);
  const pkg = renderPackageScript(testCase.packageOptions);

  if (encrypt !== testCase.encryptConfig) {
    failed += 1;
    report(testCase.name, "encryptConfig", testCase.encryptConfig, encrypt);
  }
  if (pkg !== testCase.packageScript) {
    failed += 1;
    report(testCase.name, "packageScript", testCase.packageScript, pkg);
  }
}

console.log(`\n比对 ${cases.length} 个用例 · ${cases.length * 2} 份模板`);
if (failed === 0) {
  console.log("两边逐字一致");
  process.exit(0);
}
console.log(`不一致 ${failed} 处 —— 请同步 preview/render.ts 与 src-tauri/src/defaults.rs`);
process.exit(1);
