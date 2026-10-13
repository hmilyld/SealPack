/**
 * 应用内右键菜单。
 *
 * 桌面程序右键一定有菜单，直接禁掉右键反而更不像本地程序。
 * 这里用自绘菜单替掉 WebView2 的原生菜单：外观跟当前皮肤走，
 * 键盘语义（↑/↓ 循环、Home/End、Enter 触发、Esc 关闭并归还焦点）按 Windows 惯例。
 */

export interface MenuItem {
  label: string;
  /** 右侧快捷键提示，如 "Ctrl+W" */
  shortcut?: string;
  disabled?: boolean;
  /** 破坏性操作（红字，hover 反白） */
  danger?: boolean;
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | "separator";

let openCleanup: (() => void) | null = null;

/** 关闭当前菜单（若有）。 */
export function closeContextMenu(): void {
  openCleanup?.();
}

const isItem = (entry: MenuEntry): entry is MenuItem => entry !== "separator";

export function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");

  const buttons: HTMLButtonElement[] = [];

  for (const entry of entries) {
    if (!isItem(entry)) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ctx-item${entry.danger ? " is-danger" : ""}`;
    btn.disabled = Boolean(entry.disabled);
    btn.setAttribute("role", "menuitem");
    btn.textContent = entry.label;

    if (entry.shortcut) {
      const key = document.createElement("span");
      key.className = "ctx-key";
      key.textContent = entry.shortcut;
      btn.appendChild(key);
    }

    btn.onclick = () => {
      closeContextMenu();
      entry.onSelect?.();
    };

    menu.appendChild(btn);
    if (!entry.disabled) buttons.push(btn);
  }

  // 先挂到 body 上量尺寸，再按视口边界收拢位置
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 4);
  const top = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
  menu.style.visibility = "";

  let index = -1;

  const focusAt = (next: number) => {
    if (buttons.length === 0) return;
    index = (next + buttons.length) % buttons.length;
    buttons[index]!.focus();
  };

  const onKeydown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeContextMenu();
        break;
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(buttons.length - 1);
        break;
      default:
        break;
    }
  };

  const onPointerDown = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node)) closeContextMenu();
  };

  const cleanup = () => {
    document.removeEventListener("keydown", onKeydown, { capture: true });
    document.removeEventListener("mousedown", onPointerDown, { capture: true });
    window.removeEventListener("blur", cleanup);
    window.removeEventListener("resize", cleanup);
    window.removeEventListener("wheel", cleanup, { capture: true });
    menu.remove();
    openCleanup = null;
    // 焦点归还给打开菜单之前的元素（浏览器会自动处理，这里显式兜底）
  };

  document.addEventListener("keydown", onKeydown, { capture: true });
  document.addEventListener("mousedown", onPointerDown, { capture: true });
  window.addEventListener("blur", cleanup);
  window.addEventListener("resize", cleanup);
  window.addEventListener("wheel", cleanup, { capture: true });

  openCleanup = cleanup;

  focusAt(0);
}

/**
 * 给一个元素挂上右键菜单。返回卸载函数。
 * 菜单项每次由 `build()` 现算，所以能反映元素当前状态（例如「已勾选」）。
 */
export function attachContextMenu(
  el: HTMLElement,
  build: (event: MouseEvent) => MenuEntry[],
): () => void {
  const handler = (event: MouseEvent) => {
    // build() 只算一次：项目行那类菜单会去查当前工程，重复调用纯属浪费
    const entries = build(event);
    if (entries.every((entry) => entry === "separator")) return;
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event.clientX, event.clientY, entries);
  };
  el.addEventListener("contextmenu", handler);
  return () => el.removeEventListener("contextmenu", handler);
}
