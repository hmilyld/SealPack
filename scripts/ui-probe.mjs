/**
 * UI 探针 — 用 Chrome DevTools Protocol 驱动真实浏览器验证界面行为。
 *
 * 为什么不用 --screenshot：那样只能看静态首屏，无法点击切换器、
 * 也无法在切换后读取计算样式，更验证不了键盘交互与浮层的生命周期。
 *
 * 覆盖四组断言：
 *   A. 设计切换  两套皮肤 + 明暗三态（跟随系统 / 深色 / 浅色）互不污染、可持久化
 *   B. 原生感    标题栏高度、caption 按钮通高、状态栏、chrome 不可选中、动效令牌、
 *                材质降级与半透明分支
 *   C. 交互      右键菜单（含键盘）、文件树方向键导航、对话框 Esc 必须让 Promise 结束、
 *                新建工程对话框的浏览按钮
 *   D. 向导      五步结构、点步骤条跳步、文件树三个独立点击区、打包排除项增删、
 *                加密开关驱动模板重新生成
 *
 * 用法：node scripts/ui-probe.mjs [baseUrl] [outDir]
 *   默认 http://localhost:1420 与 docs/shots —— 需要先起 dev server（`npx vite`）。
 *   不起 dev server 的替代路径（推荐，避免占用 1420 端口）：
 *     pnpm run build:preview
 *     node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/dist-preview" docs/shots
 *
 * 注意：断言里比对毫秒时不要写死 "167ms"。构建产物会被 lightningcss 压成 ".167s"，
 * 因此统一用 isMs() 兼容两种写法。
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:1420";
const OUT = process.argv[3] ?? "docs/shots";
const PORT = 9333;
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Users/hmilyld/.agent-browser/browsers/chrome-155.0.8059.39/chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(tmpdir(), `sealpack-probe-${Date.now()}`);
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
    // file:// 下 localStorage 默认被当作不透明源，皮肤持久化就测不了
    "--allow-file-access-from-files",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1360,900",
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
  width: 1360,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + expression);
  return r.result.value;
};

/** 模拟系统「应用模式」。这是「跟随系统明暗」唯一的数据来源。 */
const setSystemTheme = (value) =>
  send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value }],
  });

async function goto(path, wait = 1700) {
  await send("Page.navigate", { url: `${BASE}${path}` });
  await sleep(wait);
}

async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  · ${file}`);
}

/** 合成按键事件（与真实键盘走同一条 keydown 路径）。
 *  注意：它返回的是**表达式字符串**，必须交给 evaluate() 执行；
 *  直接 await press(...) 不会派发任何事件（曾因此让两条 Esc 断言假失败）。 */
const press = (key, extra = {}) => `(() => {
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", Object.assign(
    { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true },
    ${JSON.stringify(extra)},
  )));
  return true;
})()`;

// ---------------------------------------------------------------- 断言工具

const results = {};
const failures = [];
const skipped = [];

/** 毫秒令牌可能被压成 `250ms` / `.25s` / `0.25s`，统一换算成数值再比。 */
const isMs = (want) => (v) => {
  const m = String(v).trim().match(/^([\d.]+)(ms|s)$/);
  if (!m) return false;
  const value = m[2] === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
  return Math.abs(value - want) < 0.5;
};
/** color-mix 产出的是 color(srgb r g b / a)，alpha < 1 即为半透明。 */
const translucent = (v) => {
  const s = String(v);
  const m = s.match(/\/\s*([\d.]+)\s*\)/) || s.match(/,\s*([\d.]+)\s*\)/);
  return m ? Number(m[1]) < 1 : false;
};

function check(group, label, actual, expected, opts = {}) {
  results[group] ??= {};
  if (opts.skip) {
    results[group][label] = { actual, skipped: opts.skip };
    skipped.push(`${group} · ${label} — ${opts.skip}`);
    return;
  }
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  results[group][label] = { actual, ok };
  if (!ok) failures.push(`${group} · ${label}: 期望 ${expected}，得到 ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- 采集器

const PROBE = `(() => {
  const cs = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).getPropertyValue(prop).trim() : "(无此元素)";
  };
  const px = (sel, prop) => {
    const v = cs(sel, prop);
    return v.endsWith("px") ? Math.round(parseFloat(v) * 10) / 10 : v;
  };
  const root = document.documentElement;
  const tb = document.querySelector(".titlebar");
  return {
    skin: root.dataset.skin,
    theme: root.dataset.theme,
    themeMode: root.dataset.themeMode,
    material: root.dataset.material,
    darkClass: root.classList.contains("dark"),
    colorScheme: root.style.colorScheme,
    activeOpt: [...document.querySelectorAll(".skin-opt.is-active")].map((b) => b.dataset.opt),
    themeToggleText: (document.getElementById("theme-toggle") || {}).textContent,

    /* ---- B. 原生感 ---- */
    titlebarH: px(".titlebar", "height"),
    winBtnW: px(".win-btn", "width"),
    winBtnH: px(".win-btn", "height"),
    winBtnRadius: px(".win-btn", "border-radius"),
    winBtns: document.querySelectorAll(".win-btn").length,
    statusbarH: px(".statusbar", "height"),
    statusbarItems: document.querySelectorAll(".statusbar-item").length,
    toolchainItems: document.querySelectorAll("#toolchain .statusbar-item").length,
    appFontSize: px(".app", "font-size"),
    appLineHeight: cs(".app", "line-height"),
    appBg: cs(".app", "background-color"),
    titlebarBg: cs(".titlebar", "background-color"),
    chromeSelect: tb ? getComputedStyle(tb).userSelect : "(无标题栏)",
    bodySelect: getComputedStyle(document.body).userSelect,
    bodyCursor: getComputedStyle(document.body).cursor,
    btnCursor: cs(".btn", "cursor"),
    durFast: cs(".app", "--dur-fast"),
    durBase: cs(".app", "--dur-base"),
    durSlow: cs(".app", "--dur-slow"),
    focusRingW: cs(".app", "--focus-ring-width"),
    dragRegion: tb ? tb.hasAttribute("data-tauri-drag-region") : null,
    copyright: (document.getElementById("status-copyright") || {}).textContent,

    /* ---- A. 皮肤隔离：不该有元素同时带上两套设计的字体 ---- */
    leftover: [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      return s.fontFamily.includes("Instrument Sans") && s.fontFamily.includes("Chakra Petch");
    }).length,
  };
})()`;

// ================================================================ A. 设计切换

console.log("\n=== A. 皮肤 + 明暗三态 ===");

console.log("1) 跟随系统 · 系统浅色（默认应是自动模式）");
await setSystemTheme("light");
await goto("/preview.html");
await shot("01-swiss-light-auto");
const a1 = await evaluate(PROBE);
results.A1 = a1;
check("A1", "themeMode", a1.themeMode, "auto");
check("A1", "theme", a1.theme, "light");
check("A1", "skin", a1.skin, "swiss");
check("A1", "皮肤切换器只有一项选中", a1.activeOpt.length, 1);
check("A1", "无皮肤残留", a1.leftover, 0);

console.log("2) 系统切到深色 → 自动模式下界面应实时跟随，无需任何点击");
await setSystemTheme("dark");
await sleep(600);
await shot("02-swiss-dark-auto");
const a2 = await evaluate(PROBE);
results.A2 = a2;
check("A2", "theme", a2.theme, "dark");
check("A2", "themeMode", a2.themeMode, "auto");
check("A2", "colorScheme", a2.colorScheme, "dark");

console.log("3) 点击主题按钮 → 固定深色；此后系统变化不应再影响界面");
await evaluate(`document.getElementById("theme-toggle").click(); true`);
await sleep(400);
await setSystemTheme("light");
await sleep(500);
await shot("03-swiss-dark-manual");
const a3 = await evaluate(PROBE);
results.A3 = a3;
check("A3", "themeMode", a3.themeMode, "manual");
check("A3", "系统转浅色不影响手动深色", a3.theme, "dark");
check("A3", "按钮文案含「深色」", a3.themeToggleText, (v) => String(v).includes("深色"));

console.log("4) 切到「终端」→ 手动模式下应恢复它自己记住的主题（终端默认深色）");
await evaluate(`document.querySelector('.skin-opt[data-opt="terminal"]').click(); true`);
await sleep(500);
await shot("04-terminal-dark-memory");
const a4 = await evaluate(PROBE);
results.A4 = a4;
check("A4", "skin", a4.skin, "terminal");
check("A4", "每套设计各记明暗：终端=深色", a4.theme, "dark");
check("A4", "仍是手动模式", a4.themeMode, "manual");
check("A4", "无皮肤残留", a4.leftover, 0);
check("A4", "只有终端被选中", JSON.stringify(a4.activeOpt), '["terminal"]');

console.log("5) 终端下继续循环 → 浅色");
await evaluate(`document.getElementById("theme-toggle").click(); true`);
await sleep(400);
await shot("05-terminal-light");
const a5 = await evaluate(PROBE);
results.A5 = a5;
check("A5", "theme", a5.theme, "light");
check("A5", "无皮肤残留", a5.leftover, 0);

console.log("6) 再点一次 → 回到自动（系统当前浅色）");
await evaluate(`document.getElementById("theme-toggle").click(); true`);
await sleep(400);
const a6 = await evaluate(PROBE);
results.A6 = a6;
check("A6", "themeMode", a6.themeMode, "auto");
check("A6", "自动=系统浅色", a6.theme, "light");
check("A6", "按钮文案含「自动」", a6.themeToggleText, (v) => String(v).includes("自动"));

console.log("7) 刷新 → 皮肤与明暗都要持久化");
await goto("/preview.html");
await shot("06-terminal-persisted");
const a7 = await evaluate(PROBE);
results.A7 = a7;
check("A7", "skin", a7.skin, "terminal");
check("A7", "theme", a7.theme, "light");
check("A7", "themeMode", a7.themeMode, "auto");

// ================================================================ B. 原生感

console.log("\n=== B. 原生感 / 桌面化 ===");

