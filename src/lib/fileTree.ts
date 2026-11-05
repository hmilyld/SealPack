import type { FileNode } from "@/types";

export type RowState = "on" | "off" | "mixed";
export type LockReason = "always" | "auto" | "rule";

export interface LockInfo {
  state: "on" | "off";
  reason: LockReason;
}

export interface FlatRow {
  node: FileNode;
  depth: number;
  state: RowState;
  locked?: LockInfo;
  toggleable: boolean;
  /** 该行会影响的文件路径（目录为整棵子树的未锁定文件） */
  files: string[];
  fileCount: number;
  bytes: number;
  status: string;
  /** 搜索命中（用于高亮） */
  matched: boolean;
}

export interface TreeStats {
  total: number;
  visible: number;
  checked: number;
  totalBytes: number;
  checkedBytes: number;
}

export type OnlyFilter = "all" | "checked" | "unchecked";

export interface FlattenOptions {
  mode: "merge" | "pack";
  checked: Set<string>;
  locked?: Map<string, LockInfo>;
  /** 不在树里展示的路径（合并页隐藏主程序本身） */
  hidden?: Set<string>;
  collapsed: Set<string>;
  search: string;
  extensions: string[];
  only: OnlyFilter;
}

interface Aggregate {
  state: RowState;
  files: string[];
  fileCount: number;
  bytes: number;
}

function fileState(path: string, options: FlattenOptions): RowState {
  const locked = options.locked?.get(path);
  if (locked) return locked.state;
  return options.checked.has(path) ? "on" : "off";
}

function aggregate(node: FileNode, options: FlattenOptions): Aggregate {
  if (options.hidden?.has(node.path)) {
    return { state: "off", files: [], fileCount: 0, bytes: 0 };
  }
  if (!node.isDir) {
    const state = fileState(node.path, options);
    return { state, files: [node.path], fileCount: 1, bytes: node.size ?? 0 };
  }

  let anyOn = false;
  let anyOff = false;
  let anyMixed = false;
  const files: string[] = [];
  let fileCount = 0;
  let bytes = 0;

  for (const child of node.children) {
    const childAgg = aggregate(child, options);
    files.push(...childAgg.files);
    fileCount += childAgg.fileCount;
    bytes += childAgg.bytes;
    if (childAgg.state === "on") anyOn = true;
    else if (childAgg.state === "off") anyOff = true;
    else anyMixed = true;
  }

  const state: RowState =
    anyMixed || (anyOn && anyOff) ? "mixed" : anyOn ? "on" : "off";

  return { state, files, fileCount, bytes };
}

function termsOf(search: string): string[] {
  return search.toLowerCase().split(/\s+/).filter(Boolean);
}

function extOk(node: FileNode, extensions: string[]): boolean {
  if (extensions.length === 0) return true;
  const lower = node.name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(`.${ext.replace(/^\./, "").toLowerCase()}`));
}

