import type { FileNode } from "../types";

/**
 * 文件树。
 *
 * 改造前的三个痛点，以及这里的对策：
 *
 * 1. **看不清结构** —— 之前默认按 `dll` 过滤，没有 dll 的目录整个消失，
 *    用户不知道自己身在何处。现在默认**不过滤**，显示完整目录；
 *    扩展名是可选条件（chip 点选），不是默认行为。
 * 2. **容易点错** —— 之前整行点击即勾选，想展开目录结果勾了一片。
 *    现在把一行拆成三个互不干扰的点击区：
 *      · 展开箭头 → 展开/折叠
 *      · 勾选框   → 勾选/取消（目录含子级）
 *      · 名称     → 只把焦点移过去，**不改任何勾选状态**
 *    双击名称才等同于「激活」（目录展开、文件勾选），符合资源管理器习惯。
 * 3. **找不到目标** —— 新增搜索：命中的行高亮、祖先自动展开，且搜索前后
 *    会记住/恢复用户手工折叠的状态，不会把用户整理的视图冲掉。
 *
 * 勾选框仍不用原生 `<input type="checkbox">`：两套设计对它的呈现完全不同
 * （网格是实心方块，终端是 `[x]/[ ]/[/]`），由 CSS 伪元素绘制，状态以类名表达。
 *
 * 键盘用「游走焦点」（roving tabindex）：整个树只占一个 Tab 停靠点，
 * ↑/↓ 移动、→ 展开/进子级、← 折叠/回父级、Home/End 首尾、Space/Enter 勾选。
 */

type NodeState = "off" | "on" | "partial";

export interface TreeFilter {
  /** 按文件名搜索（不区分大小写，空格分词，全部命中才算） */
  search?: string;
  /** 只保留这些扩展名；空数组 = 不过滤 */
  extensions?: string[];
  /** 只看已勾选的文件 */
  onlySelected?: boolean;
}

export interface TreeStats {
  /** 已勾选的文件数 */
  selected: number;
  /** 树里文件总数（不含目录） */
  total: number;
  /** 当前筛选后可见的文件数 */
  visible: number;
}

export interface FileTreeHandle {
  el: HTMLElement;
  setSelected(paths: string[]): void;
  setAll(checked: boolean): void;
  setFilter(filter: TreeFilter): void;
  stats(): TreeStats;
  /** 让树获得键盘焦点（右键菜单等操作后调用） */
  focus(): void;
  /** 切换某个路径的勾选：文件只切自己，目录切换整棵子树 */
  togglePath(path: string): void;
}

interface Entry {
  node: FileNode;
  el: HTMLLIElement;
  arrow: HTMLSpanElement;
  box: HTMLSpanElement;
  name: HTMLSpanElement;
  children: Entry[];
  parent: Entry | null;
  state: NodeState;
  /** 用户手工折叠状态（搜索前快照，搜索清空后恢复） */
  collapsed: boolean;
}

const ICON_ARROW = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.2 1.4 7 5l-3.8 3.6z" fill="currentColor"/></svg>`;