const B = a7;
check("B", "标题栏 32–40px（Fluent 32px，此处留出皮肤切换器）", B.titlebarH, (v) => v >= 32 && v <= 40);
check("B", "窗口按钮 3 个", B.winBtns, 3);
check("B", "窗口按钮宽 46px（Fluent caption）", B.winBtnW, 46);
check("B", "窗口按钮通高（与标题栏等高，不能差 1px）", B.winBtnH, (v) => Math.abs(v - B.titlebarH) < 0.5);
check("B", "窗口按钮直角（贴边）", B.winBtnRadius, 0);
check("B", "状态栏 20–28px", B.statusbarH, (v) => v >= 20 && v <= 28);
check("B", "状态栏条目 = 3 工具 + 版本 + 版权", B.statusbarItems, 5);
check("B", "工具链状态项 3 个", B.toolchainItems, 3);
check("B", "正文 12px（桌面密度，非网页 13–14px）", B.appFontSize, 12);
check("B", "行高 1.4", B.appLineHeight, (v) => String(v).startsWith("16.8"));
check("B", "界面文字默认不可选中", B.bodySelect, "none");
check("B", "标题栏不可选中", B.chromeSelect, "none");
check("B", "箭头光标而非手型", B.bodyCursor, "default");
check("B", "按钮箭头光标", B.btnCursor, "default");
check("B", "动效 83ms", B.durFast, isMs(83));
check("B", "动效 167ms", B.durBase, isMs(167));
check("B", "动效 250ms", B.durSlow, isMs(250));
check("B", "焦点环 2px 双描边", B.focusRingW, "2px");
check("B", "标题栏是拖拽区", B.dragRegion, true);
check("B", "版权信息存在", B.copyright, (v) => String(v).includes("hmilyld.com"));
check("B", "浏览器里材质必须降级为实色", B.material, "off");
check("B", "降级后标题栏不透明", B.titlebarBg, (v) => !translucent(v));

console.log("8) 强制材质层：检查半透明 chrome 的 CSS 分支（mock 用 ?material=on 让它走可用分支）");
await goto("/preview.html?skin=swiss&theme=light&material=on");
await shot("07-swiss-material-on");
const mat = await evaluate(`(() => {
  const cs = (s, p) => getComputedStyle(document.querySelector(s)).getPropertyValue(p).trim();
  return {
    material: document.documentElement.dataset.material,
    titlebar: cs(".titlebar", "background-color"),
    rail: cs(".rail", "background-color"),
    statusbar: cs(".statusbar", "background-color"),
    app: cs(".app", "background-color"),
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
  };
})()`);
results.B8 = mat;
check("B8", "data-material", mat.material, "on");
check("B8", "标题栏半透明", mat.titlebar, translucent);
check("B8", "侧栏半透明", mat.rail, translucent);
check("B8", "状态栏半透明", mat.statusbar, translucent);
check("B8", "内容底也半透明但更实（Mica Alt 层次）", mat.app, translucent);
check("B8", "html 完全透明（让系统材质透上来）", mat.html, "rgba(0, 0, 0, 0)");
check("B8", "body 完全透明", mat.body, "rgba(0, 0, 0, 0)");

// ================================================================ C. 交互

console.log("\n=== C. 键盘与浮层 ===");

console.log("9) 主题按钮右键 → 自绘菜单（而非 WebView2 原生菜单）");
await goto("/preview.html?skin=swiss&theme=dark");
await evaluate(`(() => {
  const el = document.getElementById("theme-toggle");
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true,
    clientX: Math.round(r.left + r.width / 2),
    clientY: Math.round(r.bottom + 4),
  }));
  return true;
})()`);
await sleep(300);
await shot("08-context-menu");
const c9 = await evaluate(`(() => {
  const m = document.querySelector(".ctx-menu");
  return {
    open: !!m,
    role: m ? m.getAttribute("role") : null,
    inBody: m ? m.parentElement === document.body : null,
    items: m ? [...m.querySelectorAll(".ctx-item")].map((b) => b.textContent.trim()) : [],
  };
})()`);
results.C9 = c9;
check("C9", "菜单已打开", c9.open, true);
check("C9", "菜单带 role=menu", c9.role, "menu");
check("C9", "挂在 body 上（跟随根皮肤）", c9.inBody, true);
check("C9", "含窗口材质开关项", c9.items, (v) => v.some((t) => String(t).includes("窗口材质")));

console.log("10) Esc 关闭菜单");
await evaluate(press("Escape"));
await sleep(250);
check("C10", "菜单已关闭", await evaluate(`!document.querySelector(".ctx-menu")`), true);

console.log("11) 文件树方向键导航（roving tabindex）");
await goto("/preview.html?skin=terminal&theme=dark");
// 树住在「合并」步骤的面板里，其余面板是 display:none —— 隐藏元素无法获得焦点，
// 所以必须先切到那一步，否则这里测的其实是「焦点压根没动」。
await evaluate(`document.querySelector('.step[data-step="merge"]').click(); true`);
await sleep(400);
const c11 = await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".tree li")];
  if (!rows.length) return { error: "没有树行" };
  const first = rows.find((li) => li.classList.contains("dir")) ?? rows[0];
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  const afterDown = document.activeElement;
  afterDown.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  return {
    downMoved: afterDown !== first,
    downName: afterDown.textContent.trim().slice(0, 20),
    homeIsFirst: document.activeElement === rows[0],
    tabbables: rows.filter((li) => li.tabIndex === 0).length,
    rows: rows.length,
  };
})()`);
results.C11 = c11;
check("C11", "有树行可测", c11.error ?? "ok", "ok");
check("C11", "ArrowDown 移动了焦点", c11.downMoved, true);
check("C11", "Home 回到首行", c11.homeIsFirst, true);
check("C11", "全局只有一个 tabindex=0 的行", c11.tabbables, 1);
await shot("09-tree-keyboard");

console.log("12) 量取文件树每一行的实际缩进（必须用 Range 量文字起点，不能目测）");
// 名称现在是 .tree-nm 元素（不再是 li 里的裸文本节点），
// 用 Range 量裸文本节点的老写法会直接量到 null。
const metrics = await evaluate(`(() => {
  return [...document.querySelectorAll(".tree li")].map((li) => {
    const label = li.querySelector(".tree-nm");
    return {
      name: (label ? label.textContent : li.textContent).trim().slice(0, 18),
      dir: li.classList.contains("dir"),
      depth: (() => {
        let d = 0, p = li.parentElement;
        while (p && !p.classList.contains("tree")) {
          if (p.tagName === "UL") d += 1;
          p = p.parentElement;
        }
        return d;
      })(),
      textLeft: label ? Math.round(label.getBoundingClientRect().left) : null,
    };
  });
})()`);
{
  const byDepth = new Map();
  for (const row of metrics) {
    if (row.textLeft === null) continue;
    const list = byDepth.get(row.depth) ?? [];
    list.push(row.textLeft);
    byDepth.set(row.depth, list);
  }
  const steps = [...byDepth.keys()]
    .sort((a, b) => a - b)
    .map((d) => ({ depth: d, left: [...new Set(byDepth.get(d))] }));
  results.C12 = { steps, sample: metrics.slice(0, 6) };
  check("C12", "同一层级的文字起点一致", steps.every((s) => s.left.length === 1), true);
  check("C12", "层级之间有缩进差", steps.length, (v) => v >= 2);
}

console.log("13) 对话框：Esc 必须让调用方的 Promise 结束（不能卡住）");
await evaluate(`document.getElementById("settings-btn").click(); true`);
await sleep(700);
const opened = await evaluate(`!!document.querySelector(".overlay")`);
await evaluate(press("Escape"));
await sleep(400);
const closed = await evaluate(`!!document.querySelector(".overlay")`);
results.C13 = { opened, closed };
check("C13", "对话框已打开", opened, true);
check("C13", "Esc 后已关闭", closed, false);

console.log("14) 对话框按钮顺序：主操作在左（Fluent Windows 规范）");
await evaluate(`document.getElementById("settings-btn").click(); true`);
await sleep(700);
// 必须限定在 .dialog-foot 里找：对话框正文的工具行也用 .field-row，
// 不限定的话量到的是第一行工具路径（输入框 + 浏览 + 默认），断言就失去意义。
const order = await evaluate(`(() => {
  const f = document.querySelector(".dialog .dialog-foot .field-row");
  return f ? [...f.querySelectorAll("button")].map((b) => b.textContent.trim()) : null;
})()`);
results.C14 = order;
check("C14", "主操作（保存）排在取消左边", order, (v) => Array.isArray(v) && String(v[0]).includes("保存"));
await shot("10-dialog-button-order");
await evaluate(`document.querySelector(".overlay")?.remove(); true`);

console.log("15) Toast 跟随皮肤");
await evaluate(`(() => {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = "toast is-success is-in";
  el.textContent = "设置已保存";
  host.appendChild(el);
  return true;
})()`);
await sleep(400);
await shot("11-terminal-toast");
check("C15", "toast 也在终端皮肤下", await evaluate(PROBE), (v) => v.skin === "terminal");

console.log("17) 新建工程对话框：浏览按钮必须是「真的能浏览」的")
await goto("/preview.html?skin=swiss&theme=light");
await evaluate(`document.getElementById("new-project").click(); true`);
await sleep(600);
const fields = await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".dialog-body .field-row")];
  return {
    rows: rows.length,
    browseButtons: document.querySelectorAll(".dialog-body .field-row button").length,
    hasBrowse: rows.map((r) => !!r.querySelector("button")),
  };
})()`);
results.C17 = fields;
// 曾经的 bug：三个字段都画了「浏览」，但「工程名称」没绑 onclick —— 点了完全没反应。
check("C17", "三个字段", fields.rows, 3);
check("C17", "只有两个字段有浏览按钮（工程名称没有）", fields.browseButtons, 2);
check("C17", "字段顺序 = 无 / 有 / 有", JSON.stringify(fields.hasBrowse), "[false,true,true]");

console.log("18) 点浏览要真的填进输入框，并且报错不能静默")
await shot("14-new-project");
await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".dialog-body .field-row")];
  rows[1].querySelector("button").click();
  return true;
})()`);
await sleep(700);
const filled = await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".dialog-body .field-row")];
  const val = (i) => (rows[i].querySelector("input") || {}).value ?? null;
  const host = document.getElementById("toast-host");
  return {
    name: val(0),
    exe: val(1),
    toast: host ? [...host.querySelectorAll(".toast")].map((t) => t.textContent) : [],
  };
})()`);
results.C18 = filled;
check("C18", "主程序路径已填入", filled.exe, (v) => String(v).endsWith(".exe"));
check("C18", "工程名自动取文件名", filled.name, (v) => String(v).length > 0);
check("C18", "没有弹出错误提示", filled.toast.length, 0);
await shot("15-new-project-picked");
await evaluate(`document.querySelector(".overlay")?.remove(); true`);

