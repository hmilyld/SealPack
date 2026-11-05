/**
 * SealPack UI 探针（React + Fluent UI React 版）。
 *
 * 用 CDP 驱动真实 Chromium，验证主题、原生感、步骤导航、文件树、打包语义、
 * 选项预设、预检与执行状态。它不替代人工目测，但能挡住「重构后接线断了」。
 *
 * 用法：
 *   pnpm run build:preview
 *   node scripts/ui-probe.mjs "file:///D:/Codespace/SealPack/SealPack/dist-preview" docs/shots
 *
 * 也可以对着 dev server：
 *   node scripts/ui-probe.mjs http://localhost:1420 docs/shots
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:1420";
const OUT = process.argv[3] ?? "docs/shots";
const PORT = 9335;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((path) => existsSync(path));
if (!CHROME) {
  console.error("找不到 Chrome / Edge，请用 CHROME_PATH 指定。");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(250);
  }
  throw new Error("无法连接到 Chrome 调试端口");
}

const results = [];
const assert = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

let wsUrl;
try {
  wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message);
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

  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(`${response.exceptionDetails.text} ${expression}`);
    }
    return response.result.value;
  };

  const waitFor = async (expression, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await evaluate(`!!(${expression})`).catch(() => false);
      if (ok) return true;
      await sleep(100);
    }
    return false;
  };

  const goto = async (query = "") => {
    await send("Page.navigate", { url: `${BASE}/preview.html${query}` });
    await waitFor(`document.querySelector('[data-step="setup"]')`, 12000);
    await sleep(700);
  };

  const click = async (selector) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  const clickText = async (text) =>
    evaluate(`(() => {
      const nodes = [...document.querySelectorAll("button, [role='menuitem']")];
      const el = nodes.find((node) => node.innerText.includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 只在当前可见的最上层对话框里找按钮，避免点到设置弹窗里隐藏的「保存设置」。 */
  const clickDialogText = async (text) =>
    evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((dialog) => {
        const rect = dialog.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return false;
      const el = [...dialog.querySelectorAll("button")].find(
        (button) => button.innerText.trim() === ${JSON.stringify(text)},
      );
      if (!el) return false;
      el.click();
      return true;
    })()`);

  const bodyText = () => evaluate(`document.body.innerText`);

  const rowByText = (text) =>
    `[...document.querySelectorAll('[role="treeitem"]')].find((row) => row.innerText.includes(${JSON.stringify(text)}))`;

  const rowState = async (text) =>
    evaluate(`(() => {
      const row = ${rowByText(text)};
      if (!row) return null;
      return {
        checked: row.getAttribute("aria-checked"),
        text: row.innerText,
        hasCheckbox: !!row.querySelector('input[type="checkbox"]'),
      };
    })()`);

  const toggleRow = async (text) =>
    evaluate(`(() => {
      const row = ${rowByText(text)};
      const input = row?.querySelector('input[type="checkbox"]');
      if (!input) return false;
      input.click();
      return true;
    })()`);

  const clickRow = async (text) =>
    evaluate(`(() => {
      const row = ${rowByText(text)};
      if (!row) return false;
      row.click();
      return true;
    })()`);

  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`  · ${file}`);
  };

  const press = (key) => `(() => {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
    }));
    return true;
  })()`;

  // ---------------------------------------------------------------- A. 主题
  console.log("\nA. 主题");
  await goto("?theme=light");
  assert(
    "light 主题写入根元素",
    (await evaluate(`document.documentElement.dataset.theme`)) === "light",
  );
  await goto("?theme=dark");
  assert(
    "dark 主题写入根元素与 .dark",
    (await evaluate(`document.documentElement.dataset.theme === "dark" && document.documentElement.classList.contains("dark")`)) === true,
  );
  await goto("?theme=system");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await sleep(400);
  assert(
    "跟随系统：模拟深色后界面变深",
    (await evaluate(`document.documentElement.dataset.theme`)) === "dark",
  );
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await sleep(400);
  assert(
    "跟随系统：模拟浅色后界面变浅",
    (await evaluate(`document.documentElement.dataset.theme`)) === "light",
  );

  // ---------------------------------------------------------------- B. 原生感
  console.log("\nB. 原生感");
  const metrics = await evaluate(`(() => {
    const titlebar = document.querySelector(".app-titlebar");
    const statusbar = document.querySelector(".app-statusbar");
    const body = getComputedStyle(document.body);
    return {
      titlebar: titlebar?.getBoundingClientRect().height ?? 0,
      statusbar: statusbar?.getBoundingClientRect().height ?? 0,
      fontSize: body.fontSize,
      userSelect: body.userSelect,
      cursor: body.cursor,
      steps: document.querySelectorAll('[role="tab"]').length,
    };
  })()`);
  assert("标题栏 40px", Math.abs(metrics.titlebar - 40) < 1, `${metrics.titlebar}px`);
  assert("状态栏 28px", Math.abs(metrics.statusbar - 28) < 1, `${metrics.statusbar}px`);
  assert("正文字号 14px", metrics.fontSize === "14px", metrics.fontSize);
  assert("界面文字不可拖选", metrics.userSelect === "none", metrics.userSelect);
  assert("默认箭头光标", metrics.cursor === "default", metrics.cursor);
  assert("五个步骤", metrics.steps === 5, `${metrics.steps} 个`);

  const appTokens = await evaluate(`(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      space4: style.getPropertyValue("--app-space-4").trim(),
      row: style.getPropertyValue("--app-row-h").trim(),
      body: style.getPropertyValue("--app-font-body").trim(),
      radius: style.getPropertyValue("--app-radius-lg").trim(),
    };
  })()`);
  assert("token：4pt 间距（space-4 = 16px）", appTokens.space4 === "16px", appTokens.space4);
  assert("token：树行 30px", appTokens.row === "30px", appTokens.row);
  assert("token：正文 14px", appTokens.body === "14px", appTokens.body);
  assert("token：卡片圆角 8px", appTokens.radius === "8px", appTokens.radius);

  // ---------------------------------------------------------------- C. 交互
  console.log("\nC. 交互");
  await click('[data-step="merge"]');
  await sleep(300);
  const treeReady = await waitFor(`document.querySelector('[role="tree"]')`);
  assert("合并页渲染文件树", treeReady);

  await evaluate(`(() => {
    const row = ${rowByText("libs")};
    const chevron = row?.querySelector("button");
    chevron?.click();
    return true;
  })()`);
  await sleep(200);
  const libsState = await rowState("libs");
  assert("目录显示三态（部分）", libsState?.checked === "mixed", JSON.stringify(libsState));

  const beforeToggle = await rowState("Newtonsoft.Json.dll");
  await toggleRow("Newtonsoft.Json.dll");
  await sleep(400);
  const afterToggle = await rowState("Newtonsoft.Json.dll");
  assert(
    "勾选文件改变 aria-checked",
    beforeToggle?.checked !== afterToggle?.checked,
    `${beforeToggle?.checked} → ${afterToggle?.checked}`,
  );
  // 还原，避免影响后面的合并清单断言
  await toggleRow("Newtonsoft.Json.dll");
  await sleep(300);

  // 右键菜单
  await evaluate(`(() => {
    const row = document.querySelector(".app-rail button[title]");
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10,
    }));
    return true;
  })()`);
  await sleep(200);
  assert("工程行右键菜单出现", (await evaluate(`!!document.querySelector('[role="menu"]')`)) === true);
  const projectMenuText = await bodyText();
  assert("右键菜单包含打开目录", projectMenuText.includes("打开主程序目录"));
  assert("右键菜单包含重新加载", projectMenuText.includes("重新加载工程"));
  assert("右键菜单包含重命名", projectMenuText.includes("重命名"));
  assert("右键菜单包含删除工程", projectMenuText.includes("删除工程"));
  await evaluate(press("Escape"));
  await sleep(200);
  assert("Esc 关闭右键菜单", (await evaluate(`!document.querySelector('[role="menu"]')`)) === true);

  // 步骤条键盘
  await evaluate(`document.querySelector('[data-step="merge"]').focus()`);
  await evaluate(press("ArrowRight"));
  await sleep(200);
  assert(
    "步骤条方向键切到下一步",
    (await evaluate(`document.querySelector('[data-step="encrypt"]').getAttribute("aria-selected")`)) === "true",
  );

  // ---------------------------------------------------------------- D. 向导
  console.log("\nD. 向导与文件树");
  await click('[data-step="merge"]');
  await sleep(300);
  const mergeText = await bodyText();
  const hasMainRow = await evaluate(
    `[...document.querySelectorAll('[role="treeitem"]')].some((row) => row.innerText.split("\\n")[0] === "SampleTool.exe")`,
  );
  assert("合并页隐藏主程序", hasMainRow === false);
  assert("合并清单显示已选", mergeText.includes("合并清单") && mergeText.includes("3 项"));
  await shot("probe-merge");

  await click('[data-step="package"]');
  await waitFor(`document.body.innerText.includes("6 个文件")`, 4000);
  const mainRow = await rowState("SampleTool.exe");
  const autoRow = await rowState("Newtonsoft.Json.dll");
  assert("打包页主程序锁定且已勾选", mainRow?.checked === "true" && mainRow.text.includes("始终打包"));
  assert(
    "打包页自动项未勾选且标注自动排除",
    autoRow?.checked === "false" && autoRow.text.includes("自动排除"),
  );
  const packageText = await bodyText();
  const packageLines = packageText.split("\n").filter((line) => /个文件|打包/.test(line)).join(" | ");
  assert(
    "打包计数一致",
    packageText.includes("6 个文件") && packageText.includes("打包 6 / 共 10 个文件"),
    packageLines,
  );
  await toggleRow("ICSharpCode.SharpZipLib.dll");
  await waitFor(`document.body.innerText.includes("5 个文件")`, 4000);
  const afterPackageText = await bodyText();
  assert(
    "取消勾选后打包计数下降",
    afterPackageText.includes("5 个文件"),
    afterPackageText.split("\n").filter((line) => /个文件|打包/.test(line)).join(" | "),
  );

  // libs 目录默认折叠；全部排除/全部打包必须覆盖折叠目录里的文件
  await clickText("全部排除");
  await waitFor(`document.body.innerText.includes("打包 1 / 共 10 个文件")`, 4000);
  assert(
    "全部排除覆盖折叠目录",
    (await bodyText()).includes("打包 1 / 共 10 个文件"),
    "折叠目录里的文件也应被排除",
  );
  const libsExcluded = await rowState("libs");
  assert(
    "折叠目录全部排除后为未选",
    libsExcluded?.checked === "false",
    JSON.stringify(libsExcluded),
  );
  await clickText("全部打包");
  await waitFor(`document.body.innerText.includes("打包 7 / 共 10 个文件")`, 4000);
  assert(
    "全部打包恢复全部文件",
    (await bodyText()).includes("打包 7 / 共 10 个文件"),
    "折叠目录与之前手动排除的文件也应被重新打包",
  );
  const libsPacked = await rowState("libs");
  assert(
    "折叠目录全部打包后为部分（含自动排除项）",
    libsPacked?.checked === "mixed",
    JSON.stringify(libsPacked),
  );

  await clickRow("ICSharpCode.SharpZipLib.dll");
  await waitFor(`document.body.innerText.includes("打包 6 / 共 10 个文件")`, 4000);

  // 点击整行即可反选，不再要求必须点 checkbox
  await clickRow("readme.txt");
  await waitFor(`document.body.innerText.includes("打包 5 / 共 10 个文件")`, 4000);
  assert(
    "点击行即可反选",
    (await bodyText()).includes("打包 5 / 共 10 个文件"),
    "点击行应切换选中状态",
  );
  await clickRow("readme.txt");
  await waitFor(`document.body.innerText.includes("打包 6 / 共 10 个文件")`, 4000);
  assert(
    "再次点击行恢复选中",
    (await bodyText()).includes("打包 6 / 共 10 个文件"),
    "点击行应再次切换选中状态",
  );
  await shot("probe-package");

  // ---------------------------------------------------------------- E. 选项
  console.log("\nE. 选项");
  await click('[data-step="encrypt"]');
  await sleep(300);
  const presetClicked = await clickText("标准（推荐）");
  await sleep(600);
  const encryptText = await bodyText();
  const template = await evaluate(`document.querySelector("textarea")?.value ?? ""`);
  assert("加密预设可点击", presetClicked);
  assert("加密预设启用保护", encryptText.includes("启用"), encryptText.slice(0, 120));
  assert("加密模板随预设重建", template.includes("protection"), template.slice(0, 80));

  await click('[data-step="package"]');
  await sleep(300);
  await clickText("绿色版");
  await sleep(600);
  const portable = await evaluate(`[...document.querySelectorAll("select")].some((s) => s.value === "portable")`);
  assert("打包预设切换到绿色版", portable === true);
  await clickText("标准发布");
  await sleep(400);

  // ---------------------------------------------------------------- F. 执行
  console.log("\nF. 执行与预检");
  await click('[data-step="run"]');
  await sleep(500);
  const runText = await bodyText();
  assert("执行页显示构建预检", runText.includes("构建预检"));
  assert("预检列出主程序检查", runText.includes("主程序"));
  await shot("probe-run");

  await clickText("全部执行");
  await sleep(400);
  const dialogText = await bodyText();
  const hasWarningDialog = dialogText.includes("预检有");
  assert("有警告时先确认", hasWarningDialog, hasWarningDialog ? "" : "未出现确认对话框");
  if (hasWarningDialog) {
    await clickText("取消");
    await sleep(300);
  }

  await clickText("执行合并");
  await sleep(700);
  const afterRun = await bodyText();
  assert("单独执行后状态变为已完成", afterRun.includes("已完成"));
  assert("产出文件按钮出现", afterRun.includes("SampleTool.exe"));
  // 预检卡很长，把阶段行滚进视口再截图。
  await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find(
      (el) => el.textContent?.trim() === "执行合并",
    );
    button?.scrollIntoView({ block: "center" });
    return !!button;
  })()`);
  await sleep(400);
  await shot("probe-run-done");

  // ---------------------------------------------------------------- H. 升级包
  console.log("\nH. 升级包");
  await click('[data-step="package"]');
  await sleep(400);

  const pickArtifact = async (value) =>
    evaluate(`(() => {
      const input = [...document.querySelectorAll('input[type="radio"]')].find(
        (el) => el.value === ${JSON.stringify(value)},
      );
      if (!input) return false;
      input.click();
      return true;
    })()`);

  assert("产物切换到升级包", await pickArtifact("upgrade"));
  await waitFor(`document.body.innerText.includes("升级差异")`, 4000);
  await waitFor(`document.body.innerText.includes("1.4.1.0")`, 4000);
  const upgradeText = await bodyText();
  assert(
    "升级面板显示基线与差异",
    upgradeText.includes("升级差异") &&
      upgradeText.includes("基线清单") &&
      upgradeText.includes("1.4.1.0"),
  );
  assert(
    "差异包含新增 / 修改 / 删除",
    upgradeText.includes("新增") && upgradeText.includes("修改") && upgradeText.includes("删除"),
  );
  assert(
    "差异列出变更文件",
    upgradeText.includes("SampleTool.exe") && upgradeText.includes("old-helper.dll"),
  );
  // 截图要能看到基线卡与差异清单，而不是只露出「升级差异」标题。
  await evaluate(`(() => {
    const heading = [...document.querySelectorAll("*")].find(
      (el) => el.children.length === 0 && el.textContent?.trim() === "升级差异",
    );
    heading?.scrollIntoView({ block: "start" });
    return !!heading;
  })()`);
  await sleep(400);
  await shot("probe-upgrade");

  assert("产物切换到两者", await pickArtifact("both"));
  await sleep(500);
  await click('[data-step="run"]');
  await sleep(400);
  await clickText("执行打包");
  await sleep(800);
  const bothText = await bodyText();
  assert(
    "两者产出两个安装包",
    bothText.includes("安装包-1.4.2.0") && bothText.includes("升级包-1.4.2.0"),
    bothText.slice(-240),
  );

  // ---------------------------------------------------------------- G. 持久化
  console.log("\nG. 持久化");
  await evaluate(`localStorage.setItem("sealpack:theme", "dark")`);
  await goto("");
  assert(
    "刷新后主题保持深色",
    (await evaluate(`document.documentElement.dataset.theme`)) === "dark",
  );
  await evaluate(`localStorage.setItem("sealpack:theme", "system")`);

  await shot("probe-setup");

  // ---------------------------------------------------------------- I. 设置
  console.log("\nI. 设置");
  await goto("?dialog=settings");
  await sleep(600);
  const dialogFocus = await evaluate(`(() => {
    const active = document.activeElement;
    const tab = [...document.querySelectorAll('[role="tab"]')].find((item) =>
      item.innerText.includes("工具链"),
    );
    return {
      activeRole: active?.getAttribute?.("role") ?? null,
      tabFocused: tab === active,
      tabFocusVisible: tab?.matches(":focus-visible") ?? null,
    };
  })()`);
  assert(
    "设置打开时焦点不在第一个 tab",
    dialogFocus.activeRole === "dialog" && dialogFocus.tabFocused === false,
    JSON.stringify(dialogFocus),
  );
  const dialogGeometry = await evaluate(`(() => {
    const surface = document.querySelector('[role="dialog"]');
    if (!surface) return null;
    const sr = surface.getBoundingClientRect();
    const body = surface.querySelector('[class*="DialogBody"]');
    const footer = body?.lastElementChild;
    const fr = footer?.getBoundingClientRect();
    const content = surface.querySelector('[class*="DialogContent"]');
    const cr = content?.getBoundingClientRect();
    return {
      surface: { top: sr.top, bottom: sr.bottom, height: sr.height },
      footer: fr ? { top: fr.top, bottom: fr.bottom } : null,
      content: cr
        ? { top: cr.top, bottom: cr.bottom, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight }
        : null,
    };
  })()`);
  assert("设置对话框存在", dialogGeometry !== null);
  assert(
    "设置 footer 在对话框内",
    dialogGeometry?.footer?.bottom <= dialogGeometry?.surface?.bottom,
    JSON.stringify(dialogGeometry),
  );
  assert(
    "设置内容区高度受限",
    dialogGeometry?.content?.bottom <= dialogGeometry?.footer?.top,
    JSON.stringify(dialogGeometry),
  );
  await shot("probe-settings");

  // ---------------------------------------------------------------- J. 工程管理
  console.log("\nJ. 工程管理");
  await goto("");
  const openProjectMenu = async () =>
    evaluate(`(() => {
      const row = document.querySelector(".app-rail button[title]");
      if (!row) return false;
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10,
      }));
      return true;
    })()`);

  await openProjectMenu();
  await sleep(200);
  await clickText("重命名");
  await waitFor(`!!document.querySelector('[role="dialog"] input')`, 4000);
  const renamePrefilled = await waitFor(
    `document.querySelector('[role="dialog"] input')?.value === "示例工具 Pro"`,
    4000,
  );
  assert(
    "重命名弹窗智能预填产品名",
    renamePrefilled,
    await evaluate(`document.querySelector('[role="dialog"] input')?.value ?? ""`),
  );
  await sleep(400);
  await shot("probe-rename");
  await clickDialogText("保存");
  await waitFor(`document.body.innerText.includes("示例工具 Pro")`, 4000);
  assert(
    "重命名后工程栏更新",
    (await bodyText()).includes("示例工具 Pro"),
  );

  await openProjectMenu();
  await sleep(200);
  await clickText("删除工程");
  await waitFor(`document.body.innerText.includes("只删除工程配置")`, 4000);
  const deleteText = await bodyText();
  assert(
    "删除工程弹窗说明只删配置",
    deleteText.includes("只删除工程配置") && deleteText.includes("安装包、校验清单和日志都会保留"),
  );
  await sleep(400);
  await shot("probe-delete");
  await clickDialogText("取消");
  await waitFor(`!document.querySelector('[role="dialog"]')`, 4000);
  assert(
    "取消删除后工程仍在",
    (await bodyText()).includes("示例工具 Pro"),
  );

  await openProjectMenu();
  await sleep(200);
  await clickText("重新加载工程");
  await waitFor(`document.body.innerText.includes("工程已重新加载")`, 4000);
  assert(
    "重新加载工程成功",
    (await bodyText()).includes("工程已重新加载"),
  );
} catch (error) {
  console.error(error);
  results.push({ name: "探针异常", ok: false, detail: String(error) });
} finally {
  ws?.close();
  chrome.kill();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("FAIL:");
  failed.forEach((result) => console.log(`  - ${result.name} ${result.detail}`));
  process.exit(1);
}