export function createFileTree(opts: {
  nodes: FileNode[];
  selected: string[];
  onChange: (paths: string[]) => void;
  /**
   * 目录是否默认折叠。合并页希望一进来是收起的（结构一目了然、不抢视线），
   * 由调用方决定；搜索 / 只看已选时仍会自动展开命中目录。
   */
  defaultCollapsed?: boolean;
  /**
   * 视图变化（折叠 / 展开 / 筛选）时回调。
   *
   * 与 `onChange` 分开：勾选变化要落盘，折叠变化只是「看得见几个」变了，
   * 不该触发保存。但底栏的「当前显示 N 个」必须跟着刷新，
   * 否则折叠一个目录之后那行数字还是旧的。
   */
  onView?: () => void;
}): FileTreeHandle {
  const selected = new Set(opts.selected);
  const entries: Entry[] = [];
  const byPath = new Map<string, Entry>();
  let filter: TreeFilter = {};
  /** 搜索开始前的折叠状态，搜索清空后恢复 */
  let collapseSnapshot: Set<string> | null = null;

  const el = document.createElement("div");
  el.className = "tree";

  const root = document.createElement("ul");
  root.setAttribute("role", "tree");
  root.setAttribute("aria-multiselectable", "true");

  const paint = (entry: Entry) => {
    entry.el.classList.toggle("is-checked", entry.state === "on");
    entry.el.classList.toggle("is-partial", entry.state === "partial");
    entry.el.classList.toggle("is-collapsed", entry.collapsed);
    if (entry.node.isDir) {
      entry.el.setAttribute("aria-expanded", String(!entry.collapsed));
    } else {
      entry.el.setAttribute("aria-checked", String(entry.state === "on"));
    }
  };

  const build = (node: FileNode, host: HTMLUListElement, parent: Entry | null): Entry => {
    const li = document.createElement("li");
    li.dataset.path = node.path;
    li.tabIndex = -1;
    li.setAttribute("role", "treeitem");
    li.title = node.path;
    if (node.isDir) li.classList.add("dir");

    // 三个互不干扰的点击区
    const arrow = document.createElement("span");
    arrow.className = "tree-tw";
    arrow.innerHTML = ICON_ARROW;

    const box = document.createElement("span");
    box.className = "tree-cb";
    box.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "tree-nm";
    name.textContent = node.name;

    li.append(arrow, box, name);

    const entry: Entry = {
      node,
      el: li,
      arrow,
      box,
      name,
      children: [],
      parent,
      state: node.isDir ? "off" : selected.has(node.path) ? "on" : "off",
      // 默认折叠：只有目录参与，文件无所谓折叠
      collapsed: Boolean(opts.defaultCollapsed) && node.isDir,
    };
    byPath.set(node.path, entry);

    if (node.isDir) {
      const list = document.createElement("ul");
      list.setAttribute("role", "group");
      for (const child of node.children) entry.children.push(build(child, list, entry));
      li.appendChild(list);
    }

    paint(entry);
    host.appendChild(li);
    return entry;
  };

  for (const node of opts.nodes) entries.push(build(node, root, null));
  el.appendChild(root);

  // ---- 可见行（折叠的目录不算）
  const visibleRows = (): Entry[] => {
    const out: Entry[] = [];
    const walk = (list: Entry[]) => {
      for (const entry of list) {
        if (entry.el.classList.contains("is-hidden")) continue;
        out.push(entry);
        if (entry.node.isDir && !entry.collapsed) walk(entry.children);
      }
    };
    walk(entries);
    return out;
  };

  let focused: Entry | null = null;

  const setFocused = (entry: Entry | null) => {
    if (focused && focused !== entry) focused.el.tabIndex = -1;
    focused = entry;
    if (entry) {
      entry.el.tabIndex = 0;
      entry.el.focus();
    }
  };

  if (entries[0]) {
    focused = entries[0];
    entries[0].el.tabIndex = 0;
  }

  // ---- 勾选状态
  const setSubtree = (entry: Entry, on: boolean) => {
    entry.state = on ? "on" : "off";
    paint(entry);
    entry.children.forEach((c) => setSubtree(c, on));
  };

  const syncUp = (entry: Entry) => {
    if (!entry.node.isDir || entry.children.length === 0) return;
    entry.children.forEach(syncUp);

    const states = entry.children.map((c) => c.state);
    entry.state = states.every((s) => s === "on")
      ? "on"
      : states.every((s) => s === "off")
        ? "off"
        : "partial";
    paint(entry);
  };

  const collect = (): string[] => {
    const out: string[] = [];
    for (const entry of byPath.values()) {
      if (!entry.node.isDir && entry.state === "on") out.push(entry.node.path);
    }
    return out;
  };

  const emit = () => opts.onChange(collect());

  const syncAll = () => {
    entries.forEach(syncUp);
    applyFilter();
    emit();
  };

  // ---- 视图变更通知
  //
  // 折叠一棵大树会连续改动几十个节点，逐个通知会让底栏重建几十次。
  // 所以用「计数 + 脏标记」把它压成一次：批内只记 dirty，最外层结束时补发一次。
  let viewDepth = 0;
  let viewDirty = false;

  const notifyView = () => {
    if (viewDepth > 0) {
      viewDirty = true;
      return;
    }
    opts.onView?.();
  };

  const withViewBatch = (fn: () => void) => {
    viewDepth += 1;
    try {
      fn();
    } finally {
      viewDepth -= 1;
      if (viewDepth === 0 && viewDirty) {
        viewDirty = false;
        opts.onView?.();
      }
    }
  };

  const setCollapsed = (entry: Entry, collapsed: boolean) => {
    // 状态没变就别通知：applyFilter 会把每个目录都走一遍，
    // 不加这层判断会凭空多出几十次无意义的底栏重建。
    if (entry.collapsed === collapsed) return;
    entry.collapsed = collapsed;
    paint(entry);
    notifyView();
  };

  const activate = (entry: Entry) => {
    if (entry.node.isDir) {
      setCollapsed(entry, !entry.collapsed);
      return;
    }
    setSubtree(entry, entry.state !== "on");
    syncAll();
  };

  // ---- 筛选

  const terms = () => (filter.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);

  const extOk = (entry: Entry): boolean => {
    const exts = filter.extensions ?? [];
    if (exts.length === 0) return true;
    const lower = entry.node.name.toLowerCase();
    return exts.some((e) => lower.endsWith(`.${e.replace(/^\./, "").toLowerCase()}`));
  };

  const wordOk = (entry: Entry): boolean => {
    const words = terms();
    if (words.length === 0) return true;
    const hay = entry.node.name.toLowerCase();
    return words.every((w) => hay.includes(w));
  };

  /** 目录名本身命中搜索词 → 整个子树都显示（搜「libs」能直接看到 libs 里的东西） */
  const dirNameHit = (entry: Entry): boolean =>
    entry.node.isDir && terms().length > 0 && wordOk(entry);

  const inNameHitDir = (entry: Entry): boolean => {
    for (let p = entry.parent; p; p = p.parent) if (dirNameHit(p)) return true;
    return false;
  };

  const isVisible = (entry: Entry): boolean => {
    if (filter.onlySelected) {
      if (!entry.node.isDir) return entry.state === "on";
      return entry.children.some(isVisible);
    }
    if (entry.node.isDir) {
      if (dirNameHit(entry)) return true;
      return entry.children.some(isVisible);
    }
    if (!extOk(entry)) return false;
    return inNameHitDir(entry) || wordOk(entry);
  };

  const applyFilter = () =>
    withViewBatch(() => {
      const searching = terms().length > 0;
      for (const entry of entries) {
        entry.el.classList.toggle("is-hidden", !isVisible(entry));
        entry.el.classList.toggle("is-hit", searching && !entry.node.isDir && wordOk(entry));
      }

      // 搜索 / 只看已选时自动展开有内容的目录；条件清空后恢复用户原来的折叠状态
      const autoExpand = searching || Boolean(filter.onlySelected);
      if (autoExpand) {
        if (!collapseSnapshot) {
          collapseSnapshot = new Set(entries.filter((e) => e.collapsed).map((e) => e.node.path));
        }
        for (const entry of entries) {
          if (entry.node.isDir && entry.children.some(isVisible)) setCollapsed(entry, false);
        }
      } else if (collapseSnapshot) {
        for (const entry of entries) setCollapsed(entry, collapseSnapshot.has(entry.node.path));
        collapseSnapshot = null;
      }
    });

  // ---- 键盘
  const move = (delta: number) => {
    const rows = visibleRows();
    const current = focused ? rows.indexOf(focused) : -1;
    if (current === -1) {
      setFocused(rows[0] ?? null);
      return;
    }
    const next = rows[current + delta];
    if (next) setFocused(next);
  };

  const onRowKeydown = (entry: Entry) => (event: KeyboardEvent) => {
    switch (event.key) {
      case " ":
        event.preventDefault();
        activate(entry);
        break;
      case "Enter":
        event.preventDefault();
        if (entry.node.isDir) setCollapsed(entry, !entry.collapsed);
        else {
          setSubtree(entry, entry.state !== "on");
          syncAll();
        }
        break;
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (!entry.node.isDir) break;
        if (entry.collapsed) setCollapsed(entry, false);
        else if (entry.children[0]) setFocused(entry.children[0]);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (entry.node.isDir && !entry.collapsed) setCollapsed(entry, true);
        else if (entry.parent) setFocused(entry.parent);
        break;
      case "Home": {
        event.preventDefault();
        const rows = visibleRows();
        if (rows[0]) setFocused(rows[0]);
        break;
      }
      case "End": {
        event.preventDefault();
        const rows = visibleRows();
        if (rows[rows.length - 1]) setFocused(rows[rows.length - 1]!);
        break;
      }
      default:
        break;
    }
  };

  for (const entry of byPath.values()) {
    // 展开箭头：只负责展开/折叠
    entry.arrow.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!entry.node.isDir) return;
      setFocused(entry);
      setCollapsed(entry, !entry.collapsed);
    });

    // 勾选框：只负责勾选
    entry.box.addEventListener("click", (event) => {
      event.stopPropagation();
      setFocused(entry);
      setSubtree(entry, entry.state !== "on");
      syncAll();
    });

    // 名称：只移动焦点，不改变任何勾选状态 —— 这是「点错」问题的根治
    entry.name.addEventListener("click", (event) => {
      event.stopPropagation();
      setFocused(entry);
    });
    entry.name.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      activate(entry);
    });

    entry.el.addEventListener("focus", () => {
      if (focused !== entry) {
        if (focused) focused.el.tabIndex = -1;
        focused = entry;
        entry.el.tabIndex = 0;
      }
    });
    entry.el.addEventListener("keydown", onRowKeydown(entry));
  }

  entries.forEach(syncUp);
  applyFilter();

  const stats = (): TreeStats => {
    let total = 0;
    // 注意用 byPath（全部节点）而不是 entries（只有顶层）：
    // 用 entries 会把子目录里的文件漏掉，底栏显示「共 8 个文件」而实际有 10 个。
    for (const entry of byPath.values()) {
      if (!entry.node.isDir) total += 1;
    }
    // 「当前显示」要连折叠一起算：折叠的目录里那些文件肉眼是看不到的，
    // is-hidden 只表达筛选，不表达折叠。
    const visibleCount = visibleRows().filter((entry) => !entry.node.isDir).length;
    return { selected: collect().length, total, visible: visibleCount };
  };

  return {
    el,
    setSelected(paths) {
      const next = new Set(paths);
      for (const entry of byPath.values()) {
        if (!entry.node.isDir) entry.state = next.has(entry.node.path) ? "on" : "off";
      }
      syncAll();
    },
    focus() {
      setFocused(focused ?? entries[0] ?? null);
    },
    togglePath(path) {
      const entry = byPath.get(path);
      if (entry) {
        setSubtree(entry, entry.state !== "on");
        syncAll();
        return;
      }
      // 路径不在树里（例如换过主程序目录之后遗留的合并项）：它本来就不会
      // 出现在 collect() 的结果里，但调用方需要一次 onChange 才能刷新视图 ——
      // 少了这一次通知，右栏的 × 点了就毫无反应。
      opts.onChange(collect());
    },
    setAll(checked) {
      entries.forEach((e) => setSubtree(e, checked));
      syncAll();
    },
    setFilter(next) {
      filter = next;
      applyFilter();
    },
    stats,
  };
}

/** 从扫描结果里收集出现过的扩展名，按出现次数降序 —— 用于生成扩展名 chip */
export function collectExtensions(node: FileNode, limit = 10): { ext: string; count: number }[] {
  const counts = new Map<string, number>();
  const walk = (n: FileNode) => {
    if (n.isDir) {
      n.children.forEach(walk);
      return;
    }
    const dot = n.name.lastIndexOf(".");
    if (dot <= 0) return;
    const ext = n.name.slice(dot + 1).toLowerCase();
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  };
  walk(node);
  return [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext))
    .slice(0, limit);
}