console.log("19) .NET Framework 缺失告警横幅（两套设计各一张）");
await goto("/preview.html?skin=swiss&theme=light&dotnet=missing");
await shot("16-banner-dotnet-swiss");
await goto("/preview.html?skin=terminal&theme=dark&dotnet=missing");
await shot("17-banner-dotnet-terminal");
const banner = await evaluate(
  `({ visible: !!document.querySelector(".banner"), text: (document.querySelector(".banner p") || {}).textContent })`,
);
results.C19 = banner;
check("C19", "横幅可见", banner.visible, true);

// ================================================================ D. 递进式向导

console.log("\n=== D. 递进式分步向导 ===");

console.log("20) 结构：五步 + 面板全挂载但只显示一个 + 旧的三块操作区已消失");
await goto("/preview.html?skin=swiss&theme=light");
const d20 = await evaluate(`(() => ({
  steps: [...document.querySelectorAll(".step")].map((s) => s.querySelector(".step-title").textContent.trim()),
  active: (document.querySelector(".step.is-active") || {}).dataset?.step ?? null,
  panes: document.querySelectorAll(".pane").length,
  activePanes: [...document.querySelectorAll(".pane.is-active")].map((p) => p.dataset.pane),
  legacyStages: document.querySelectorAll(".stage").length,
  pos: (document.getElementById("wizard-pos") || {}).textContent,
  note: (document.getElementById("wizard-note") || {}).textContent,
}))()`);
results.D20 = d20;
check("D20", "五步", d20.steps.length, 5);
check("D20", "步骤顺序", JSON.stringify(d20.steps), '["主程序","合并","加密","打包","执行"]');
check("D20", "默认停在第 1 步", d20.active, "setup");
check("D20", "五个面板全挂载，只显示 1 个", [d20.panes, d20.activePanes.length], (v) => v[0] === 5 && v[1] === 1);
check("D20", "显示的是 setup 面板", JSON.stringify(d20.activePanes), '["setup"]');
check("D20", "旧的一屏三块已移除", d20.legacyStages, 0);
check("D20", "有步骤计数", d20.pos, (v) => String(v).includes("1 / 5"));
await shot("18-wizard-setup");

console.log("21) 点步骤条可跳步；底部翻页按钮同步；前面的步骤标为已完成");
await evaluate(`document.querySelector('.step[data-step="package"]').click(); true`);
await sleep(300);
const d21 = await evaluate(`(() => ({
  active: (document.querySelector(".step.is-active") || {}).dataset?.step ?? null,
  pane: (document.querySelector(".pane.is-active") || {}).dataset?.pane ?? null,
  done: document.querySelectorAll(".step.is-done").length,
  pos: (document.getElementById("wizard-pos") || {}).textContent,
  next: document.querySelector('[data-nav="next"]').textContent.trim(),
}))()`);
results.D21 = d21;
check("D21", "跳到打包步", [d21.active, d21.pane], (v) => v[0] === "package" && v[1] === "package");
check("D21", "前 3 步标记为已完成", d21.done, 3);
check("D21", "计数同步", d21.pos, (v) => String(v).includes("4 / 5"));
check("D21", "非末步按钮是「下一步」", d21.next, "下一步");

await evaluate(`document.querySelector('.step[data-step="run"]').click(); true`);
await sleep(300);
const d21b = await evaluate(`(() => ({
  next: document.querySelector('[data-nav="next"]').textContent.trim(),
  prevDisabled: document.querySelector('[data-nav="prev"]').disabled,
  rows: document.querySelectorAll(".plan-row").length,
  sums: [...document.querySelectorAll("[data-plan-sum]")].map((e) => e.textContent.trim()),
}))()`);
results.D21b = d21b;
check("D21b", "末步按钮变成「全部执行」", d21b.next, "全部执行");
check("D21b", "执行清单 3 行", d21b.rows, 3);
check("D21b", "每行都有摘要", d21b.sums.filter(Boolean).length, 3);
await shot("19-wizard-run");

console.log("22) 文件树：三个独立点击区（箭头只折叠 / 名称只聚焦 / 勾选框只勾选）");
await evaluate(`document.querySelector('.step[data-step="merge"]').click(); true`);
await sleep(400);

console.log("22a) 合并页：文件树默认收起 + 左右两栏 + 右侧已选文件列表");
const d22a = await evaluate(`(() => {
  const dirs = [...document.querySelectorAll(".tree li.dir")];
  const collapsed = dirs.filter((d) => d.classList.contains("is-collapsed")).length;
  const preview = document.querySelector("[data-merge-preview]");
  const title = preview ? preview.querySelector(".merge-preview-title") : null;
  const items = preview ? preview.querySelectorAll(".merge-sel-item").length : 0;
  // 真正量几何：右栏必须在左栏右侧（.merge-split 同时挂着 .pane-body，
  // 一旦漏掉 flex-direction: row 就会被带成上下堆叠，只查元素存在测不出来）
  const list = document.querySelector(".merge-list");
  const lr = list ? list.getBoundingClientRect() : null;
  const pr = preview ? preview.getBoundingClientRect() : null;
  return {
    totalDirs: dirs.length,
    collapsedDirs: collapsed,
    hasSplit: !!document.querySelector(".merge-split"),
    hasPreview: !!preview,
    titleText: title ? title.textContent.trim() : "",
    selCount: items,
    hasFilter: !!preview?.querySelector("[data-merge-sel-filter]"),
    noPickedStrip: !document.querySelector(".picker-picked:not([hidden])"),
    sideBySide: !!(lr && pr && pr.left >= lr.right - 2 && Math.abs(pr.top - lr.top) <= 24 && pr.width < lr.width),
    // 左右 6:4（gap 先扣再分，比值应落在 1.5 ± 0.05）
    ratio: lr && pr && pr.width > 0 ? Math.round((lr.width / pr.width) * 100) / 100 : null,
  };
})()`);
results.D22a = d22a;
check("D22a", "合并页是左右两栏布局", [d22a.hasSplit, d22a.sideBySide], (v) => v[0] === true && v[1] === true);
check("D22a", "左右按 6:4 分割", d22a.ratio, (v) => v >= 1.45 && v <= 1.55);
check("D22a", "文件树默认收起（顶层目录带 is-collapsed）", [d22a.totalDirs, d22a.collapsedDirs], (v) => v[0] > 0 && v[1] > 0);
check("D22a", "右侧是已选文件列表", [d22a.hasPreview, d22a.titleText], (v) => v[0] === true && String(v[1]).includes("已选"));
check("D22a", "已选文件列表随勾选渲染出条目", d22a.selCount, (v) => v > 0);
check("D22a", "右侧有筛选输入框", d22a.hasFilter, true);
check("D22a", "左侧不显示 picker-picked 条", d22a.noPickedStrip, true);

const d22 = await evaluate(`(() => {
  const selState = (el) => el.classList.contains("is-checked") ? "on" : el.classList.contains("is-partial") ? "partial" : "off";
  const dir = [...document.querySelectorAll(".tree li")].find((li) => li.classList.contains("dir"));
  // 挑一个不在可折叠目录里的文件行：隐藏元素无法获得焦点，
  // 先折叠再点名称会测出一个假的失败。
  const file = [...document.querySelectorAll(".tree li:not(.dir)")].find((li) => {
    const owner = li.parentElement.closest("li.dir");
    return !owner || !owner.classList.contains("is-collapsed");
  });
  if (!dir || !file) return { error: "树里没有目录行或文件行" };

  // ① 点名称：只聚焦，不动勾选
  const fileSelBefore = selState(file);
  file.querySelector(".tree-nm").click();
  const fileSelAfterName = selState(file);
  const focused = document.activeElement === file;

  // ② 点勾选框：改勾选
  file.querySelector(".tree-cb").click();
  const fileSelAfterBox = selState(file);

  // ③ 点箭头：只折叠，不动勾选
  const collapsedBefore = dir.classList.contains("is-collapsed");
  const selBefore = selState(dir);
  dir.querySelector(".tree-tw").click();
  const collapsedAfter = dir.classList.contains("is-collapsed");
  const selAfterArrow = selState(dir);

  return {
    arrowToggledCollapse: collapsedBefore !== collapsedAfter,
    arrowKeptSelection: selBefore === selAfterArrow,
    nameKeptSelection: fileSelBefore === fileSelAfterName,
    nameFocusedRow: focused,
    boxChangedSelection: fileSelBefore !== fileSelAfterBox,
  };
})()`);
results.D22 = d22;
check("D22", "有目录行与文件行", d22.error ?? "ok", "ok");
check("D22", "点箭头只折叠，不改勾选", [d22.arrowToggledCollapse, d22.arrowKeptSelection], (v) => v[0] === true && v[1] === true);
check("D22", "点名称不改勾选", d22.nameKeptSelection, true);
check("D22", "点名称把焦点移到该行", d22.nameFocusedRow, true);
check("D22", "点勾选框才改勾选", d22.boxChangedSelection, true);
await shot("20-tree-hit-areas");

console.log("23) 搜索收敛：搜到的行高亮、祖先自动展开；清空后恢复原状");
const d23 = await evaluate(`(() => {
  const input = document.querySelector(".picker-search-input");
  const fileRows = [...document.querySelectorAll(".tree li:not(.dir)")];
  input.value = "npoi";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return {
    total: fileRows.length,
    visible: document.querySelectorAll(".tree li:not(.dir):not(.is-hidden)").length,
    hit: document.querySelectorAll(".tree li.is-hit").length,
  };
})()`);
results.D23 = d23;
check("D23", "搜索把结果收敛到少数几行", d23.visible, (v) => v > 0 && v < d23.total);
check("D23", "命中的行被标记", d23.hit, (v) => v >= 1);

