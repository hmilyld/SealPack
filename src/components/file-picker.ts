import { collectExtensions, createFileTree, type FileTreeHandle } from "./file-tree";
import type { FileNode } from "../types";
import { esc } from "../util";

/**
 * 文件选择器 = 文件树 + 一层「找人」的工具。
 *
 * 单独抽出来而不是把工具栏塞进 file-tree：树本身只管结构与勾选，
 * 「怎么快速找到目标」是另一件事，两者职责分开更好维护。
 *
 * 给用户的三条找文件路径，覆盖不同的心理模型：
 *   1. 我知道大概在哪 → 直接展开目录看（树默认不过滤，结构完整）；
 *   2. 我知道类型     → 点类型 chip 收敛（如只看 dll）；
 *   3. 我知道名字     → 搜索框，命中高亮、祖先自动展开。
 * 勾完之后再用「只看已选」复核一遍，避免漏选 / 多选。
 */

export interface FilePickerHandle {
  el: HTMLElement;
  getSelected(): string[];
  setSelected(paths: string[]): void;
  /** 全选 / 全不选（右键菜单与底栏共用） */
  setAll(checked: boolean): void;
  /** 把当前筛选后可见的文件全部勾上 */
  pickVisible(): void;
  /** 清空搜索条件与已选 */
  clear(): void;
  /** 重新扫描后替换数据 */
  reload(node: FileNode): void;
  focus(): void;
  /** 切换某路径勾选：文件切自己，目录切整棵子树 */
  togglePath(path: string): void;
}

const ICON_SEARCH = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3 3" stroke-linecap="round"/></svg>`;

