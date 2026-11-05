import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  DismissRegular,
  SearchRegular,
} from "@fluentui/react-icons";

import { Page } from "@/components/common/Page";
import { Panel } from "@/components/common/Panel";
import { FileTree } from "@/components/tree/FileTree";
import { formatBytes } from "@/lib/format";
import { useProjectStore } from "@/stores/projectStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { FileNode } from "@/types";
import { baseName, relativeTo } from "@/util";

const useStyles = makeStyles({
  split: {
    display: "flex",
    gap: "var(--app-space-4)",
    flex: 1,
    minHeight: 0,
  },
  treePane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  side: {
    width: "var(--app-side-w)",
    flexShrink: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  sideBody: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
    flex: 1,
    minHeight: 0,
    padding: "var(--app-space-2) var(--app-space-3)",
  },
  sideSearch: {
    width: "100%",
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
  },
  groupTitle: {
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
    padding: "var(--app-space-1) 0 0",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    padding: "var(--app-space-1) var(--app-space-1) var(--app-space-1) var(--app-space-2)",
    borderRadius: "var(--app-radius-sm)",
    ":hover": {
      background: tokens.colorNeutralBackground3Hover,
    },
  },
  itemName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--app-font-small)",
  },
  itemSize: {
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  empty: {
    padding: "var(--app-space-5) var(--app-space-2)",
    textAlign: "center",
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground3,
  },
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--app-space-2)",
    height: "180px",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-small)",
  },
  summary: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    paddingTop: "var(--app-space-2)",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
  },
  errorBox: {
    padding: "var(--app-space-4)",
  },
  errorAction: {
    marginTop: "var(--app-space-3)",
  },
  spacer: {
    flex: 1,
  },
});

function sizesOf(node: FileNode, out: Map<string, number>): void {
  if (node.isDir) {
    node.children.forEach((child) => sizesOf(child, out));
    return;
  }
  out.set(node.path, node.size ?? 0);
}

export function MergeStep() {
  const styles = useStyles();
  const project = useProjectStore((state) => state.current);
  const update = useProjectStore((state) => state.update);
  const tree = useWorkspaceStore((state) => state.tree);
  const treeError = useWorkspaceStore((state) => state.treeError);
  const scanning = useWorkspaceStore((state) => state.scanning);
  const ensureTree = useWorkspaceStore((state) => state.ensureTree);
  const rescan = useWorkspaceStore((state) => state.rescan);
  const refreshIgnores = useWorkspaceStore((state) => state.refreshIgnores);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!tree && !scanning) void ensureTree();
    // 只在首次挂载时兜底；工程切换由 App 统一处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sizes = useMemo(() => {
    const map = new Map<string, number>();
    if (tree) sizesOf(tree, map);
    return map;
  }, [tree]);

  const checked = useMemo(
    () => new Set(project?.mergeDlls ?? []),
    [project?.mergeDlls],
  );

  const hidden = useMemo(
    () => new Set(project?.exeFile ? [project.exeFile] : []),
    [project?.exeFile],
  );

  if (!project) return null;
  const selected = project.mergeDlls
    .filter((path) => !filter.trim() || path.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => relativeTo(project.rootPath, a).localeCompare(relativeTo(project.rootPath, b)));

  const groups = new Map<string, string[]>();
  for (const path of selected) {
    const relative = relativeTo(project.rootPath, path);
    const slash = relative.lastIndexOf("\\");
    const folder = slash > 0 ? relative.slice(0, slash) : "根目录";
    const list = groups.get(folder) ?? [];
    list.push(path);
    groups.set(folder, list);
  }

  const totalBytes = selected.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0);

  const toggle = (paths: string[], value: boolean) => {
    const next = new Set(project.mergeDlls);
    for (const path of paths) {
      if (value) next.add(path);
      else next.delete(path);
    }
    update({ mergeDlls: [...next] });
    void refreshIgnores();
  };

  const remove = (path: string) => {
    update({ mergeDlls: project.mergeDlls.filter((item) => item !== path) });
    void refreshIgnores();
  };

  const clear = () => {
    update({ mergeDlls: [] });
    void refreshIgnores();
  };

  const rescanNow = () => {
    void rescan();
  };

  return (
    <Page
      title="合并程序集"
      description="勾选要合并进主程序的程序集。合并后这些文件不再重复打包，可以跳过本步。"
      wide
      fill
      actions={
        <Button
          appearance="secondary"
          size="small"
          icon={<ArrowClockwiseRegular />}
          disabled={scanning}
          onClick={rescanNow}
        >
          {scanning ? "扫描中…" : "重新扫描"}
        </Button>
      }
    >
      <div className={styles.split}>
        <div className={styles.treePane}>
          <Panel fill flush>
            {treeError ? (
              <div className={styles.errorBox}>
                <MessageBar intent="error">
                  <MessageBarBody>扫描目录失败：{treeError}</MessageBarBody>
                </MessageBar>
                <Button
                  appearance="secondary"
                  size="small"
                  className={styles.errorAction}
                  onClick={rescanNow}
                >
                  重试
                </Button>
              </div>
            ) : tree ? (
              <FileTree
                root={tree}
                mode="merge"
                checked={checked}
                hidden={hidden}
                loading={scanning}
                onToggle={toggle}
                emptyText="这个目录里没有可合并的文件"
              />
            ) : (
              <div className={styles.center}>
                <Spinner size="tiny" />
                正在扫描目录…
              </div>
            )}
          </Panel>
        </div>

        <aside className={styles.side}>
          <Panel
            fill
            flush
            title="合并清单"
            description="这些程序集会被合并进主程序，并从安装包自动排除。"
            actions={<Text size={100}>{project.mergeDlls.length} 项</Text>}
          >
            <div className={styles.sideBody}>
              <Input
                className={styles.sideSearch}
                size="small"
                value={filter}
                onChange={(_, data) => setFilter(data.value)}
                placeholder="筛选已选文件"
                contentBefore={<SearchRegular />}
              />

              <div className={styles.list}>
                {selected.length === 0 ? (
                  <div className={styles.empty}>
                    {project.mergeDlls.length === 0
                      ? "还没有勾选程序集。左侧勾选后，这里会出现清单。"
                      : "没有匹配的已选文件。"}
                  </div>
                ) : (
                  [...groups.entries()].map(([folder, paths]) => (
                    <div key={folder} className={styles.group}>
                      <span className={styles.groupTitle}>{folder}</span>
                      {paths.map((path) => (
                        <div key={path} className={styles.item} title={path}>
                          <span className={styles.itemName}>{baseName(path)}</span>
                          <span className={styles.itemSize}>
                            {formatBytes(sizes.get(path) ?? 0)}
                          </span>
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={<DismissRegular />}
                            aria-label={`移除 ${baseName(path)}`}
                            onClick={() => remove(path)}
                          />
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>

              <div className={styles.summary}>
                <span>共 {formatBytes(totalBytes)}</span>
                <span className={styles.spacer} />
                <Button
                  appearance="secondary"
                  size="small"
                  disabled={project.mergeDlls.length === 0}
                  onClick={clear}
                >
                  全部移除
                </Button>
              </div>
            </div>
          </Panel>
        </aside>
      </div>
    </Page>
  );
}
