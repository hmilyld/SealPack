import { pickDirectory, pickExe } from "../api";
import { toast } from "./toast";

interface DialogOptions {
  title: string;
  description?: string;
  content: HTMLElement;
  footer: HTMLElement;
  /** 对话框宽度档位 */
  size?: "narrow" | "wide";
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 对话框外壳（设置面板也用同一套，保证皮肤一致）。
 *
 * 键盘语义按 Windows 惯例：
 *   - Esc / 点遮罩 → 触发「取消」，**一定会把调用方的 Promise 结算掉**；
 *   - Enter → 触发主按钮（焦点在文本框里时不抢）；
 *   - Tab → 焦点在对话框内循环，不会跑到背后的界面上；
 *   - 关闭后焦点归还给打开对话框之前的元素。
 */
export function openDialog(opts: DialogOptions): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.setAttribute("role", "presentation");

  const panel = document.createElement("div");
  panel.className = `dialog dialog-${opts.size ?? "narrow"}`;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", opts.title);

  const header = document.createElement("div");
  header.className = "dialog-head";

  const h = document.createElement("h2");
  h.textContent = opts.title;
  header.appendChild(h);

  if (opts.description) {
    const p = document.createElement("p");
    p.className = "dialog-desc";
    p.textContent = opts.description;
    header.appendChild(p);
  }

  const body = document.createElement("div");
  body.className = "dialog-body";
  body.appendChild(opts.content);

  const footer = document.createElement("div");
  footer.className = "dialog-foot";
  footer.appendChild(opts.footer);

  panel.append(header, body, footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Windows 惯例：主操作在左、取消在右。footer 里的按钮由调用方按「主、次」顺序传入。
  const primary = footer.querySelector<HTMLButtonElement>(".btn-primary, .btn-danger");
  const cancel = footer.querySelector<HTMLButtonElement>(".btn-quiet");

  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown, { capture: true });
    overlay.remove();
    // 焦点归还，键盘用户不会「丢失位置」
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };

  const dismiss = () => {
    // 关键：取消走按钮点击，保证调用方的 Promise 一定被结算，不会悬挂
    if (cancel) cancel.click();
    else close();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }

    if (event.key === "Enter") {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      // 多行文本框里回车是换行；按钮上的回车交给按钮自己处理（避免触发两次）
      if (tag === "TEXTAREA" || tag === "BUTTON") return;
      if (!primary) return;
      event.preventDefault();
      primary.click();
      return;
    }

    if (event.key === "Tab") {
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (!active || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) dismiss();
  });
  document.addEventListener("keydown", onKeydown, { capture: true });

  return close;
}

export function confirmDialog(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const content = document.createElement("p");
    content.className = "dialog-text";
    content.textContent = message;

    const footer = document.createElement("div");
    footer.className = "field-row";

    // 主操作在左、取消在右（Windows 惯例）
    const ok = document.createElement("button");
    ok.className = danger ? "btn btn-danger" : "btn btn-primary";
    ok.textContent = danger ? "删除" : "确定";

    const cancel = document.createElement("button");
    cancel.className = "btn btn-quiet";
    cancel.textContent = "取消";

    let close = () => {};
    cancel.onclick = () => {
      close();
      resolve(false);
    };
    ok.onclick = () => {
      close();
      resolve(true);
    };

    footer.append(ok, cancel);
    close = openDialog({ title, content, footer, size: "narrow" });
    ok.focus();
  });
}

export interface PromptOptions {
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  value?: string;
  /** 返回错误文案表示不通过；返回 null 表示通过 */
  validate?: (value: string) => string | null;
}

/**
 * 单行输入对话框。
 *
 * 之所以需要它：打包排除项支持 Inno 的通配符（`*.pdb`、`docs\*`），
 * 这种「没有文件可选、只能手打」的输入必须有一个正经的入口，
 * 而不是让用户去改 .iss 模板 —— 那正是这次改版要消灭的做法。
 */
/** 对话框内控件的 id 序号：`for`/`id` 关联需要唯一值。 */
let fieldSeq = 0;

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const form = document.createElement("div");
    form.className = "dialog-stack";

    const wrap = document.createElement("div");
    wrap.className = "field";

    const inputId = `prompt-field-${(fieldSeq += 1)}`;

    const label = document.createElement("label");
    label.className = "field-label";
    label.htmlFor = inputId;
    label.textContent = opts.label;

    const input = document.createElement("input");
    input.className = "input";
    input.id = inputId;
    input.spellcheck = false;
    input.placeholder = opts.placeholder ?? "";
    input.value = opts.value ?? "";

    const state = document.createElement("p");
    state.className = "field-state";

    wrap.append(label, input, state);
    form.appendChild(wrap);

    const footer = document.createElement("div");
    footer.className = "field-row";

    const ok = document.createElement("button");
    ok.className = "btn btn-primary";
    ok.textContent = "添加";

    const cancel = document.createElement("button");
    cancel.className = "btn btn-quiet";
    cancel.textContent = "取消";
    footer.append(ok, cancel);

    let close = () => {};
    const submit = () => {
      const value = input.value.trim();
      if (!value) {
        state.textContent = "不能为空";
        input.focus();
        return;
      }
      const problem = opts.validate?.(value) ?? null;
      if (problem) {
        state.textContent = problem;
        input.focus();
        return;
      }
      close();
      resolve(value);
    };

    cancel.onclick = () => {
      close();
      resolve(null);
    };
    ok.onclick = submit;
    input.oninput = () => {
      state.textContent = "";
    };

    close = openDialog({
      title: opts.title,
      description: opts.description,
      content: form,
      footer,
      size: "narrow",
    });

    input.focus();
    input.select();
  });
}