export function createFilePicker(opts: {
  nodes: FileNode;
  selected: string[];
  onChange: (paths: string[]) => void;
}): FilePickerHandle {
  let selected = [...opts.selected];
  let nodes = opts.nodes;
  let extensions: string[] = [];
  let search = "";
  let onlySelected = false;
  let tree: FileTreeHandle | null = null;

  const el = document.createElement("div");
  el.className = "picker";

  const bar = document.createElement("div");
  bar.className = "picker-bar";

  const searchWrap = document.createElement("div");
  searchWrap.className = "picker-search";
  const searchIcon = document.createElement("span");
  searchIcon.className = "picker-search-icon";
  searchIcon.innerHTML = ICON_SEARCH;
  const searchInput = document.createElement("input");
  searchInput.className = "picker-search-input";
  searchInput.type = "search";
  searchInput.spellcheck = false;
  searchInput.placeholder = "搜索文件名（空格分隔多个关键词）";
  searchWrap.append(searchIcon, searchInput);

  const extWrap = document.createElement("div");
  extWrap.className = "picker-exts";

  const tail = document.createElement("div");
  tail.className = "picker-tail";

  const onlyBtn = document.createElement("button");
  onlyBtn.type = "button";
  onlyBtn.className = "chip chip-toggle";
  onlyBtn.textContent = "只看已选";

  const pickVisibleBtn = document.createElement("button");
  pickVisibleBtn.type = "button";
  pickVisibleBtn.className = "btn btn-quiet btn-sm";
  pickVisibleBtn.textContent = "勾选当前结果";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "btn btn-quiet btn-sm";
  clearBtn.textContent = "清空";

  tail.append(onlyBtn, pickVisibleBtn, clearBtn);

  // 「已选清单」不放在左侧：合并页右栏就是选中文件清单（可筛选、可移除），
  // 左侧只负责「找文件、勾文件」，不再重复展示一遍。
  const treeHost = document.createElement("div");
  treeHost.className = "picker-tree";

  const foot = document.createElement("div");
  foot.className = "picker-foot";

  bar.append(searchWrap, extWrap, tail);
  el.append(bar, treeHost, foot);

  // ---------------------------------------------------------------- 工具

  const renderExtChips = () => {
    const found = collectExtensions(nodes, 8);
    extWrap.innerHTML = "";
    if (found.length === 0) return;

    const label = document.createElement("span");
    label.className = "picker-exts-label";
    label.textContent = "类型";
    extWrap.appendChild(label);

    for (const { ext, count } of found) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip chip-ext";
      chip.classList.toggle("is-active", extensions.includes(ext));
      chip.title = `只显示 .${ext} 文件（共 ${count} 个）`;
      chip.innerHTML = `<span class="chip-ext-name">.${esc(ext)}</span><span class="chip-ext-count">${count}</span>`;
      chip.onclick = () => {
        extensions = extensions.includes(ext)
          ? extensions.filter((e) => e !== ext)
          : [...extensions, ext];
        renderExtChips();
        apply();
      };
      extWrap.appendChild(chip);
    }
  };

  const renderFoot = () => {
    const stats = tree?.stats() ?? { selected: 0, total: 0, visible: 0 };
    // 「已选 N 项」不再出现在底栏：右栏就是已选清单，计数归它管。
    const parts = [`共 ${stats.total} 个文件`];
    if (stats.visible !== stats.total) parts.push(`当前显示 ${stats.visible} 个`);
    foot.innerHTML = `<span class="picker-foot-text">${parts.join(" · ")}</span>`;

    const all = document.createElement("button");
    all.type = "button";
    all.className = "btn btn-quiet btn-xs";
    all.textContent = "全选";
    all.onclick = () => tree?.setAll(true);

    const none = document.createElement("button");
    none.type = "button";
    none.className = "btn btn-quiet btn-xs";
    none.textContent = "全不选";
    none.onclick = () => tree?.setAll(false);

    const spacer = document.createElement("span");
    spacer.className = "spacer";
    foot.append(spacer, all, none);
  };

  const emit = () => opts.onChange([...selected]);

  const apply = () => {
    tree?.setFilter({ search, extensions, onlySelected });
    onlyBtn.classList.toggle("is-active", onlySelected);
    onlyBtn.setAttribute("aria-pressed", String(onlySelected));
    renderFoot();
  };

  const mountTree = () => {
    treeHost.innerHTML = "";
    const built = createFileTree({
      nodes: nodes.children,
      selected,
      // 合并页：文件树默认收起，结构一目了然
      defaultCollapsed: true,
      onChange: (paths) => {
        selected = paths;
        renderFoot();
        emit();
      },
      // 折叠 / 展开 / 筛选只改变「看得见几个」，不改变勾选，
      // 所以不落盘，但底栏那行「当前显示 N 个」必须跟着刷新。
      onView: renderFoot,
    });
    tree = built;
    treeHost.appendChild(built.el);
    apply();
  };

  // ---------------------------------------------------------------- 交互

  searchInput.oninput = () => {
    search = searchInput.value.trim();
    apply();
  };

  onlyBtn.onclick = () => {
    onlySelected = !onlySelected;
    apply();
  };

  const pickVisible = () => {
    // 「勾选当前结果」：把筛选后可见的文件全部勾上 —— 取代原来那个要手输扩展名的
    // 「按扩展名勾选」，因为类型 chip + 搜索已经表达了「当前结果」。
    const visible = [
      ...treeHost.querySelectorAll<HTMLLIElement>("li:not(.dir):not(.is-hidden)"),
    ];
    if (visible.length === 0) return;
    const next = new Set(selected);
    for (const li of visible) {
      const path = li.dataset.path;
      if (path) next.add(path);
    }
    selected = [...next];
    tree?.setSelected(selected);
    emit();
  };

  pickVisibleBtn.onclick = () => pickVisible();

  const clear = () => {
    searchInput.value = "";
    search = "";
    extensions = [];
    onlySelected = false;
    renderExtChips();
    tree?.setAll(false);
    emit();
  };

  clearBtn.onclick = () => clear();

  renderExtChips();
  mountTree();

  return {
    el,
    getSelected: () => [...selected],
    setSelected(paths) {
      selected = [...paths];
      tree?.setSelected(selected);
      renderFoot();
    },
    setAll(checked) {
      tree?.setAll(checked);
    },
    togglePath(path) {
      tree?.togglePath(path);
    },
    pickVisible,
    clear,
    reload(node) {
      nodes = node;
      renderExtChips();
      mountTree();
    },
    focus() {
      tree?.focus();
    },
  };
}
