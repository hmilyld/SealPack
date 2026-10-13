#!/usr/bin/env node
/**
 * README 截图抓取。
 *
 * 与 `ui-probe.mjs` 共用同一套 CDP 手法，但目的不同：探针是**断言**界面行为，
 * 这里只是把几个有代表性的界面状态拍下来，供 README 引用。
 *
 * 用法（先构建预览产物，不需要 dev server）：
 *   pnpm run build:preview
 *   node scripts/capture-shots.mjs
 *
 * 产物写入 `docs/images/`（这个目录是随仓库提交的，与探针的 `docs/shots/`
 * 分开 —— 后者每次跑探针都会重新生成，已 gitignore）。
 *
 * 想换尺寸或浏览器：改 `VIEWPORT`，或用 `CHROME_PATH` 指定 chrome.exe。
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] ?? `file:///${ROOT.replace(/\\/g, "/")}/dist-preview`;
const OUT = process.argv[3] ?? join(ROOT, "docs", "images");
const PORT = 9334;
const VIEWPORT = { width: 1360, height: 900 };
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Users/hmilyld/.agent-browser/browsers/chrome-155.0.8059.39/chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(tmpdir(), `sealpack-shots-${Date.now()}`);
mkdirSync(OUT, { recursive: true });
mkdirSync(profile, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-extensions",
    // file:// 下 localStorage 默认被当作不透明源，皮肤持久化就取不到了
    "--allow-file-access-from-files",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let seq = 0;
const pending = new Map();

const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) =>
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result),
    );
    ws.send(JSON.stringify({ id, method, params }));
  });
};

async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(250);
  }
  throw new Error("无法连接到 Chrome 调试端口");
}

const url = await connect();
ws = new WebSocket(url);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const done = pending.get(msg.id);
  if (done) {
    pending.delete(msg.id);
    done(msg);
  }
});

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  ...VIEWPORT,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${expression}`);
  return r.result.value;
};

const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click(); true`);

/**
 * 依次执行准备动作。
 * 每一项是 `{ selector }`（点击）或 `{ expression }`（求值），可带 `wait`（毫秒）。
 */
async function runSteps(steps = []) {
  for (const item of steps) {
    if (item.expression) await evaluate(item.expression);
    else if (item.selector) await click(item.selector);
    await sleep(item.wait ?? 500);
  }
}

async function shoot({ name, path, prepare }) {
  await send("Page.navigate", { url: `${BASE}${path}` });
  await sleep(1800);
  await runSteps(prepare);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  · ${name}.png`);
}

/** 打开某个向导步骤并等面板稳定（面板有 display:none → flex 的过渡） */
const step = (id) => `.step[data-step="${id}"]`;

console.log(`抓取 README 截图 → ${OUT}`);

await shoot({ name: "01-setup", path: "/preview.html?skin=swiss&theme=light" });
await shoot({
  name: "02-merge",
  path: "/preview.html?skin=swiss&theme=light",
  prepare: [{ selector: step("merge"), wait: 1200 }],
});
await shoot({
  name: "03-encrypt",
  path: "/preview.html?skin=swiss&theme=light",
  prepare: [{ selector: step("encrypt"), wait: 900 }],
});
await shoot({
  name: "04-package",
  path: "/preview.html?skin=swiss&theme=light",
  prepare: [{ selector: step("package"), wait: 900 }],
});
await shoot({
  name: "05-run",
  path: "/preview.html?skin=swiss&theme=light",
  prepare: [
    { selector: step("run"), wait: 700 },
    // 跑一遍「全部执行」，让产出文件与状态徽标都出现在图里
    { selector: '[data-act="run-all"]', wait: 2200 },
  ],
});
await shoot({
  name: "06-terminal-dark",
  path: "/preview.html?skin=terminal&theme=dark",
  prepare: [{ selector: step("merge"), wait: 1200 }],
});
await shoot({
  name: "07-settings",
  path: "/preview.html?skin=swiss&theme=light",
  prepare: [
    { selector: "#settings-btn", wait: 1200 },
    // 让工具链下载条上的进度可见：点一次下载，等它推进到中途
    { selector: ".overlay .tool-row:last-child [data-dl]", wait: 420 },
  ],
});

ws.close();
chrome.kill();
try {
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* Windows 下可能仍被占用，忽略 */
}
console.log("完成。");
