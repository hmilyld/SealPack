import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ChevronDownRegular,
  ChevronRightRegular,
  ChevronUpRegular,
  CopyRegular,
  DocumentRegular,
  FolderOpenRegular,
  FolderRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import { useVirtualizer } from "@tanstack/react-virtual";

import { reveal } from "@/api";
import { useContextMenu } from "@/components/common/ContextMenu";
import { useToast } from "@/components/feedback/ToastProvider";
import { semantic } from "@/theme/semantic";
import type { FileNode } from "@/types";
import {
  checkedStats,
  collectExtensions,
  flattenTree,
  totalStats,
  treeStats,
  type FlatRow,
  type LockInfo,
  type OnlyFilter,
  type TreeStats,
} from "@/lib/fileTree";
import { formatBytes } from "@/lib/format";

// 与 src/styles/tokens.css 的 --app-row-h 保持一致（虚拟滚动需要数字）
const ROW_HEIGHT = 30;

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
  },
  toolbar: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
    padding: "var(--app-space-2) var(--app-space-3)",
    borderBottom: "1px solid var(--app-border-subtle)",
  },
  toolbarRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    flexWrap: "wrap",
  },
  search: {
    width: "260px",
    maxWidth: "100%",
  },
  spacer: {
    flex: 1,
  },
  chips: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-1)",
    flexWrap: "wrap",
  },
  chip: {
    minWidth: "auto",
    padding: "0 var(--app-space-2)",
    height: "var(--app-control-h-sm)",
    fontSize: "var(--app-font-small)",
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
  },
  inner: {
    position: "relative",
    width: "100%",
    minWidth: "640px",
  },
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    height: "var(--app-row-h)",
    paddingRight: "var(--app-space-3)",
    borderLeft: "2px solid transparent",
    color: tokens.colorNeutralForeground1,
    cursor: "default",
    ":hover": {
      background: tokens.colorNeutralBackground3Hover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  rowFocused: {
    borderLeftColor: tokens.colorBrandBackground,
    background: tokens.colorNeutralBackground3Selected,
  },
  chevron: {
    display: "grid",
    placeItems: "center",
    width: "var(--app-icon-box)",
    height: "24px",
    flexShrink: 0,
    border: "none",
    background: "transparent",
    color: tokens.colorNeutralForeground3,
    padding: 0,
    cursor: "default",
    ":hover": {
      color: tokens.colorNeutralForeground1,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  chevronSpacer: {
    width: "var(--app-icon-box)",
    flexShrink: 0,
  },
  checkbox: {
    flexShrink: 0,
  },
  icon: {
    display: "grid",
    placeItems: "center",
    width: "var(--app-icon-box)",
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  folderIcon: {
    color: semantic.folder,
  },
  name: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--app-font-body)",
  },
  nameDir: {
    fontWeight: 600,
  },
  size: {
    width: "76px",
    flexShrink: 0,
    textAlign: "right",
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  status: {
    width: "88px",
    flexShrink: 0,
    display: "flex",
    justifyContent: "flex-end",
  },
  mark: {
    background: semantic.highlight,
    color: tokens.colorNeutralForeground1,
    borderRadius: "var(--app-radius-sm)",
  },
  chipCount: {
    opacity: 0.65,
    marginLeft: "var(--app-space-1)",
  },
  truncated: {
    margin: "var(--app-space-2) var(--app-space-3) 0",
  },
  empty: {
    display: "grid",
    placeItems: "center",
    height: "160px",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-small)",
  },
  loading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--app-space-2)",
    height: "160px",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-small)",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-3)",
    padding: "var(--app-space-2) var(--app-space-3)",
    borderTop: "1px solid var(--app-border-subtle)",
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
  },
});

interface FileTreeProps {
  root: FileNode;
  mode: "merge" | "pack";
  checked: Set<string>;
  locked?: Map<string, LockInfo>;
  hidden?: Set<string>;
  loading?: boolean;
  onToggle: (paths: string[], checked: boolean) => void;
  onStats?: (stats: TreeStats) => void;
  emptyText?: string;
}