export interface NewProjectInput {
  name: string;
  exeFile: string;
  outputDir: string;
}

/** 一个字段的可变部件：输入框 + 就地校验提示（可选带「浏览」按钮）。 */
interface FieldHandle {
  input: HTMLInputElement;
  /** 就地显示校验错误，而不是飘一条与出错字段无关的 toast */
  state: HTMLParagraphElement;
}

export function newProjectDialog(): Promise<NewProjectInput | null> {
  return new Promise((resolve) => {
    const form = document.createElement("div");
    form.className = "dialog-stack";

    /**
     * `browse` 只在真的能「浏览」的字段上传 true。
     * 早先三个字段都无条件画了浏览按钮，而「工程名称」没有对应的 onclick，
     * 于是那个按钮点了完全没反应 —— 看起来像坏了，其实是死按钮。
     *
     * 用重载而不是可选属性：传了 true 就一定能拿到 button，调用处不必再判空。
     */
    function makeField(label: string, placeholder: string): FieldHandle;
    function makeField(
      label: string,
      placeholder: string,
      browse: true,
    ): FieldHandle & { browse: HTMLButtonElement };
    function makeField(
      label: string,
      placeholder: string,
      browse = false,
    ): FieldHandle & { browse?: HTMLButtonElement } {
      const wrap = document.createElement("div");
      wrap.className = "field";

      const inputId = `new-project-field-${(fieldSeq += 1)}`;

      const l = document.createElement("label");
      l.className = "field-label";
      l.htmlFor = inputId;
      l.textContent = label;

      const row = document.createElement("div");
      row.className = "field-row";

      const input = document.createElement("input");
      input.className = "input";
      input.id = inputId;
      input.placeholder = placeholder;
      input.spellcheck = false;

      const state = document.createElement("p");
      state.className = "field-state";

      row.appendChild(input);

      if (!browse) {
        wrap.append(l, row, state);
        form.appendChild(wrap);
        return { input, state };
      }

      const btn = document.createElement("button");
      btn.className = "btn btn-quiet btn-sm";
      btn.type = "button";
      btn.textContent = "浏览";

      row.appendChild(btn);
      wrap.append(l, row, state);
      form.appendChild(wrap);
      return { input, state, browse: btn };
    }

    const nameField = makeField("工程名称", "例如 我的工具");
    const exeField = makeField("主程序文件", "选择编译输出的 .exe", true);
    const outField = makeField("安装包输出目录", "选择安装包生成位置", true);

    exeField.browse.onclick = async () => {
      try {
        const picked = await pickExe();
        if (!picked) return;
        exeField.input.value = picked;
        exeField.state.textContent = "";
        if (!nameField.input.value.trim()) {
          const stem = picked.replace(/\\/g, "/").split("/").pop()?.replace(/\.exe$/i, "") ?? "";
          nameField.input.value = stem;
        }
      } catch (err) {
        // 早期这里不 catch，底层报错会变成 unhandled rejection，
        // 用户看到的现象就是「点了没反应」。宁可报错，也不要静默失败。
        toast(String(err instanceof Error ? err.message : err), "error");
      }
    };

    outField.browse.onclick = async () => {
      try {
        const picked = await pickDirectory("选择安装包输出目录");
        if (picked) {
          outField.input.value = picked;
          outField.state.textContent = "";
        }
      } catch (err) {
        toast(String(err instanceof Error ? err.message : err), "error");
      }
    };

    const footer = document.createElement("div");
    footer.className = "field-row";

    const create = document.createElement("button");
    create.className = "btn btn-primary";
    create.textContent = "创建工程";

    const cancel = document.createElement("button");
    cancel.className = "btn btn-quiet";
    cancel.textContent = "取消";
    footer.append(create, cancel);

    const fields: [FieldHandle, string][] = [
      [nameField, "请填写工程名称"],
      [exeField, "请选择主程序文件"],
      [outField, "请选择安装包输出目录"],
    ];

    for (const [field] of fields) {
      field.input.oninput = () => {
        field.state.textContent = "";
      };
    }

    let close = () => {};
    const submit = () => {
      const problems = fields.filter(([field]) => !field.input.value.trim());
      for (const [field] of fields) field.state.textContent = "";

      if (problems.length > 0) {
        for (const [field, message] of problems) field.state.textContent = message;
        problems[0]![0].input.focus();
        return;
      }

      close();
      resolve({
        name: nameField.input.value.trim(),
        exeFile: exeField.input.value.trim(),
        outputDir: outField.input.value.trim(),
      });
    };

    cancel.onclick = () => {
      close();
      resolve(null);
    };
    create.onclick = submit;

    // 回车提交由 openDialog 的 Enter→主按钮 统一处理，这里不再单独监听
    close = openDialog({
      title: "新建工程",
      description: "配置主程序与输出位置，合并、加密、打包都基于该工程执行。",
      content: form,
      footer,
      size: "narrow",
    });

    nameField.input.focus();
  });
}
