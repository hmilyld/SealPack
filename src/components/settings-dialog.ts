import { api, onToolProgress, pickToolExe } from "../api";
import { openDialog } from "./modal";
import { toast } from "./toast";
import type { RuntimeStatus, Settings, ToolInfo, ToolProgress, ToolStatus } from "../types";

const FIELD_KEY: Record<string, keyof Settings> = {
  ilmerge: "ilmergePath",
  confuser: "confuserPath",
  iscc: "isccPath",
};

const ROW_STACK = "display:flex;flex-direction:column;gap:var(--gap-2);margin-top:var(--gap-2)";

/** 阶段名 → 中文。进度事件里的 phase 是稳定的英文标识，展示时才翻译。 */
const PHASE_LABEL: Record<ToolProgress["phase"], string> = {
  download: "下载",
  verify: "校验",
  extract: "解压",
  install: "安装",
  done: "完成",
};

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function originLabel(item: ToolInfo): string {
  if (!item.available) return "未找到";
  switch (item.origin) {
    case "custom":
      return "已就绪（自定义路径）";
    case "downloaded":
      return "已就绪（已下载）";
    default:
      return "已就绪（应用内置）";
  }
}

// ---------------------------------------------------------------- 进度桥
//
// 下载是后台任务：弹窗被关掉之后事件仍然会来，所以订阅常驻。
// 用「一组监听器」而不是「单个回调」：两个工具可以同时下载，
// 各自注册自己的监听器，先完成的那个退订时不会把后一个的转发也解掉。

const progressListeners = new Set<(p: ToolProgress) => void>();
let bridgeReady = false;

function ensureBridge(): void {
  if (bridgeReady) return;
  bridgeReady = true;
  void onToolProgress((p) => {
    for (const listener of [...progressListeners]) listener(p);
  }).catch(() => {
    // 浏览器预览环境没有真实的事件通道，忽略即可
  });
}

/**
 * 设置对话框：配置三个外部工具的路径，展示运行环境状态，
 * 并允许直接下载缺失的工具。返回 null 表示用户取消。
 */