// 底栏统计曾经只数顶层文件，子目录里的会被漏掉 —— 拿 DOM 里的真实行数对一遍
const d23b = await evaluate(`(() => {
  const foot = document.querySelector(".picker-foot-text").textContent;
  const m = foot.match(/共\\s*(\\d+)\\s*个文件/);
  return {
    foot: foot.trim(),
    reported: m ? Number(m[1]) : -1,
    domFiles: document.querySelectorAll(".tree li:not(.dir)").length,
  };
})()`);
results.D23b = d23b;
check("D23b", "底栏文件总数包含子目录", d23b.reported, d23b.domFiles);

// 底栏的「当前显示 N 个」曾经在折叠之后不刷新 —— 因为折叠走的是视图回调，
// 而底栏只挂在勾选回调上。这条用例专门盯这个：折叠要刷新数字，且不能动勾选。
const d23c = await evaluate(`(() => {
  const input = document.querySelector(".picker-search-input");
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));

  // 从 DOM 真数一遍「肉眼可见的文件行」：既没被筛掉，也不在折叠目录里。
  // 不依赖底栏自己有没有输出那一段 —— 否则 before 可能拿到 null，断言就成了假的。
  const domVisible = () =>
    [...document.querySelectorAll(".tree li:not(.dir)")].filter(
      (li) => !li.classList.contains("is-hidden") && !li.parentElement.closest("li.dir.is-collapsed"),
    ).length;

  const read = () => {
    const text = document.querySelector(".picker-foot-text").textContent;
    const m = text.match(/当前显示\\s*(\\d+)\\s*个/);
    // 底栏不再显示「已选 N 项」（右栏才是已选清单），勾选数改从右栏计数读
    const cnt = document.querySelector("[data-merge-sel-count]")?.textContent ?? "";
    const sel = cnt.match(/(\\d+)\\s*项/);
    return { visible: m ? Number(m[1]) : null, selected: sel ? Number(sel[1]) : -1 };
  };

  // 挑一个含文件的目录。这里不能假设它当前是展开的 —— 前面的用例可能已经把它折起来了
  // （mock 树里只有 libs 一个目录），所以先归一到「展开」，再折叠，用例才与初始状态无关。
  const dir = [...document.querySelectorAll(".tree li.dir")].find((li) => li.querySelector("li:not(.dir)"));
  if (!dir) return { error: "树里没有含文件的目录" };
  if (dir.classList.contains("is-collapsed")) dir.querySelector(".tree-tw").click();
  const expanded = { ...read(), dom: domVisible() };

  dir.querySelector(".tree-tw").click();
  const after = { ...read(), dom: domVisible() };

  return { expanded, after, collapsed: dir.classList.contains("is-collapsed") };
})()`);
results.D23c = d23c;
check("D23c", "找到含文件的目录", d23c.error ?? "ok", "ok");
check("D23c", "箭头确实把目录折起来了", d23c.collapsed, true);
check("D23c", "折叠后可见文件数变少", [d23c.expanded.dom, d23c.after.dom], (v) => v[1] < v[0]);
check("D23c", "折叠后底栏出现「当前显示」", d23c.after.visible, (v) => typeof v === "number");
check("D23c", "底栏数字与 DOM 真值一致", d23c.after.visible, d23c.after.dom);
check("D23c", "折叠不改勾选（视图与勾选互不干扰）", d23c.after.selected, d23c.expanded.selected);
await shot("21-tree-foot-refresh");

console.log("24) 打包排除项：自动项 + 点按钮添加 + 点 chip 移除，全程不需要改代码");
// 重新加载一次：D22 在树里点过勾选框，会改掉 mergeDlls，
// 而自动排除项正是由 mergeDlls 推导的 —— 不重置的话这条断言量的是上一个用例的副作用。
await goto("/preview.html?skin=swiss&theme=light");
await evaluate(`document.querySelector('.step[data-step="package"]').click(); true`);
await sleep(400);
const d24before = await evaluate(`(() => ({
  auto: document.querySelectorAll('[data-exclude="auto"] .exclude-chip').length,
  autoClickable: document.querySelectorAll('[data-exclude="auto"] [data-remove]').length,
  custom: document.querySelectorAll('[data-exclude="custom"] .exclude-chip').length,
  preview: document.querySelector("[data-ignore-preview]").textContent.trim(),
  // Excludes 摘要默认不展开 —— 内容一多直接铺开会把整页淹掉
  collapsed: !document.querySelector("[data-ignore-details]").open,
  hint: document.querySelector(".ignore-preview-hint").textContent.trim(),
}))()`);

// 添加按钮的位置：「自定义」标签下方、已选排除文件上方
const d24order = await evaluate(`(() => {
  const label = [...document.querySelectorAll(".exclude-label")].find((el) => el.textContent.includes("自定义"));
  const btn = document.querySelector('[data-act="add-file"]');
  const list = document.querySelector('[data-exclude="custom"] .exclude-list');
  if (!label || !btn || !list) return { ok: false };
  const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  return { ok: true, labelBeforeBtn: follows(label, btn), btnBeforeList: follows(btn, list) };
})()`);

await evaluate(`document.querySelector('[data-act="add-file"]').click(); true`);
await sleep(700);
const d24afterFile = await evaluate(`(() => ({
  custom: document.querySelectorAll('[data-exclude="custom"] .exclude-chip').length,
  count: document.querySelector("[data-ignore-count]").textContent.trim(),
}))()`);

// 「添加通配符」走的是自绘输入对话框 —— 这是唯一需要手打的入口
await evaluate(`document.querySelector('[data-act="add-glob"]').click(); true`);
await sleep(400);
const globDialog = await evaluate(`!!document.querySelector(".overlay .dialog-body input")`);
await evaluate(`(() => {
  const input = document.querySelector(".overlay .dialog-body input");
  input.value = "*.log";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector(".overlay .btn-primary").click();
  return true;
})()`);
await sleep(600);
const d24afterGlob = await evaluate(`(() => ({
  custom: document.querySelectorAll('[data-exclude="custom"] .exclude-chip').length,
  hasGlob: [...document.querySelectorAll('[data-exclude="custom"] .exclude-chip')].some((c) => c.textContent.includes("*.log")),
  preview: document.querySelector("[data-ignore-preview]").textContent.trim(),
}))()`);

// 排除项改成紧凑的换行网格后，每个 chip 不应被强制铺满整行（避免页面被过度拉长）
const d24layout = await evaluate(`(() => {
  const list = document.querySelector('[data-exclude="custom"] .exclude-list');
  const chips = [...document.querySelectorAll('[data-exclude="custom"] .exclude-chip')];
  if (!list || chips.length === 0) return { ok: false };
  const listW = list.getBoundingClientRect().width;
  const widths = chips.map((c) => Math.round(c.getBoundingClientRect().width));
  return { ok: true, listW, widths, hasCompact: widths.some((w) => w < listW - 8) };
})()`);
check("D24", "自定义排除项采用紧凑换行布局（不强制整行）", d24layout.ok && d24layout.hasCompact, true);
check("D24", "添加按钮在「自定义」下方、已选排除文件上方", d24order, (v) => v.ok && v.labelBeforeBtn && v.btnBeforeList);
check("D24", "Excludes 摘要默认收起（不直接展示内容）", d24before.collapsed, true);
check("D24", "Excludes 摘要行给出项数", d24before.hint, (v) => /^共 \d+ 项 · 展开查看$/.test(String(v)));

// Excludes 预览区改为 details/summary，默认可折叠
const d24excludes = await evaluate(`(() => {
  const details = document.querySelector("[data-ignore-details]");
  return {
    isDetails: !!details,
    hasSummary: !!details?.querySelector("summary"),
    hasBody: !!details?.querySelector(".ignore-preview-body"),
    previewText: document.querySelector("[data-ignore-preview]")?.textContent?.trim() ?? "",
  };
})()`);
check("D24", "Excludes 预览区为可折叠结构", d24excludes.isDetails, true);
check("D24", "Excludes 预览区有 summary 与 body", [d24excludes.hasSummary, d24excludes.hasBody], (v) => v[0] && v[1]);
check("D24", "Excludes 预览区已生成内容", d24excludes.previewText, (v) => String(v).length > 0 && String(v) !== "—");

// 移除一个自定义项
await evaluate(`document.querySelector('[data-exclude="custom"] [data-remove]').click(); true`);
await sleep(600);
const d24afterRemove = await evaluate(`document.querySelectorAll('[data-exclude="custom"] .exclude-chip').length`);

// 合并而非覆盖：836–853 的断言已经把标签写进 results.D24，直接赋值会把它们抹掉
results.D24 = { ...(results.D24 ?? {}), before: d24before, afterFile: d24afterFile, afterGlob: d24afterGlob, afterRemove: d24afterRemove };
// 3 个合并 dll + 1 个主程序备份（<stem>.bakup）= 4
check("D24", "自动排除项来自合并项 + 备份", d24before.auto, 4);
check("D24", "自动项不可删除（只有自定义项带移除按钮）", d24before.autoClickable, 0);
// mock 的多选返回 3 个文件，其中 SampleTool.pdb 已经在列表里 → 只应新增 2 个（去重生效）
check("D24", "多选文件对话框存在（不是要用户手输路径）", d24afterFile.custom - d24before.custom, 2);
check("D24", "重复条目被去重", d24afterFile.custom, d24before.custom + 2);
check("D24", "通配符走自绘输入框", globDialog, true);
check("D24", "通配符已加入", d24afterGlob.hasGlob, true);
check("D24", "点 chip 可以移除", d24afterGlob.custom - d24afterRemove, 1);
check("D24", "最终 Excludes 字符串已生成", d24afterGlob.preview, (v) => String(v).includes(",") && String(v).includes("*.log"));
await shot("21-package-excludes");