function wordOk(node: FileNode, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = `${node.name} ${node.path}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

function statusOf(
  node: FileNode,
  state: RowState,
  locked: LockInfo | undefined,
  mode: "merge" | "pack",
): string {
  if (mode === "merge") {
    if (node.isDir) return state === "on" ? "已选" : state === "mixed" ? "部分" : "未选";
    return state === "on" ? "已选" : "未选";
  }

  if (locked?.reason === "always") return "始终打包";
  if (locked?.reason === "auto") return "自动排除";
  if (locked?.reason === "rule") return "规则排除";
  if (node.isDir) return state === "on" ? "打包" : state === "mixed" ? "部分" : "已排除";
  return state === "on" ? "打包" : "已排除";
}

export function flattenTree(nodes: FileNode[], options: FlattenOptions): FlatRow[] {
  const terms = termsOf(options.search);
  const searching = terms.length > 0;
  const filtering = searching || options.only !== "all" || options.extensions.length > 0;
  const rows: FlatRow[] = [];

  const dirNameHit = (node: FileNode): boolean =>
    node.isDir && searching && terms.every((term) => node.name.toLowerCase().includes(term));

  const visible = (node: FileNode, parentHit: boolean): boolean => {
    if (options.hidden?.has(node.path)) return false;
    if (node.isDir) {
      if (dirNameHit(node)) return true;
      return node.children.some((child) => visible(child, parentHit || dirNameHit(node)));
    }
    if (!extOk(node, options.extensions)) return false;
    const agg = aggregate(node, options);
    if (options.only === "checked" && agg.state !== "on") return false;
    if (options.only === "unchecked" && agg.state !== "off") return false;
    return parentHit || wordOk(node, terms);
  };

  const walk = (list: FileNode[], depth: number, parentHit: boolean): void => {
    for (const node of list) {
      if (options.hidden?.has(node.path)) continue;
      const hit = parentHit || dirNameHit(node);
      if (!visible(node, parentHit)) continue;

      const agg = aggregate(node, options);
      const locked = options.locked?.get(node.path);
      const state = locked?.state ?? agg.state;
      const collapsed = options.collapsed.has(node.path) && !filtering;

      rows.push({
        node,
        depth,
        state,
        locked,
        toggleable: node.isDir ? agg.files.length > 0 : !locked,
        files: agg.files,
        fileCount: agg.fileCount,
        bytes: agg.bytes,
        status: statusOf(node, state, locked, options.mode),
        matched: !node.isDir && wordOk(node, terms),
      });

      if (node.isDir && !collapsed) {
        walk(node.children, depth + 1, hit);
      }
    }
  };

  walk(nodes, 0, false);
  return rows;
}

/** 统计整棵树里处于「已选/打包」状态的文件，不受折叠与筛选影响。 */
export function checkedStats(
  node: FileNode,
  checked: Set<string>,
  locked?: Map<string, LockInfo>,
  hidden?: Set<string>,
): { count: number; bytes: number } {
  if (hidden?.has(node.path)) return { count: 0, bytes: 0 };
  if (!node.isDir) {
    const lock = locked?.get(node.path);
    const state = lock ? lock.state : checked.has(node.path) ? "on" : "off";
    return state === "on"
      ? { count: 1, bytes: node.size ?? 0 }
      : { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const child of node.children) {
    const childStats = checkedStats(child, checked, locked, hidden);
    count += childStats.count;
    bytes += childStats.bytes;
  }
  return { count, bytes };
}

export function treeStats(
  rows: FlatRow[],
  totals: { files: number; bytes: number },
  checkedTotals?: { count: number; bytes: number },
): TreeStats {
  let checked = 0;
  let checkedBytes = 0;
  let visible = 0;

  for (const row of rows) {
    if (row.node.isDir) continue;
    visible += 1;
    if (!checkedTotals && row.state === "on") {
      checked += 1;
      checkedBytes += row.node.size ?? 0;
    }
  }

  if (checkedTotals) {
    checked = checkedTotals.count;
    checkedBytes = checkedTotals.bytes;
  }

  return {
    total: totals.files,
    visible,
    checked,
    totalBytes: totals.bytes,
    checkedBytes,
  };
}

/** 从扫描结果里收集出现过的扩展名，按出现次数降序。 */
export function collectExtensions(
  node: FileNode,
  hidden?: Set<string>,
  limit = 12,
): { ext: string; count: number }[] {
  const counts = new Map<string, number>();
  const walk = (n: FileNode) => {
    if (hidden?.has(n.path)) return;
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

/** 递归统计整棵树的文件数与字节数；hidden 里的路径不计入。 */
export function totalStats(
  node: FileNode,
  hidden?: Set<string>,
): { files: number; bytes: number } {
  if (hidden?.has(node.path)) return { files: 0, bytes: 0 };
  if (!node.isDir) return { files: 1, bytes: node.size ?? 0 };
  let files = 0;
  let bytes = 0;
  for (const child of node.children) {
    const childStats = totalStats(child, hidden);
    files += childStats.files;
    bytes += childStats.bytes;
  }
  return { files, bytes };
}