export function settingsDialog(input: {
  settings: Settings;
  status: ToolStatus;
  runtime: RuntimeStatus;
}): Promise<Settings | null> {
  return new Promise((resolve) => {
    ensureBridge();

    const draft: Settings = { ...input.settings };
    // 下载会改变工具的定位结果，所以这里持一份可变的副本，
    // 不直接改调用方传进来的对象 —— 主界面在弹窗关闭后会重新拉一次状态。
    const items = new Map<string, ToolInfo>();
    for (const item of input.status.items) items.set(item.key, { ...item });

    let close = () => {};
    // 弹窗关掉之后下载仍会继续跑完（Rust 侧的任务不会因为界面消失而中止），
    // 这个标记只用来决定「还要不要往界面上写字」。
    let alive = true;

    const content = document.createElement("div");
    content.className = "dialog-stack";

    // ---- 外部工具路径
    const toolSection = document.createElement("section");

    const toolLabel = document.createElement("h3");
    toolLabel.className = "section-label";
    toolLabel.textContent = "外部工具路径";

    const toolNote = document.createElement("p");
    toolNote.className = "section-note";
    toolNote.textContent =
      "留空表示使用应用内置的工具；内置工具缺失时，可直接下载到用户目录，无需手动配置。";

    const list = document.createElement("div");
    list.setAttribute("style", ROW_STACK);

    /** 每行的可变部件，下载过程中只更新这些，不整行重建（否则输入框会失焦）。 */
      interface Row {
        item: ToolInfo;
        dot: HTMLElement;
        state: HTMLElement;
        go: HTMLButtonElement | null;
        bar: HTMLElement | null;
        fill: HTMLElement | null;
        msg: HTMLElement | null;
        busy: boolean;
        error: string;
        /** 常态解释（例如为什么禁用下载），进度与报错只是临时占位 */
        noteText: string;
        /** 行对应的路径输入框与设置键：下载完成后把路径写回这里 */
        field: HTMLInputElement;
        fieldKey: keyof Settings;
      }

    const rows = new Map<string, Row>();
    const inputs = new Map<string, HTMLInputElement>();

    function paint(row: Row): void {
      const { item } = row;
      row.dot.className = item.available ? "status-dot" : "status-dot is-bad";
      row.state.textContent = row.busy ? "下载中…" : row.error || originLabel(item);
      row.state.title = item.available ? item.path : "";

      if (!row.go || !row.bar || !row.fill || !row.msg) return;

      if (row.busy) {
        row.go.disabled = true;
        row.go.textContent = "下载中…";
      } else if (row.error) {
        row.go.disabled = false;
        row.go.textContent = "重试";
      } else {
        row.go.disabled = item.overridden;
        row.go.textContent = item.available ? "重新下载" : "下载";
      }
      row.bar.hidden = !row.busy;
      // 报错是临时的，常态要回到 noteText（比如「已自定义路径」那条解释）。
      // 少了这一层，paint 一次就把说明覆盖成空字符串。
      if (!row.busy) row.msg.textContent = row.error || row.noteText;
    }

    function buildDownloadStrip(
      row: Row,
      field: HTMLInputElement,
      fieldKey: keyof Settings,
    ): HTMLElement | null {
      const info = row.item.download;
      if (!info) return null;

      const strip = document.createElement("div");
      strip.className = "dl";

      const head = document.createElement("div");
      head.className = "dl-head";

      const src = document.createElement("span");
      src.className = "dl-src";
      src.textContent = `${row.item.label} ${info.version} · ${humanSize(info.size)} · ${info.origin}`;

      const go = document.createElement("button");
      go.type = "button";
      go.className = "btn btn-quiet btn-sm dl-go";
      go.dataset.dl = row.item.key;

      head.append(src, go);

      // 本机已装的一份：装 Inno Setup 需要管理员授权，而它常常是开发机上现成的。
      // 填进路径框就能用，既不下载 10 MB，也不必点 UAC —— 比默认走下载更该先看到。
      let useSystem: HTMLButtonElement | null = null;
      if (info.systemPath && !row.item.overridden) {
        useSystem = document.createElement("button");
        useSystem.type = "button";
        useSystem.className = "btn btn-quiet btn-sm";
        useSystem.textContent = "使用本机";
        useSystem.title = info.systemPath;
        useSystem.onclick = () => {
          field.value = info.systemPath as string;
          draft[fieldKey] = info.systemPath as string;
          row.error = "";
          paint(row);
        };
        head.appendChild(useSystem);
      }

      const note = document.createElement("p");
      note.className = "dl-note";
      note.textContent = info.note;

      const bar = document.createElement("div");
      bar.className = "dl-bar";
      bar.hidden = true;
      const fill = document.createElement("span");
      fill.className = "dl-fill";
      bar.appendChild(fill);

      const msg = document.createElement("p");
      msg.className = "dl-msg";

      strip.append(head, note, bar, msg);

      row.go = go;
      row.bar = bar;
      row.fill = fill;
      row.msg = msg;

      // 已自定义路径时下载不会改变生效的路径：内置目录和下载目录都在回退链的后面。
      // 与其让用户白等 10 MB，不如把按钮禁掉并说清原因。
      if (row.item.overridden) {
        row.noteText =
          "当前已自定义路径，下载不会改变生效的路径。如需改用下载的工具，请先点「默认」清空。";
        msg.textContent = row.noteText;
      }

      go.onclick = () => void startDownload(row);
      return strip;
    }

    async function startDownload(row: Row): Promise<void> {
      if (row.busy) return;
      row.busy = true;
      row.error = "";
      paint(row);
      if (row.msg) row.msg.textContent = "正在准备…";

      // 事件是按工具分流的：三个工具各自有进度，不能串到别人的行上。
      // 同时也要看 alive —— 弹窗关掉后 Rust 侧的任务仍会跑完，
      // 但那时不该再往已经不在文档里的元素上写字。
      const listener = (p: ToolProgress) => {
        if (!alive || p.key !== row.item.key || !row.busy) return;
        if (row.msg) {
          const prefix = p.phase === "download" ? "" : `${PHASE_LABEL[p.phase]}：`;
          row.msg.textContent = `${prefix}${p.message}`;
        }
        if (row.bar && row.fill) {
          // total 为 0 表示服务端没给长度：此时显示不定进度，而不是假装 0%
          row.bar.classList.toggle("is-unknown", p.total === 0);
          row.fill.style.width =
            p.total === 0 ? "" : `${Math.min(100, Math.round((p.received / p.total) * 100))}%`;
        }
      };
      progressListeners.add(listener);

      try {
        const next = await api.downloadTool(row.item.key);
        const updated = next.items.find((t: ToolInfo) => t.key === row.item.key);
        if (updated) row.item = { ...updated };
        row.busy = false;
        // 下载完成后把路径写回输入框与草稿：用户保存时就能直接用刚下的那份，
        // 不必再手动「浏览」去指一次。覆盖的前提是按钮没被禁用（已自定义路径时按钮禁用，
        // startDownload 进不来），所以这里不会误伤用户自己填的路径。
        if (updated?.path) {
          row.field.value = updated.path;
          draft[row.fieldKey] = updated.path;
        }
        if (alive) {
          paint(row);
          if (row.msg) row.msg.textContent = `${row.item.label} 已下载完成`;
        }
        toast(`${row.item.label} 已下载完成`, "success");
      } catch (err) {
        row.busy = false;
        row.error = err instanceof Error ? err.message : String(err);
        if (alive) paint(row);
        // 弹窗可能已经关了，Toast 是唯一还能把原因说清楚的地方。
        // 只取第一行：Rust 侧的报错带多行诊断信息，塞进 Toast 会溢出。
        toast(`${row.item.label} 下载失败：${row.error.split("\n")[0]}`, "error");
      } finally {
        progressListeners.delete(listener);
      }
    }

    for (const key of items.keys()) {
      const item = items.get(key)!;
      const fieldKey = FIELD_KEY[item.key];
      if (!fieldKey) continue;

      // 输入框先建好再塞进 row：`Row.field` 是必填的，早先用
      // `null as unknown as HTMLInputElement` 占位，把类型系统绕过去了，
      // 一旦有人漏赋值就是运行时炸。
      const field = document.createElement("input");
      field.className = "input";
      field.spellcheck = false;
      field.value = draft[fieldKey];
      field.placeholder = item.defaultPath;
      inputs.set(item.key, field);

      const row: Row = {
        item,
        dot: document.createElement("span"),
        state: document.createElement("span"),
        go: null,
        bar: null,
        fill: null,
        msg: null,
        busy: false,
        error: "",
        noteText: "",
        field,
        fieldKey,
      };

      const el = document.createElement("div");
      el.className = "tool-row";

      const head = document.createElement("div");
      head.className = "tool-row-head";

      row.dot.className = item.available ? "status-dot" : "status-dot is-bad";

      const name = document.createElement("span");
      name.className = "tool-row-name";
      name.textContent = item.label;

      head.append(row.dot, name);

      if (item.needsDotnet) {
        const flag = document.createElement("span");
        flag.className = "tool-flag";
        flag.textContent = "依赖 .NET Framework";
        head.appendChild(flag);
      }

      if (item.overridden) {
        const flag = document.createElement("span");
        flag.className = "tool-flag is-custom";
        flag.textContent = "已自定义";
        head.appendChild(flag);
      }

      row.state.className = "tool-state";
      head.appendChild(row.state);

      const line = document.createElement("div");
      line.className = "field-row";

      const browse = document.createElement("button");
      browse.type = "button";
      browse.className = "btn btn-quiet btn-sm";
      browse.textContent = "浏览";

      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "btn btn-quiet btn-sm";
      reset.textContent = "默认";

      browse.onclick = async () => {
        try {
          const picked = await pickToolExe(`选择 ${item.label} 可执行文件`);
          if (!picked) return;
          field.value = picked;
          draft[fieldKey] = picked;
          row.error = "";
          paint(row);
        } catch (err) {
          // 同 modal.ts：不能让底层报错变成静默的 unhandled rejection
          row.error = String(err instanceof Error ? err.message : err);
          paint(row);
        }
      };

      reset.onclick = () => {
        field.value = "";
        draft[fieldKey] = "";
        row.error = "";
        row.state.textContent = "将使用内置或已下载的工具";
      };

      field.oninput = () => {
        draft[fieldKey] = field.value;
        row.error = "";
        row.state.textContent = "";
      };

      line.append(field, browse, reset);
      el.append(head, line);

      const strip = buildDownloadStrip(row, field, fieldKey);
      if (strip) el.appendChild(strip);

      paint(row);
      rows.set(item.key, row);
      list.appendChild(el);
    }

    toolSection.append(toolLabel, toolNote, list);

    // ---- 运行环境
    const envSection = document.createElement("section");

    const envLabel = document.createElement("h3");
    envLabel.className = "section-label";
    envLabel.textContent = "运行环境";

    const envStack = document.createElement("div");
    envStack.setAttribute("style", ROW_STACK);

    const rt = input.runtime;
    const dependent = input.status.items
      .filter((t) => t.needsDotnet)
      .map((t) => t.label)
      .join(" 与 ");

    const box = document.createElement("div");
    box.className = rt.dotnetAvailable ? "env-box" : "env-box is-warn";

    const envHead = document.createElement("div");
    envHead.className = "env-head";

    const envDot = document.createElement("span");
    envDot.className = rt.dotnetAvailable ? "status-dot" : "status-dot is-bad";

    const envName = document.createElement("span");
    envName.className = "env-name";
    envName.textContent = ".NET Framework";

    const envValue = document.createElement("span");
    envValue.className = "env-value";
    envValue.textContent = rt.dotnetDisplay;

    const envNote = document.createElement("p");
    envNote.className = "env-note";
    envNote.textContent = rt.dotnetAvailable
      ? `${dependent} 属于 .NET Framework 程序，当前环境可直接运行。Inno Setup 为原生程序，不依赖该运行时。`
      : `未检测到 .NET Framework 4.x。${dependent} 将无法启动，合并与加密阶段会失败；Inno Setup 为原生程序，不受影响。可安装 .NET Framework 4.8，或改为指向其它替代工具的路径。`;

    envHead.append(envDot, envName, envValue);
    box.append(envHead, envNote);
    envStack.appendChild(box);

    const cacheNote = document.createElement("p");
    cacheNote.className = "section-note";
    cacheNote.textContent = `下载的工具会安装到 ${input.status.downloadDir}，与随应用分发的内置工具分开存放。`;

    envSection.append(envLabel, envStack, cacheNote);

    content.append(toolSection, envSection);

    // ---- footer（Windows 惯例：主操作在左、取消在右）
    const footer = document.createElement("div");
    footer.className = "field-row";

    const save = document.createElement("button");
    save.className = "btn btn-primary";
    save.textContent = "保存";

    const cancel = document.createElement("button");
    cancel.className = "btn btn-quiet";
    cancel.textContent = "取消";

    cancel.onclick = () => {
      alive = false;
      close();
      resolve(null);
    };

    save.onclick = () => {
      alive = false;
      close();
      resolve(draft);
    };

    footer.append(save, cancel);
    close = openDialog({
      title: "设置",
      description: "工具路径为全局配置，对所有工程生效。",
      content,
      footer,
      size: "wide",
    });
  });
}