console.log("25) 加密开关直接驱动模板：点一下开关，配置里就多一条 protection");
await evaluate(`document.querySelector('.step[data-step="encrypt"]').click(); true`);
await sleep(300);
const d25 = await evaluate(`(() => {
  const adv = document.querySelector('[data-adv="encrypt"]');
  const before = document.querySelector('[data-code="encrypt"]').value;
  const cb = document.querySelector('[data-opt="rename"]');
  const wasChecked = cb.checked;
  cb.checked = !wasChecked;
  cb.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    advancedCollapsed: !adv.open,
    hadRename: before.includes('id="rename"'),
    toggleTo: cb.checked,
    before,
  };
})()`);
await sleep(500);
const d25after = await evaluate(`(() => ({
  after: document.querySelector('[data-code="encrypt"]').value,
  hint: !!document.querySelector('[data-generated-hint="encrypt"] .inline-note'),
}))()`);
results.D25 = { advancedCollapsed: d25.advancedCollapsed, hadRename: d25.hadRename, toggleTo: d25.toggleTo, afterHasRename: d25after.after.includes('id="rename"'), hint: d25after.hint };
check("D25", "模板编辑器默认收起（用户不必看代码）", d25.advancedCollapsed, true);
check("D25", "默认不含 rename 规则", d25.hadRename, false);
check("D25", "打开开关后配置里出现 rename", d25after.after.includes('id="rename"'), true);
check("D25", "由开关托管时不显示「已手工修改」提示", d25after.hint, false);
await shot("22-encrypt-options");

console.log("26) 手工改模板后，开关不再覆盖它，并给出「交回开关管理」的出口");
const d26 = await evaluate(`(() => {
  const adv = document.querySelector('[data-adv="encrypt"]');
  adv.open = true;
  const ta = document.querySelector('[data-code="encrypt"]');
  ta.value = ta.value + "<!-- 手工标记 -->\\n";
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(300);
const d26after = await evaluate(`(() => {
  const cb = document.querySelector('[data-opt="constants"]');
  cb.checked = true;
  cb.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    hint: !!document.querySelector('[data-generated-hint="encrypt"] .inline-note'),
    stillHasMarker: document.querySelector('[data-code="encrypt"]').value.includes("手工标记"),
    hasResync: !!document.querySelector('[data-act="resync-encrypt"]'),
  };
})()`);
results.D26 = d26after;
check("D26", "手工改过之后出现提示条", d26after.hint, true);
check("D26", "开关不再覆盖手写内容", d26after.stillHasMarker, true);
check("D26", "提供「用当前选项覆盖模板」按钮", d26after.hasResync, true);

// 点它 → 回到由开关托管
await evaluate(`document.querySelector('[data-act="resync-encrypt"]').click(); true`);
await sleep(600);
const d26resync = await evaluate(`(() => ({
  hint: !!document.querySelector('[data-generated-hint="encrypt"] .inline-note'),
  hasConstants: document.querySelector('[data-code="encrypt"]').value.includes('id="constants"'),
  lostMarker: !document.querySelector('[data-code="encrypt"]').value.includes("手工标记"),
}))()`);
results.D26b = d26resync;
check("D26b", "重建后提示条消失", d26resync.hint, false);
check("D26b", "重建后的模板反映了刚才的开关", d26resync.hasConstants, true);
check("D26b", "手写内容被模板覆盖（符合预期）", d26resync.lostMarker, true);

console.log("27) 打包选项开关同样驱动脚本");
const d27 = await evaluate(`(() => {
  document.querySelector('.step[data-step="package"]').click();
  const before = document.querySelector('[data-code="package"]').value;
  const select = document.querySelector('[data-opt="compression"]');
  select.value = "none";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { beforeHadLzma: before.includes("Compression=lzma"), beforeHadSolid: before.includes("SolidCompression=yes") };
})()`);
await sleep(500);
const d27after = await evaluate(`(() => {
  const v = document.querySelector('[data-code="package"]').value;
  return { hasNone: v.includes("Compression=none"), solidDropped: !v.includes("SolidCompression=yes") };
})()`);
results.D27 = { ...d27, ...d27after };
check("D27", "默认脚本用 lzma2/max 且开固实压缩", [d27.beforeHadLzma, d27.beforeHadSolid], (v) => v[0] === true && v[1] === true);
check("D27", "切到「不压缩」后脚本同步", d27after.hasNone, true);
check("D27", "不压缩时自动去掉固实压缩", d27after.solidDropped, true);
await shot("23-package-options");

console.log("28) 全部执行：一次点击跑完三步，徽标变绿、产出文件可点开");
await goto("/preview.html?skin=swiss&theme=light");
await evaluate(`document.querySelector('.step[data-step="run"]').click(); true`);
await sleep(300);
const d28before = await evaluate(`(() => ({
  badges: [...document.querySelectorAll("[data-badge]")].map((b) => b.textContent.trim()),
  artifacts: document.querySelectorAll(".artifact").length,
}))()`);
await evaluate(`document.querySelector('[data-act="run-all"]').click(); true`);
await sleep(1800);
const d28after = await evaluate(`(() => ({
  badges: [...document.querySelectorAll("[data-badge]")].map((b) => b.textContent.trim()),
  artifacts: document.querySelectorAll(".artifact").length,
  stepSub: (document.querySelector('.step[data-step="run"] [data-sub]') || {}).textContent,
  toasts: [...document.querySelectorAll("#toast-host .toast")].map((t) => t.textContent.trim()),
}))()`);
results.D28 = { before: d28before, after: d28after };
check("D28", "执行前都是「待执行」", d28before.badges, (v) => v.every((b) => b === "待执行"));
check("D28", "执行后三步都完成", d28after.badges, (v) => v.every((b) => b === "已完成"));
check("D28", "产出文件出现在清单里", d28after.artifacts, (v) => v >= 3);
check("D28", "步骤条同步为已完成", d28after.stepSub, (v) => String(v).includes("3 / 3"));
await shot("24-run-all-done");

console.log("29) 终端皮肤下向导与树同样成立（两套设计共用结构）");
await goto("/preview.html?skin=terminal&theme=dark");
await evaluate(`document.querySelector('.step[data-step="merge"]').click(); true`);
await sleep(500);
const d29 = await evaluate(`(() => ({
  skin: document.documentElement.dataset.skin,
  steps: document.querySelectorAll(".step").length,
  activePanes: document.querySelectorAll(".pane.is-active").length,
  checkboxGlyphs: [...document.querySelectorAll(".tree-cb")].slice(0, 3).map((el) =>
    getComputedStyle(el, "::before").content
  ),
  branchGlyphs: [...document.querySelectorAll(".tree-tw")].slice(0, 2).map((el) =>
    getComputedStyle(el, "::before").content
  ),
}))()`);
results.D29 = d29;
check("D29", "终端皮肤", d29.skin, "terminal");
check("D29", "向导结构一致", [d29.steps, d29.activePanes], (v) => v[0] === 5 && v[1] === 1);
check("D29", "复选框仍是 [x] 风格", d29.checkboxGlyphs, (v) => v.every((g) => String(g).includes("[") || String(g) === "none"));
check("D29", "分支符仍是 box-drawing", d29.branchGlyphs, (v) => v.some((g) => String(g).includes("├") || String(g).includes("└")));
await shot("25-terminal-wizard-tree");

console.log("29b) 终端亮色：已选排除文件 hover 文字与底色不撞色");
// 亮色下 --accent 是深青、--accent-text 是更深的青 —— 曾经 hover 用后者压前者，
// 深青撞深青读不出来。这里真的把鼠标放上去读实色，而不是只翻 CSS。
await goto("/preview.html?skin=terminal&theme=light");
await evaluate(`document.querySelector('.step[data-step="package"]').click(); true`);
await sleep(400);
const d29b = await evaluate(`(() => {
  const chip = document.querySelector('[data-exclude="custom"] .exclude-chip');
  if (!chip) return null;
  chip.scrollIntoView({ block: "center" });
  const r = chip.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
if (d29b) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: d29b.x, y: d29b.y });
  await sleep(150);
  const d29bhover = await evaluate(`(() => {
    const cs = getComputedStyle(document.querySelector('[data-exclude="custom"] .exclude-chip'));
    return { color: cs.color, bg: cs.backgroundColor };
  })()`);
  results.D29b = d29bhover;
  check("D29b", "hover 生效：底色变为实色 accent 深青", d29bhover.bg, "rgb(11, 114, 133)");
  check("D29b", "hover 文字为白色，不与底色撞色", d29bhover.color, (v) => v === "rgb(255, 255, 255)");
} else {
  check("D29b", "终端亮色下有已选排除文件可测", false, true);
}

// ---------------------------------------------------------------- 扩展选项
//
// 第 30 组起针对「更多可配置选项」：分组渲染、默认值标注、适用场景说明、
// 参数项条件显示、一键预设、以及参数是否真的落进了模板。

