import type { LogEvent, Stage } from "../types";

const STAGE_TAG: Record<Stage, string> = {
  merge: "合并",
  encrypt: "加密",
  package: "打包",
};

/**
 * 日志行的上限。
 *
 * Inno 在大型工程上能刷出几万行，而这里每行都是一个 DOM 节点：不设上限的话
 * 内存与滚动性能会随着一次构建持续变差。超出后一次裁掉一批，
 * 而不是每追加一行就删一行（后者会反复触发回流）。
 */
const MAX_LINES = 5000;
const TRIM_CHUNK = 500;

export interface LogPanelHandle {
  el: HTMLElement;
  append(event: LogEvent): void;
  clear(): void;
  reset(): void;
}

export interface LogPanelOptions {
  /** 「复制全部」的出口：面板只负责取文本，写剪贴板与提示由调用方决定 */
  onCopy?: (text: string) => void;
}

export function createLogPanel(opts: LogPanelOptions = {}): LogPanelHandle {
  const el = document.createElement("footer");
  el.className = "logbar";

  const header = document.createElement("div");
  header.className = "log-head";

  const title = document.createElement("span");
  title.className = "log-title";
  title.textContent = "运行日志";

  const counter = document.createElement("span");
  counter.className = "log-count";
  counter.textContent = "0";

  const spacer = document.createElement("span");
  spacer.className = "spacer";

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-quiet btn-xs";
  copyBtn.textContent = "复制";
  copyBtn.title = "复制全部输出到剪贴板";

  const clearBtn = document.createElement("button");
  clearBtn.className = "btn btn-quiet btn-xs";
  clearBtn.textContent = "清空";

  const foldBtn = document.createElement("button");
  foldBtn.className = "btn btn-quiet btn-xs";
  foldBtn.textContent = "折叠";

  header.append(title, counter, spacer, copyBtn, clearBtn, foldBtn);

  const body = document.createElement("div");
  body.className = "log-body";
  // 读屏软件要能播报新出现的输出；polite 不打断用户当前的朗读
  body.setAttribute("role", "log");
  body.setAttribute("aria-live", "polite");
  body.setAttribute("aria-label", "运行日志输出");

  const empty = document.createElement("div");
  empty.className = "log-empty";
  empty.textContent = "暂无输出。执行任意阶段后，命令行回显会实时出现在这里。";
  body.appendChild(empty);

  // 版权与版本号不放在这里——它们在窗口底部的状态栏，避免重复。
  el.append(header, body);

  let count = 0;
  let collapsed = false;

  const updateCounter = () => {
    counter.textContent = String(count);
  };

  const lines = () => [...body.querySelectorAll<HTMLElement>("[data-line]")];

  /** 把可见输出拼成纯文本（右键菜单与「复制」按钮共用一份口径） */
  const text = () => lines().map((l) => l.innerText).join("\n");

  copyBtn.onclick = () => {
    const content = text();
    if (!content.trim()) {
      opts.onCopy?.("");
      return;
    }
    opts.onCopy?.(content);
  };

  clearBtn.onclick = () => {
    body.querySelectorAll("[data-line]").forEach((n) => n.remove());
    count = 0;
    updateCounter();
    if (!body.contains(empty)) body.appendChild(empty);
  };

  foldBtn.onclick = () => {
    collapsed = !collapsed;
    body.classList.toggle("is-collapsed", collapsed);
    foldBtn.textContent = collapsed ? "展开" : "折叠";
  };

  return {
    el,
    append(event) {
      if (empty.parentElement === body) empty.remove();

      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;

      const line = document.createElement("div");
      line.dataset.line = "1";
      line.className = event.stream === "stderr" ? "log-line is-err" : "log-line";

      const tag = document.createElement("span");
      tag.className = `log-tag t-${event.stage}`;
      tag.textContent = STAGE_TAG[event.stage];

      const stream = document.createElement("span");
      stream.className = "log-stream";
      stream.textContent = event.stream === "system" ? "sys" : event.stream === "stderr" ? "err" : "out";

      const content = document.createElement("span");
      content.className = "log-text";
      content.textContent = event.line;

      line.append(tag, stream, content);
      body.appendChild(line);

      count += 1;
      updateCounter();

      // 超限时一次裁掉一批：逐行删会造成每追加一行就回流一次
      if (count > MAX_LINES) {
        const all = lines();
        const drop = Math.min(all.length, TRIM_CHUNK);
        for (let i = 0; i < drop; i += 1) all[i]!.remove();
      }

      if (nearBottom) body.scrollTop = body.scrollHeight;
    },
    clear() {
      clearBtn.click();
    },
    reset() {
      clearBtn.click();
      body.scrollTop = 0;
    },
  };
}

/** 供调用方复用同一份「把日志拼成文本」的口径（右键菜单的「复制全部输出」）。 */
export function logPanelText(el: HTMLElement): string {
  const body = el.querySelector<HTMLElement>(".log-body");
  if (!body) return "";
  return [...body.querySelectorAll<HTMLElement>("[data-line]")].map((l) => l.innerText).join("\n");
}