function allDirPaths(
  node: FileNode,
  hidden?: Set<string>,
  out: string[] = [],
): string[] {
  for (const child of node.children) {
    if (hidden?.has(child.path)) continue;
    if (child.isDir) {
      out.push(child.path);
      allDirPaths(child, hidden, out);
    }
  }
  return out;
}

function Highlight({ text, search }: { text: string; search: string }) {
  const styles = useStyles();
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return <>{text}</>;
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let index = 0;
    while (index < lower.length) {
      const found = lower.indexOf(term, index);
      if (found < 0) break;
      ranges.push([found, found + term.length]);
      index = found + term.length;
    }
  }
  if (ranges.length === 0) return <>{text}</>;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={index} className={styles.mark}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function FileTree({
  root,
  mode,
  checked,
  locked,
  hidden,
  loading,
  onToggle,
  onStats,
  emptyText,
}: FileTreeProps) {
  const styles = useStyles();
  const toast = useToast();
  const { openMenu } = useContextMenu();
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(allDirPaths(root, hidden)),
  );
  const [search, setSearch] = useState("");
  const [extensions, setExtensions] = useState<string[]>([]);
  const [only, setOnly] = useState<OnlyFilter>("all");
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  const extChips = useMemo(() => collectExtensions(root, hidden), [root, hidden]);
  const totals = useMemo(() => totalStats(root, hidden), [root, hidden]);

  const rows = useMemo(
    () =>
      flattenTree(root.children, {
        mode,
        checked,
        locked,
        hidden,
        collapsed,
        search,
        extensions,
        only,
      }),
    [root.children, mode, checked, locked, hidden, collapsed, search, extensions, only],
  );

  const checkedTotals = useMemo(
    () => checkedStats(root, checked, locked, hidden),
    [root, checked, locked, hidden],
  );
  const stats = useMemo(
    () => treeStats(rows, totals, checkedTotals),
    [rows, totals, checkedTotals],
  );

  useEffect(() => {
    onStatsRef.current?.(stats);
  }, [stats]);

  useEffect(() => {
    if (rows.length === 0) {
      setFocusedPath(null);
      return;
    }
    if (!focusedPath || !rows.some((row) => row.node.path === focusedPath)) {
      setFocusedPath(rows[0]!.node.path);
    }
  }, [rows, focusedPath]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const focusIndex = rows.findIndex((row) => row.node.path === focusedPath);
  useEffect(() => {
    if (focusIndex >= 0) virtualizer.scrollToIndex(focusIndex, { align: "auto" });
  }, [focusIndex, virtualizer]);

  const focusRow = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row) setFocusedPath(row.node.path);
  };

  const toggleCollapse = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleRow = (row: FlatRow) => {
    if (!row.toggleable) return;
    onToggle(row.files, row.state !== "on");
  };

  const onRowKeyDown = (event: ReactKeyboardEvent, row: FlatRow, index: number) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (row.node.isDir) {
          if (collapsed.has(row.node.path)) toggleCollapse(row.node.path);
          else focusRow(index + 1);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (row.node.isDir && !collapsed.has(row.node.path)) {
          toggleCollapse(row.node.path);
        } else {
          const parent = [...rows.slice(0, index)].reverse().find((r) => r.depth === row.depth - 1);
          if (parent) setFocusedPath(parent.node.path);
        }
        break;
      case "Home":
        event.preventDefault();
        focusRow(0);
        break;
      case "End":
        event.preventDefault();
        focusRow(rows.length - 1);
        break;
      case " ":
        event.preventDefault();
        toggleRow(row);
        break;
      case "Enter":
        event.preventDefault();
        if (row.node.isDir) toggleCollapse(row.node.path);
        else toggleRow(row);
        break;
      case "a":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const files = rows.filter((r) => !r.node.isDir && r.toggleable).flatMap((r) => r.files);
          if (files.length > 0) onToggle(files, true);
        }
        break;
      default:
        break;
    }
  };

  const selectVisible = (value: boolean) => {
    const files = rows.filter((r) => !r.node.isDir && r.toggleable).flatMap((r) => r.files);
    if (files.length > 0) onToggle(files, value);
  };

  /**
   * 打包页的「全部打包 / 全部排除」要覆盖折叠目录与筛选之外的文件；
   * 只对可见行操作会让人以为按钮没生效。锁定项（自动/规则/主程序）仍然跳过。
   */
  const selectAll = (value: boolean) => {
    const files: string[] = [];
    const walk = (node: FileNode) => {
      if (hidden?.has(node.path)) return;
      if (node.isDir) {
        for (const child of node.children) walk(child);
        return;
      }
      if (!locked?.get(node.path)) files.push(node.path);
    };
    walk(root);
    if (files.length > 0) onToggle(files, value);
  };

  const quickAssembly = () => {
    const next = extensions.includes("dll") && extensions.includes("exe") ? [] : ["dll", "exe"];
    setExtensions(next);
  };

  const statusColor = (row: FlatRow) => {
    if (row.locked?.reason === "always") return "brand";
    if (row.locked?.reason === "auto") return "informative";
    if (row.locked?.reason === "rule") return "warning";
    if (row.state === "on") return "success";
    if (row.state === "mixed") return "warning";
    return "subtle";
  };

  const truncated =
    root.truncated || root.children.some((child) => child.truncated);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarRow}>
          <Input
            className={styles.search}
            size="small"
            value={search}
            onChange={(_, data) => setSearch(data.value)}
            placeholder="搜索文件名或路径"
            contentBefore={<SearchRegular />}
          />
          {mode === "merge" ? (
            <Button
              className={styles.chip}
              appearance={
                extensions.includes("dll") && extensions.includes("exe")
                  ? "primary"
                  : "secondary"
              }
              size="small"
              onClick={quickAssembly}
            >
              只看程序集
            </Button>
          ) : (
            <>
              <Button
                className={styles.chip}
                appearance={only === "checked" ? "primary" : "secondary"}
                size="small"
                onClick={() => setOnly(only === "checked" ? "all" : "checked")}
              >
                只看打包
              </Button>
              <Button
                className={styles.chip}
                appearance={only === "unchecked" ? "primary" : "secondary"}
                size="small"
                onClick={() => setOnly(only === "unchecked" ? "all" : "unchecked")}
              >
                只看排除
              </Button>
            </>
          )}
          {mode === "merge" ? (
            <Button
              className={styles.chip}
              appearance={only === "checked" ? "primary" : "secondary"}
              size="small"
              onClick={() => setOnly(only === "checked" ? "all" : "checked")}
            >
              只看已选
            </Button>
          ) : null}
          <span className={styles.spacer} />
          <Button
            className={styles.chip}
            appearance="subtle"
            size="small"
            icon={<ChevronDownRegular />}
            onClick={() => setCollapsed(new Set())}
          >
            展开全部
          </Button>
          <Button
            className={styles.chip}
            appearance="subtle"
            size="small"
            icon={<ChevronUpRegular />}
            onClick={() => setCollapsed(new Set(allDirPaths(root, hidden)))}
          >
            折叠全部
          </Button>
        </div>

        <div className={styles.toolbarRow}>
          <div className={styles.chips}>
            {extChips.map(({ ext, count }) => {
              const active = extensions.includes(ext);
              return (
                <Button
                  key={ext}
                  className={styles.chip}
                  appearance={active ? "primary" : "subtle"}
                  size="small"
                  onClick={() =>
                    setExtensions((current) =>
                      current.includes(ext)
                        ? current.filter((item) => item !== ext)
                        : [...current, ext],
                    )
                  }
                >
                  .{ext} <span className={styles.chipCount}>{count}</span>
                </Button>
              );
            })}
            {extensions.length > 0 ? (
              <Button className={styles.chip} appearance="subtle" size="small" onClick={() => setExtensions([])}>
                清除类型
              </Button>
            ) : null}
          </div>
          <span className={styles.spacer} />
          <Button
            className={styles.chip}
            appearance="secondary"
            size="small"
            title={
              mode === "merge"
                ? "只处理当前筛选结果"
                : "覆盖折叠目录和筛选之外的文件；自动排除、规则命中与主程序保持不变"
            }
            onClick={() => (mode === "merge" ? selectVisible(true) : selectAll(true))}
          >
            {mode === "merge" ? "全选当前结果" : "全部打包"}
          </Button>
          <Button
            className={styles.chip}
            appearance="secondary"
            size="small"
            title={
              mode === "merge"
                ? "只处理当前筛选结果"
                : "覆盖折叠目录和筛选之外的文件；自动排除、规则命中与主程序保持不变"
            }
            onClick={() => (mode === "merge" ? selectVisible(false) : selectAll(false))}
          >
            {mode === "merge" ? "全不选" : "全部排除"}
          </Button>
        </div>
      </div>

      {truncated ? (
        <MessageBar intent="warning" className={styles.truncated}>
          <MessageBarBody>
            目录过大，只扫描了前 8000 项或前 6 层；计数可能不完整。
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {loading ? (
        <div className={styles.loading}>
          <Spinner size="tiny" />
          正在扫描目录…
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>{emptyText ?? "没有匹配的文件"}</div>
      ) : (
        <div ref={parentRef} className={styles.body} role="tree" aria-multiselectable="true">
          <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const focused = row.node.path === focusedPath;
              const expanded = row.node.isDir && !collapsed.has(row.node.path);
              const checkedState =
                row.state === "on" ? true : row.state === "mixed" ? "mixed" : false;
              return (
                <div
                  key={row.node.path}
                  className={mergeClasses(styles.row, focused && styles.rowFocused)}
                  style={{
                    transform: `translateY(${item.start}px)`,
                    paddingLeft: `${6 + row.depth * 16}px`,
                  }}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={row.node.isDir ? expanded : undefined}
                  aria-checked={checkedState}
                  aria-selected={focused}
                  tabIndex={focused ? 0 : -1}
                  title={row.node.path}
                  onFocus={() => setFocusedPath(row.node.path)}
                  onClick={() => {
                    setFocusedPath(row.node.path);
                    toggleRow(row);
                  }}
                  onContextMenu={(event) =>
                    openMenu(
                      [
                        {
                          id: "copy-path",
                          label: "复制路径",
                          icon: <CopyRegular />,
                          onSelect: () => void navigator.clipboard.writeText(row.node.path),
                        },
                        {
                          id: "reveal",
                          label: "在资源管理器中显示",
                          icon: <FolderOpenRegular />,
                          onSelect: () =>
                            void reveal(row.node.path).catch(() =>
                              toast("无法定位文件", "error"),
                            ),
                        },
                      ],
                      event,
                    )
                  }
                  onKeyDown={(event) => onRowKeyDown(event, row, item.index)}
                >
                  {row.node.isDir ? (
                    <button
                      type="button"
                      className={styles.chevron}
                      aria-label={expanded ? "折叠" : "展开"}
                      onClick={(event) => {
                        event.stopPropagation();
                        setFocusedPath(row.node.path);
                        toggleCollapse(row.node.path);
                      }}
                    >
                      {expanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
                    </button>
                  ) : (
                    <span className={styles.chevronSpacer} />
                  )}

                  <Checkbox
                    className={styles.checkbox}
                    checked={checkedState}
                    disabled={!row.toggleable}
                    aria-label={`${row.node.name} ${row.status}`}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => toggleRow(row)}
                  />

                  <span className={mergeClasses(styles.icon, row.node.isDir && styles.folderIcon)}>
                    {row.node.isDir ? (
                      expanded ? (
                        <FolderOpenRegular />
                      ) : (
                        <FolderRegular />
                      )
                    ) : (
                      <DocumentRegular />
                    )}
                  </span>

                  <span className={mergeClasses(styles.name, row.node.isDir && styles.nameDir)}>
                    <Highlight text={row.node.name} search={search} />
                  </span>

                  <span className={styles.size}>{formatBytes(row.bytes)}</span>

                  <span className={styles.status}>
                    <Badge appearance="tint" size="small" color={statusColor(row)}>
                      {row.status}
                    </Badge>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className={styles.footer}>
        <Text size={100}>
          {mode === "merge"
            ? `已选 ${stats.checked} / 共 ${stats.total} 个文件`
            : `打包 ${stats.checked} / 共 ${stats.total} 个文件`}
        </Text>
        <Text size={100}>
          共 {formatBytes(stats.totalBytes)} · 已选 {formatBytes(stats.checkedBytes)}
        </Text>
        <span className={styles.spacer} />
        <Text size={100}>当前显示 {stats.visible} 个</Text>
      </div>
    </div>
  );
}