/** 勾/取消一个开关（探针里的通用小工具，注意返回的是表达式字符串） */
const setCheck = (key, checked) =>
  `(() => { const el = document.querySelector('[data-opt="${key}"]'); el.checked = ${checked}; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;

/** 给下拉/数字/文本框赋值并派发 change */
const setValue = (key, value) =>
  `(() => { const el = document.querySelector('[data-opt="${key}"]'); el.value = ${JSON.stringify(
    String(value),
  )}; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;

console.log("30) 加密选项按算法族分组，且每项都有默认值与适用场景说明");
await goto("/preview.html?skin=swiss&theme=light");
await evaluate(`document.querySelector('.step[data-step="encrypt"]').click(); true`);
await sleep(400);
const d30 = await evaluate(`(() => {
  const host = document.querySelector('[data-opt-groups="encrypt"]');
  const groups = [...host.querySelectorAll(".opt-group")];
  const rows = [...host.querySelectorAll("[data-opt-row]")];
  const text = (el) => (el ? el.textContent.trim() : "");
  return {
    groupIds: groups.map((g) => g.dataset.group),
    groupTitles: groups.map((g) => text(g.querySelector(".opt-group-title"))),
    rowCount: rows.length,
    rowsWithDefault: rows.filter((r) => r.querySelector(".opt-default")).length,
    rowsWithHint: rows.filter((r) => text(r.querySelector(".opt-hint")).length > 0).length,
    selects: host.querySelectorAll("select[data-opt]").length,
    numbers: host.querySelectorAll('input[type="number"][data-opt]').length,
    // 文本类控件：口令字段现在显式用 type="password" 渲染（肩窥防护），
    // 所以这里要同时数 text 与 password 两种
    texts: host.querySelectorAll(
      'input[type="text"][data-opt], input[type="password"][data-opt]',
    ).length,
    bools: host.querySelectorAll('input[type="checkbox"][data-opt]').length,
    // 预设按钮
    presets: [...host.parentElement.querySelectorAll("[data-preset]")].map((b) => b.textContent.trim()),
    // 分组计数
    groupCounts: [...host.querySelectorAll("[data-group-count]")].map((el) => el.textContent.trim()),
  };
})()`);
results.D30 = d30;
check("D30", "加密选项分成 5 组", d30.groupIds.length, 5);
check(
  "D30",
  "分组覆盖对称 / 非对称 / 哈希三族",
  d30.groupIds.join(","),
  (v) => v.includes("anti") && v.includes("data") && v.includes("sign"),
);
check("D30", "每组都有标题", d30.groupTitles.filter(Boolean).length, 5);
check("D30", "选项总数不少于 30 项", d30.rowCount, (v) => v >= 30);
check("D30", "每个选项都标注了默认值", d30.rowsWithDefault, d30.rowCount);
check("D30", "每个选项都写了适用场景", d30.rowsWithHint, d30.rowCount);
check(
  "D30",
  "开关 / 下拉 / 数字 / 文本四类控件都有",
  [d30.bools, d30.selects, d30.numbers, d30.texts],
  (v) => v[0] >= 8 && v[1] >= 8 && v[2] >= 2 && v[3] >= 2,
);
check("D30", "提供 4 档一键预设", d30.presets.length, 4);
check("D30", "分组计数已渲染", d30.groupCounts, (v) => v.length >= 3 && v.every((s) => s.includes("已启用")));
await shot("26-encrypt-groups");

console.log("31) 参数项只在对应功能开启后出现（条件显示）");
const d31 = await evaluate(`(() => {
  const host = document.querySelector('[data-opt-groups="encrypt"]');
  const visible = () => [...host.querySelectorAll("[data-opt-row]")]
    .filter((r) => !r.hidden).map((r) => r.dataset.optRow);
  const before = visible();

  const cb = host.querySelector('[data-opt="rename"]');
  cb.checked = true;
  cb.dispatchEvent(new Event("change", { bubbles: true }));
  const afterRename = visible();

  const mode = host.querySelector('[data-opt="renameMode"]');
  mode.value = "reversible";
  mode.dispatchEvent(new Event("change", { bubbles: true }));
  const afterReversible = visible();

  return { before, afterRename, afterReversible };
})()`);
results.D31 = d31;
check(
  "D31",
  "未开启时参数行是隐藏的",
  [d31.before.includes("renameMode"), d31.before.includes("renamePassword")],
  (v) => v[0] === false && v[1] === false,
);
check("D31", "开启重命名后出现「重命名方式」", d31.afterRename.includes("renameMode"), true);
check(
  "D31",
  "只有选了 reversible 才问口令",
  [d31.afterRename.includes("renamePassword"), d31.afterReversible.includes("renamePassword")],
  (v) => v[0] === false && v[1] === true,
);
await shot("27-option-conditional");

console.log("32) 一键预设：整组开关联动，且不锁死后续微调");
await evaluate(`document.querySelector('[data-preset="none"]').click(); true`);
await sleep(400);
const d32none = await evaluate(`(() => {
  const host = document.querySelector('[data-opt-groups="encrypt"]');
  const on = (k) => host.querySelector('[data-opt="' + k + '"]').checked;
  return {
    rename: on("rename"), constants: on("constants"), antiTamper: on("antiTamper"),
    compress: on("compress"),
  };
})()`);
await evaluate(`document.querySelector('[data-preset="standard"]').click(); true`);
await sleep(500);
const d32standard = await evaluate(`(() => {
  const host = document.querySelector('[data-opt-groups="encrypt"]');
  const on = (k) => host.querySelector('[data-opt="' + k + '"]').checked;
  return {
    rename: on("rename"), constants: on("constants"), controlFlow: on("controlFlow"),
    antiDebug: on("antiDebug"), antiTamper: on("antiTamper"),
    renameMode: host.querySelector('[data-opt="renameMode"]').value,
    hint: (document.querySelector("[data-preset-hint]") || {}).textContent,
  };
})()`);
await evaluate(`document.querySelector('[data-preset="strict"]').click(); true`);
await sleep(500);
const d32strict = await evaluate(`(() => {
  const host = document.querySelector('[data-opt-groups="encrypt"]');
  const on = (k) => host.querySelector('[data-opt="' + k + '"]').checked;
  return { antiTamper: on("antiTamper"), antiDump: on("antiDump"), harden: on("harden") };
})()`);
results.D32 = { none: d32none, standard: d32standard, strict: d32strict };
check("D32", "「不加密」把所有保护关掉（但保留压缩）", [d32none.rename, d32none.constants, d32none.compress], (v) => v[0] === false && v[1] === false && v[2] === true);
check(
  "D32",
  "「标准」开启重命名/常量/控制流/反调试，但不开反篡改",
  [d32standard.rename, d32standard.constants, d32standard.controlFlow, d32standard.antiDebug, d32standard.antiTamper],
  (v) => v[0] && v[1] && v[2] && v[3] && v[4] === false,
);
check("D32", "预设会同步参数（重命名方式跟着变）", d32standard.renameMode, "unicode");
check("D32", "预设给出了适用场景说明", d32standard.hint, (v) => String(v).includes("标准"));
check("D32", "「严格」进一步打开反篡改与防转储", [d32strict.antiTamper, d32strict.antiDump, d32strict.harden], (v) => v.every(Boolean));

console.log("33) 参数真的写进了 ConfuserEx 模板（含 snKey 的位置）");
const d33 = await evaluate(`(() => {
  const v = document.querySelector('[data-code="encrypt"]').value;
  return {
    preset: v.includes('preset="aggressive"'),
    tamperArgs: v.includes('<protection id="anti tamper">') && v.includes('<argument name="key" value="dynamic" />'),
    elements: v.includes('<argument name="elements" value="SNI" />'),
    cfg: v.includes('<argument name="cfg" value="true" />'),
    depth: v.includes('<argument name="depth" value="6" />'),
    refProxyStrong: v.includes('<argument name="mode" value="strong" />'),
    harden: v.includes('<protection id="harden" />'),
    packer: v.includes('<packer id="compressor" />'),
  };
})()`);
results.D33 = d33;
check("D33", "预设档写进了 <rule preset>", d33.preset, true);
check("D33", "反篡改的两个参数都写出来了", d33.tamperArgs, true);
check("D33", "常量加密写出了 elements=SNI", d33.elements, true);
check("D33", "常量加密写出了 cfg=true", d33.cfg, true);
check("D33", "控制流写出了 depth=6", d33.depth, true);
check("D33", "引用代理写出了 mode=strong", d33.refProxyStrong, true);
check("D33", "无参数的 protection 是自闭合标签", d33.harden, true);
check("D33", "压缩器仍然保留", d33.packer, true);

// 强名称密钥：必须落在 <module> 上，写到 <project> 上 ConfuserEx 会静默忽略
await evaluate(setValue("snKeyPath", "D:\\\\keys\\\\app.snk"));
await sleep(500);
const d33b = await evaluate(`(() => {
  const lines = document.querySelector('[data-code="encrypt"]').value.split("\\n");
  return {
    moduleLine: lines.find((l) => l.includes("<module")) || "",
    projectLine: lines[0] || "",
  };
})()`);
results.D33b = d33b;
check("D33b", "snKey 写在 <module> 上", d33b.moduleLine, (v) => String(v).includes('snKey="D:\\\\keys\\\\app.snk"'));
check("D33b", "snKey 没有写到 <project> 上", d33b.projectLine.includes("snKey"), false);
await shot("28-encrypt-template");

console.log("34) 打包：压缩格式与等级、LZMA 参数、分卷、加密与签名全部可配");
await evaluate(`document.querySelector('.step[data-step="package"]').click(); true`);
await sleep(300);
await evaluate(`document.querySelector('[data-act="reset-package-options"]').click(); true`);
await sleep(500);
const d34default = await evaluate(`(() => {
  const v = document.querySelector('[data-code="package"]').value;
  return {
    compression: v.includes("Compression=lzma2/max"),
    solid: v.includes("SolidCompression=yes"),
    kdf: v.includes("EncryptionKeyDerivation=pbkdf2/220000"),
    noSpanning: !v.includes("DiskSpanning"),
    noSignTool: !v.includes("SignTool"),
    noDict: !v.includes("LZMADictionarySize"),
  };
})()`);
results.D34 = { ...d34default };
check("D34", "默认用 Inno 自己的默认压缩档 lzma2/max", d34default.compression, true);
check("D34", "默认开固实压缩", d34default.solid, true);
check("D34", "默认带 PBKDF2 密钥派生（哈希）", d34default.kdf, true);
check("D34", "默认单文件模式，不写分卷指令", d34default.noSpanning, true);
check("D34", "默认不签名", d34default.noSignTool, true);
check("D34", "字典/线程留 0 时交给 Inno 决定（不写出来）", d34default.noDict, true);

// 换成 fast 档 + 显式 LZMA 参数
await evaluate(setValue("compression", "lzma2/fast"));
await sleep(350);
await evaluate(setValue("lzmaDictionarySize", 32768));
await sleep(350);
await evaluate(setValue("lzmaNumBlockThreads", 4));
await sleep(350);
await evaluate(setValue("lzmaMatchFinder", "hc"));
await sleep(350);
await evaluate(setCheck("lzmaUseSeparateProcess", true));
await sleep(450);
const d34lzma = await evaluate(`(() => {
  const v = document.querySelector('[data-code="package"]').value;
  return {
    fast: v.includes("Compression=lzma2/fast"),
    dict: v.includes("LZMADictionarySize=32768"),
    threads: v.includes("LZMANumBlockThreads=4"),
    matchFinder: v.includes("LZMAMatchFinder=HC"),
    separate: v.includes("LZMAUseSeparateProcess=yes"),
  };
})()`);
results.D34b = d34lzma;
check("D34b", "切档位后 Compression 同步", d34lzma.fast, true);
check("D34b", "字典大小写进脚本", d34lzma.dict, true);
check("D34b", "并行线程写进脚本", d34lzma.threads, true);
check("D34b", "匹配器大小写被规范成 HC", d34lzma.matchFinder, true);
check("D34b", "独立进程写进脚本", d34lzma.separate, true);

// 分卷
await evaluate(setValue("packagingMode", "multi_volume"));
await sleep(400);
await evaluate(setValue("diskSliceSize", 1566000000));
await sleep(350);
await evaluate(setValue("slicesPerDisk", 3));
await sleep(450);
const d34vol = await evaluate(`(() => {
  const v = document.querySelector('[data-code="package"]').value;
  return {
    spanning: v.includes("DiskSpanning=yes"),
    slice: v.includes("DiskSliceSize=1566000000"),
    perDisk: v.includes("SlicesPerDisk=3"),
  };
})()`);
results.D34c = d34vol;
check("D34c", "分卷模式打开 DiskSpanning", d34vol.spanning, true);
check("D34c", "单片大小写进脚本", d34vol.slice, true);
check("D34c", "每盘片数写进脚本", d34vol.perDisk, true);

// 整包加密 + 签名
await evaluate(setValue("encryption", "full"));
await sleep(400);
await evaluate(setValue("kdfIterations", 600000));
await sleep(400);
await evaluate(setValue("signTool", "signtool"));
await sleep(400);
await evaluate(setCheck("signedUninstaller", true));
await sleep(450);
const d34crypto = await evaluate(`(() => {
  const v = document.querySelector('[data-code="package"]').value;
  return {
    full: v.includes("Encryption=full"),
    password: v.includes("Password=\${password}"),
    kdf: v.includes("EncryptionKeyDerivation=pbkdf2/600000"),
    sign: v.includes("SignTool=signtool"),
    signedUninstaller: v.includes("SignedUninstaller=yes"),
  };
})()`);
results.D34d = d34crypto;
check("D34d", "整包加密写进脚本", d34crypto.full, true);
check("D34d", "full 模式仍然写 Password（密钥在编译期派生）", d34crypto.password, true);
check("D34d", "自定义迭代次数写进脚本", d34crypto.kdf, true);
check("D34d", "签名工具写进脚本", d34crypto.sign, true);
check("D34d", "卸载程序签名写进脚本", d34crypto.signedUninstaller, true);

// 绿色版
await evaluate(setValue("packagingMode", "portable"));
await sleep(500);
const d34portable = await evaluate(`(() => {
  const v = document.querySelector('[data-code="package"]').value;
  return {
    uninstallable: v.includes("Uninstallable=no"),
    noRegKey: v.includes("CreateUninstallRegKey=no"),
    noIcons: !v.includes("[Icons]"),
    noRun: !v.includes("[Run]"),
  };
})()`);
results.D34e = d34portable;
check("D34e", "绿色版不生成卸载程序", d34portable.uninstallable, true);
check("D34e", "绿色版不写注册表卸载项", d34portable.noRegKey, true);
check("D34e", "绿色版不建快捷方式", d34portable.noIcons, true);
check("D34e", "绿色版不自动运行", d34portable.noRun, true);
await shot("29-package-crypto");

console.log("35) 「恢复默认」把整组选项按 schema 声明的默认值重置");
await evaluate(`document.querySelector('[data-act="reset-package-options"]').click(); true`);
await sleep(600);
const d35 = await evaluate(`(() => {
  const host = document.querySelector('[data-opt-groups="package"]');
  const v = document.querySelector('[data-code="package"]').value;
  return {
    compression: host.querySelector('[data-opt="compression"]').value,
    mode: host.querySelector('[data-opt="packagingMode"]').value,
    signTool: host.querySelector('[data-opt="signTool"]').value,
    changedChips: host.querySelectorAll(".opt-default.is-changed").length,
    totalChips: host.querySelectorAll(".opt-default").length,
    backToDefault: v.includes("Compression=lzma2/max") && !v.includes("DiskSpanning"),
  };
})()`);
results.D35 = d35;
check("D35", "压缩格式回到默认", d35.compression, "lzma2/max");
check("D35", "打包模式回到默认", d35.mode, "single");
check("D35", "签名工具被清空", d35.signTool, "");
check("D35", "所有「默认值」标注都回到未改动状态", d35.changedChips, 0);
check("D35", "脚本也回到默认", d35.backToDefault, true);
check("D35", "每项都有默认值标注", d35.totalChips, (v) => v > 0);

console.log("36) 产出校验清单（哈希）：选了算法，打包产出里就多一份清单");
await evaluate(setValue("checksum", "sha256"));
await sleep(450);
const d36setup = await evaluate(`(() => {
  const v = document.querySelector('[data-code="package"]').value;
  return { checksum: document.querySelector('[data-opt="checksum"]').value, scriptUnchanged: v.includes("Compression=lzma2/max") };
})()`);
await evaluate(`document.querySelector('.step[data-step="run"]').click(); true`);
await sleep(300);
await evaluate(`document.querySelector('[data-act="run-all"]').click(); true`);
await sleep(1800);
const d36 = await evaluate(`(() => ({
  artifacts: [...document.querySelectorAll(".artifact")].map((a) => a.textContent.trim()),
}))()`);
results.D36 = { ...d36setup, ...d36 };
check("D36", "算法已选为 SHA-256", d36setup.checksum, "sha256");
check("D36", "校验清单不影响 .iss 本身", d36setup.scriptUnchanged, true);
check("D36", "产出清单里出现 checksums-sha256.txt", d36.artifacts.join(" "), (v) => String(v).includes("checksums-sha256.txt"));

console.log("37) 终端皮肤下新选项区同样成立");
await goto("/preview.html?skin=terminal&theme=dark");
await evaluate(`document.querySelector('.step[data-step="encrypt"]').click(); true`);
await sleep(500);
const d37 = await evaluate(`(() => {
  const host = document.querySelector('[data-opt-groups="encrypt"]');
  const title = host.querySelector(".opt-group-title");
  return {
    skin: document.documentElement.dataset.skin,
    groups: host.querySelectorAll(".opt-group").length,
    titleGlyph: getComputedStyle(title, "::before").content,
    monoSpan: getComputedStyle(host.querySelector(".opt-control .input")).fontFamily,
  };
})()`);
results.D37 = d37;
check("D37", "终端皮肤", d37.skin, "terminal");
check("D37", "分组结构一致", d37.groups, 5);
check("D37", "组标题带终端前缀", d37.titleGlyph, (v) => String(v).includes(">"));
await shot("30-terminal-options");

// ---------------------------------------------------------------- 工具下载

console.log("\n38) 设置面板：每个工具都给出下载来源、体积与按钮");
await goto("/preview.html?skin=swiss&theme=light");
await evaluate(`document.getElementById("settings-btn").click(); true`);
await sleep(800);
const d38 = await evaluate(`(() => {
  return [...document.querySelectorAll(".overlay .tool-row")].map((row) => {
    const name = row.querySelector(".tool-row-name").textContent.trim();
    const strip = row.querySelector(".dl");
    const go = row.querySelector("[data-dl]");
    const bar = row.querySelector(".dl-bar");
    const fill = row.querySelector(".dl-fill");
    return {
      name,
      hasStrip: !!strip,
      source: strip?.querySelector(".dl-src")?.textContent.trim() ?? "",
      note: strip?.querySelector(".dl-note")?.textContent.trim() ?? "",
      goLabel: go?.textContent.trim() ?? "",
      goDisabled: go ? go.disabled : null,
      blockedNote: strip?.querySelector(".dl-msg")?.textContent.trim() ?? "",
      barHidden: bar ? bar.hidden : null,
      fillWidth: fill ? fill.style.width : "",
    };
  });
})()`);
results.D38 = d38;
check("D38", "三行工具都渲染出下载条", d38.length, 3);
check("D38", "四个来源说明都非空", d38.every((r) => r.note.length > 10), true);
check(
  "D38",
  "说明里带上了版本与体积",
  d38.map((r) => r.source),
  (v) => v.every((s) => / · [\d.]+ (KB|MB) · /.test(s)),
);
check("D38", "未安装的工具显示「下载」", d38.find((r) => r.name === "Inno Setup").goLabel, "下载");
check("D38", "已安装的工具显示「重新下载」", d38.find((r) => r.name === "ILMerge").goLabel, "重新下载");
check("D38", "进度条初始隐藏", d38.every((r) => r.barHidden), true);
check("D38", "填充条初始为 0", d38.every((r) => r.fillWidth === "" || r.fillWidth === "0%"), true);
await shot("31-settings-download");

// 已自定义路径时下载不会改变生效路径，按钮必须禁用并说明原因
check(
  "D38b",
  "自定义路径的行禁用下载按钮",
  d38.find((r) => r.name === "ConfuserEx").goDisabled,
  true,
);
check(
  "D38b",
  "并解释为什么禁用",
  d38.find((r) => r.name === "ConfuserEx").blockedNote,
  (v) => String(v).includes("已自定义路径"),
);

// 装 Inno Setup 需要管理员授权，所以本机已有的一份要能一键顶上，
// 既免掉 10 MB 下载、也免掉 UAC
const d38c = await evaluate(`(() => {
  const row = [...document.querySelectorAll(".overlay .tool-row")].find((r) =>
    r.querySelector(".tool-row-name").textContent.includes("Inno Setup"),
  );
  const useBtn = [...row.querySelectorAll("button")].find((b) =>
    b.textContent.includes("使用本机"),
  );
  const before = row.querySelector(".input").value;
  useBtn.click();
  const after = row.querySelector(".input").value;
  return { hasBtn: !!useBtn, title: useBtn?.title ?? "", before, after };
})()`);
results.D38c = d38c;
check("D38c", "Inno Setup 行给出「使用本机」入口", d38c.hasBtn, true);
check("D38c", "按钮提示带上被指向的路径", d38c.title, (v) => String(v).includes("ISCC.exe"));
check("D38c", "点前路径框为空", d38c.before, "");
check("D38c", "点后填入本机路径", d38c.after, (v) => String(v).includes("ISCC.exe"));

console.log("\n39) 下载：进度事件推进填充条，完成后按钮变重新下载");
const d39before = await evaluate(`(() => {
  const row = [...document.querySelectorAll(".overlay .tool-row")].find((r) =>
    r.querySelector(".tool-row-name").textContent.includes("Inno Setup"),
  );
  const fill = row.querySelector(".dl-fill");
  row.querySelector("[data-dl]").click();
  return { fillBefore: fill.style.width };
})()`);
await sleep(320);
const d39mid = await evaluate(`(() => {
  const row = [...document.querySelectorAll(".overlay .tool-row")].find((r) =>
    r.querySelector(".tool-row-name").textContent.includes("Inno Setup"),
  );
  const bar = row.querySelector(".dl-bar");
  const fill = row.querySelector(".dl-fill");
  return {
    barVisible: !bar.hidden,
    width: fill.style.width,
    msg: row.querySelector(".dl-msg").textContent.trim(),
  };
})()`);
await sleep(1400);
const d39after = await evaluate(`(() => {
  const row = [...document.querySelectorAll(".overlay .tool-row")].find((r) =>
    r.querySelector(".tool-row-name").textContent.includes("Inno Setup"),
  );
  return {
    barHidden: row.querySelector(".dl-bar").hidden,
    width: row.querySelector(".dl-fill").style.width,
    goLabel: row.querySelector("[data-dl]").textContent.trim(),
    state: row.querySelector(".tool-state").textContent.trim(),
    path: row.querySelector(".input").value,
  };
})()`);
results.D39 = { ...d39before, ...d39mid, ...d39after };
check("D39", "下载开始后进度条可见", d39mid.barVisible, true);
check(
  "D39",
  "进度条按百分比推进",
  d39mid.width,
  (v) => /^\d+%$/.test(String(v)) && parseInt(v, 10) > 0,
);
check("D39", "进度行给出了过程说明", d39mid.msg, (v) => String(v).length > 0);
check("D39", "下载结束后进度条收隐藏", d39after.barHidden, true);
check("D39", "按钮变为「重新下载」", d39after.goLabel, "重新下载");
check("D39", "状态行显示已就绪", d39after.state, (v) => String(v).includes("已就绪"));
check(
  "D39",
  "下载完成后把路径填回输入框（无需手动指定）",
  d39after.path,
  (v) => String(v).includes("ISCC.exe") && String(v).includes("tools"),
);
await shot("32-settings-download-done");

console.log("\n40) 下载目录与内置目录分开告知");
const d40 = await evaluate(`(() => {
  const notes = [...document.querySelectorAll(".overlay .section-note")].map((n) => n.textContent.trim());
  return { downloadDirNote: notes.find((n) => n.includes("安装到")) ?? "", count: notes.length };
})()`);
results.D40 = d40;
check("D40", "提示里说明了下载落点", d40.downloadDirNote, (v) => String(v).includes("tools"));

console.log("\n41) 关掉弹窗后仍能更新工具链（下载改变了可用性）");
await evaluate(`document.querySelector(".dialog .dialog-foot .btn-quiet").click(); true`);
await sleep(900);
const d41 = await evaluate(`(() => ({
  overlay: !!document.querySelector(".overlay"),
  railText: document.getElementById("rail-foot")?.textContent ?? "",
  railTools: [...document.querySelectorAll("#toolchain [data-tool]")].map((b) => ({
    label: b.textContent.trim(),
    missing: b.classList.contains("is-missing"),
  })),
}))()`);
results.D41 = d41;
check("D41", "弹窗已关闭", d41.overlay, false);
check("D41", "三个工具都还在底栏", d41.railTools.length, 3);
check("D41", "下载过的 Inno Setup 不再是缺失态", d41.railTools.every((t) => !t.missing), true);

console.log("\n42) 终端皮肤下下载条同样长在终端样式里");
await goto("/preview.html?skin=terminal&theme=dark");
await evaluate(`document.getElementById("settings-btn").click(); true`);
await sleep(800);
const d42 = await evaluate(`(() => {
  const row = [...document.querySelectorAll(".overlay .tool-row")].find((r) =>
    r.querySelector(".tool-row-name").textContent.includes("Inno Setup"),
  );
  const src = row.querySelector(".dl-src");
  const bar = row.querySelector(".dl-bar");
  const msg = row.querySelector(".dl-msg");
  return {
    skin: document.documentElement.dataset.skin,
    srcFont: getComputedStyle(src).fontFamily,
    barRadius: getComputedStyle(bar).borderTopLeftRadius,
    msgFont: getComputedStyle(msg).fontFamily,
  };
})()`);
results.D42 = d42;
check("D42", "终端皮肤", d42.skin, "terminal");
check("D42", "来源说明用等宽字形", d42.srcFont, (v) => String(v).includes("mono"));
check("D42", "进度条是终端式方角", d42.barRadius, "0px");
check("D42", "进度文案用等宽字形", d42.msgFont, (v) => String(v).includes("mono"));
await shot("33-terminal-download");
await evaluate(`document.querySelector(".overlay")?.remove(); true`);

// ---------------------------------------------------------------- 本轮审查修复的回归
//
// 这几条盯的是「重构之后容易再坏掉」的接线与语义，都是本轮代码审查里
// 实际修掉的问题（按钮没接线、aria 关联缺失、schema 字段没人消费、口令明文显示）。

console.log("\n43) 步骤条：tab 语义完整、支持方向键、只有一个 Tab 停靠点");
await goto("/preview.html?skin=swiss&theme=light");
await sleep(500);
const d43tabs = await evaluate(`(() => {
  const tab = document.querySelector('.step[data-step="setup"]');
  tab.focus();
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  return {
    active: document.querySelector(".step.is-active")?.dataset.step ?? "",
    controls: document.querySelector('.step[data-step="merge"]')?.getAttribute("aria-controls") ?? "",
    paneExists: !!document.getElementById("pane-merge"),
    tabbables: [...document.querySelectorAll(".step")].filter((s) => s.tabIndex === 0).length,
  };
})()`);
results.D43tabs = d43tabs;
check("D43", "方向键能切换步骤", d43tabs.active, "merge");
check("D43", "tab 用 aria-controls 指向对应面板", d43tabs.controls, "pane-merge");
check("D43", "面板 id 与 aria-controls 对得上", d43tabs.paneExists, true);
check("D43", "步骤条只有一个 Tab 停靠点（roving tabindex）", d43tabs.tabbables, 1);

console.log("\n44) 合并页「重新扫描」按钮确实接了线（此前是死按钮）");
const d44before = await evaluate(`(() => {
  document.querySelector('[data-act="rescan"]')?.click();
  return !!document.querySelector('[data-act="rescan"]');
})()`);
await sleep(800);
const d44 = await evaluate(`(() => ({
  hasButton: ${d44before},
  toasts: [...document.querySelectorAll("#toast-host .toast")].map((t) => t.textContent.trim()),
  treeRows: document.querySelectorAll(".tree li").length,
}))()`);
results.D44 = d44;
check("D44", "合并页有「重新扫描」按钮", d44.hasButton, true);
check("D44", "点击后给出反馈（不再点了没反应）", d44.toasts.join(" "), (v) => String(v).includes("重新扫描"));
check("D44", "重扫后目录树仍在", d44.treeRows, (v) => v > 0);

console.log("\n45) 提示条可被读屏播报");
const d45 = await evaluate(`(() => {
  const host = document.getElementById("toast-host");
  return {
    role: host?.getAttribute("role") ?? "",
    live: host?.getAttribute("aria-live") ?? "",
  };
})()`);
results.D45 = d45;
check("D45", "toast 容器是 live region", [d45.role, d45.live], (v) => v[0] === "status" && v[1] === "polite");

console.log("\n46) schema 里的 writes 真的被消费了（此前填了 20 处、0 处读取）");
const d46 = await evaluate(`(() => {
  const rowTitle = (key) => {
    const row = document.querySelector('[data-opt-row="' + key + '"]');
    return row ? row.getAttribute("title") || "" : "(无此行)";
  };
  return {
    rename: rowTitle("rename"),
    antiIldasm: rowTitle("antiIldasm"),
    constants: rowTitle("constants"),
  };
})()`);
results.D46 = d46;
check("D46", "开关行标出会写进模板的内容", d46.rename, (v) => String(v).includes("将写入模板") && String(v).includes("rename"));
check("D46", "参数为空的 protection 也标出写法", d46.antiIldasm, (v) => String(v).includes("anti ildasm"));
check("D46", "constants 标出 protection id", d46.constants, (v) => String(v).includes("constants"));

console.log("\n47) 口令字段不明文显示，且带标签关联");
const d47 = await evaluate(`(() => {
  const bag = document.querySelector('[data-opt-groups="encrypt"]');
  const secretInputs = bag.querySelectorAll('input[type="password"][data-opt]');
  const first = secretInputs[0];
  const label = first ? document.querySelector('label[for="' + first.id + '"]') : null;
  return {
    secretCount: secretInputs.length,
    names: [...secretInputs].map((i) => i.dataset.opt),
    labelled: !!label,
    labelText: label ? label.textContent.trim() : "",
    // 所有下拉/数字/文本控件都该能用 for 关联到标签
    unlabelled: [...bag.querySelectorAll("select[data-opt], input[type=number][data-opt], input[type=text][data-opt]")]
      .filter((el) => !document.querySelector('label[for="' + el.id + '"]')).length,
  };
})()`);
results.D47 = d47;
check("D47", "口令类字段用 password 渲染", d47.secretCount, (v) => v >= 2);
check("D47", "两个口令字段都在", d47.names.join(","), (v) => String(v).includes("renamePassword") && String(v).includes("snKeyPass"));
check("D47", "口令字段有标签关联", d47.labelled, true);
check("D47", "非开关控件全部有标签关联", d47.unlabelled, 0);

// ---------------------------------------------------------------- 汇总

console.log("\n================ 探针结果 ================");
console.log(JSON.stringify(results, null, 2));

console.log("\n================ 断言汇总 ================");
if (failures.length === 0) console.log("全部通过");
else for (const f of failures) console.log(`FAIL  ${f}`);
if (skipped.length) {
  console.log("\n跳过：");
  for (const s of skipped) console.log(`SKIP  ${s}`);
}
console.log(`\n未通过 ${failures.length} 项 / 跳过 ${skipped.length} 项`);

writeFileSync(join(OUT, "probe-result.json"), JSON.stringify({ results, failures, skipped }, null, 2));

ws.close();
chrome.kill();
try {
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* Windows 下可能仍被占用，忽略 */
}

process.exit(failures.length === 0 ? 0 : 1);
