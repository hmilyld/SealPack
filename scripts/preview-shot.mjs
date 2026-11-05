/**
 * 快速预览截图：用 CDP 打开 dist-preview/preview.html 并截一张图。
 *
 * 用法：
 *   pnpm run build:preview
 *   node scripts/preview-shot.mjs [out.png]
 *
 * 它不是回归探针，只用于开发时目测新界面。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "docs/shots/preview-react.png");
const STEP = process.argv[3] ?? "";
const QUERY = process.argv[4] ?? "";
const PORT = 9337;
const ROOT = resolve("dist-preview/preview.html");
const URL = `file:///${ROOT.replace(/\\/g, "/")}${QUERY}`;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error("找不到 Chrome / Edge，请用 CHROME_PATH 指定。");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), `sealpack-shot-${Date.now()}`);
mkdirSync(profile, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-extensions",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
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

try {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      console.error("PAGE EXCEPTION:", JSON.stringify(msg.params.exceptionDetails, null, 2));
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args
        .map((arg) => arg.value ?? arg.description ?? "")
        .join(" ");
      if (text) console.error("PAGE CONSOLE:", text);
    }
    const done = pending.get(msg.id);
    if (done) {
      pending.delete(msg.id);
      done(msg);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: URL });

  for (let i = 0; i < 100; i += 1) {
    const ready = await send("Runtime.evaluate", {
      expression: `document.readyState === "complete" && !!document.querySelector("#root") && document.body.innerText.includes("SealPack")`,
      returnByValue: true,
    }).then((r) => r.result.value);
    if (ready) break;
    await sleep(100);
  }
  await sleep(800);

  if (STEP) {
    const expression =
      STEP === "设置"
        ? `(() => { const btn = document.querySelector('button[title^="设置"]'); btn?.click(); return !!btn; })()`
        : `(() => {
            const tabs = [...document.querySelectorAll('[role="tab"]')];
            const tab = tabs.find((t) => t.innerText.includes(${JSON.stringify(STEP)}));
            if (tab) tab.click();
            return !!tab;
          })()`;
    await send("Runtime.evaluate", { expression, returnByValue: true });
    await sleep(900);
  }

  const bodyText = await send("Runtime.evaluate", {
    expression: `document.body.innerText.slice(0, 2000)`,
    returnByValue: true,
  }).then((r) => r.result.value);
  const rootHtml = await send("Runtime.evaluate", {
    expression: `(document.querySelector("#root")?.innerHTML ?? "").slice(0, 2000)`,
    returnByValue: true,
  }).then((r) => r.result.value);
  console.log("BODY TEXT:", bodyText);
  const treeDebug = await send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('[role="treeitem"]')].slice(0, 8).map((e) => ({ text: e.innerText.replace(/\\n/g, " | "), checked: e.getAttribute("aria-checked") }))`,
    returnByValue: true,
  }).then((r) => r.result.value);
  console.log("TREE:", JSON.stringify(treeDebug));
  const preDebug = await send("Runtime.evaluate", {
    expression: `(() => { const p = document.querySelector("pre"); if (!p) return null; const r = p.getBoundingClientRect(); return { height: r.height, text: p.innerText.slice(0, 120) }; })()`,
    returnByValue: true,
  }).then((r) => r.result.value);
  console.log("PRE:", JSON.stringify(preDebug));

  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT, Buffer.from(data, "base64"));
  console.log(OUT);
} finally {
  ws?.close();
  chrome.kill();
}
