import { useMemo, useState } from "react";
import {
  Button,
  Input,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowClockwiseRegular,
  CopyRegular,
  DeleteRegular,
  EditRegular,
  FolderOpenRegular,
  SearchRegular,
} from "@fluentui/react-icons";

import { reveal } from "@/api";
import { useContextMenu } from "@/components/common/ContextMenu";
import { DeleteProjectDialog } from "@/components/dialogs/DeleteProjectDialog";
import { ProjectRenameDialog } from "@/components/dialogs/ProjectRenameDialog";
import { semantic } from "@/theme/semantic";
import type { Project } from "@/types";
import { baseName } from "@/util";
import { useToast } from "@/components/feedback/ToastProvider";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    width: "var(--app-rail-w)",
    flexShrink: 0,
    minHeight: 0,
    background: tokens.colorNeutralBackground2,
    borderRight: "1px solid var(--app-border-default)",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--app-space-2)",
    padding: "var(--app-space-3) var(--app-space-3) var(--app-space-2)",
  },
  title: {
    fontSize: "var(--app-font-small)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
  },
  search: {
    padding: "0 var(--app-space-3) var(--app-space-2)",
  },
  searchInput: {
    width: "100%",
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "0 var(--app-space-1) var(--app-space-2)",
  },
  row: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "var(--app-space-1)",
    width: "100%",
    padding: "var(--app-space-2) var(--app-space-2) var(--app-space-2) var(--app-space-3)",
    border: "none",
    borderLeft: "3px solid transparent",
    borderRadius: "var(--app-radius-sm)",
    background: "transparent",
    color: tokens.colorNeutralForeground1,
    textAlign: "left",
    cursor: "default",
    ":hover": {
      background: tokens.colorNeutralBackground3Hover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  rowActive: {
    borderLeftColor: tokens.colorBrandBackground,
    background: tokens.colorNeutralBackground3Selected,
    ":hover": {
      background: tokens.colorNeutralBackground3Selected,
    },
  },
  rowName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
  },
  rowMeta: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
    alignItems: "flex-start",
    padding: "var(--app-space-4) var(--app-space-3)",
    color: tokens.colorNeutralForeground3,
  },
  foot: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
    padding: "var(--app-space-2) var(--app-space-3)",
    borderTop: "1px solid var(--app-border-subtle)",
  },
  footTitle: {
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
  },
  tool: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground2,
  },
  dot: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    flexShrink: 0,
  },
});

export function ProjectRail() {
  const styles = useStyles();
  const toast = useToast();
  const { openMenu } = useContextMenu();
  const projects = useProjectStore((state) => state.projects);
  const current = useProjectStore((state) => state.current);
  const select = useProjectStore((state) => state.select);
  const reload = useProjectStore((state) => state.reload);
  const setNewProjectOpen = useUiStore((state) => state.setNewProjectOpen);
  const setStep = useUiStore((state) => state.setStep);
  const resetWorkspace = useWorkspaceStore((state) => state.reset);
  const rescan = useWorkspaceStore((state) => state.rescan);
  const resetBuild = useBuildStore((state) => state.reset);
  const running = useBuildStore((state) => state.running);
  const toolStatus = useSettingsStore((state) => state.toolStatus);
  const [query, setQuery] = useState("");
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(term) ||
        project.exeFile.toLowerCase().includes(term),
    );
  }, [projects, query]);

  const openProject = async (id: string) => {
    if (running || current?.id === id) return;
    try {
      await select(id);
      resetWorkspace();
      resetBuild();
      setStep("setup");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const reloadProject = async (project: Project) => {
    try {
      await reload(project.id);
      if (current?.id === project.id) {
        // 目录里可能删了文件；重新扫描树和排除项，而不是只重读 JSON。
        await rescan();
      }
      toast("工程已重新加载", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  return (
    <aside className={`app-rail ${styles.root}`}>
      <div className={styles.head}>
        <span className={styles.title}>工程</span>
        <Button
          appearance="subtle"
          size="small"
          icon={<AddRegular />}
          disabled={running}
          onClick={() => setNewProjectOpen(true)}
        >
          新建
        </Button>
      </div>

      <div className={styles.search}>
        <Input
          size="small"
          value={query}
          onChange={(_, data) => setQuery(data.value)}
          placeholder="搜索工程"
          contentBefore={<SearchRegular />}
          className={styles.searchInput}
        />
      </div>

      <div className={styles.list}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>
            <Text size={200}>
              {projects.length === 0 ? "还没有工程。新建一个，选好主程序就能开始。" : "没有匹配的工程。"}
            </Text>
            {projects.length === 0 ? (
              <Button
                appearance="primary"
                size="small"
                icon={<AddRegular />}
                disabled={running}
                onClick={() => setNewProjectOpen(true)}
              >
                新建工程
              </Button>
            ) : null}
          </div>
        ) : (
          filtered.map((project) => (
            <button
              key={project.id}
              type="button"
              className={mergeClasses(
                styles.row,
                project.id === current?.id && styles.rowActive,
              )}
              onClick={() => void openProject(project.id)}
              onContextMenu={(event) =>
                openMenu(
                  [
                    {
                      id: "open-root",
                      label: "打开主程序目录",
                      icon: <FolderOpenRegular />,
                      onSelect: () =>
                        void reveal(project.rootPath).catch(() =>
                          toast("无法打开目录", "error"),
                        ),
                    },
                    {
                      id: "open-output",
                      label: "打开输出目录",
                      icon: <FolderOpenRegular />,
                      onSelect: () =>
                        void reveal(project.outputDir).catch(() =>
                          toast("无法打开目录", "error"),
                        ),
                    },
                    {
                      id: "reload",
                      label: "重新加载工程",
                      icon: <ArrowClockwiseRegular />,
                      disabled: running,
                      onSelect: () => void reloadProject(project),
                    },
                    { id: "sep", separator: true },
                    {
                      id: "copy-name",
                      label: "复制工程名",
                      icon: <CopyRegular />,
                      onSelect: () => void navigator.clipboard.writeText(project.name),
                    },
                    { id: "sep-project", separator: true },
                    {
                      id: "rename",
                      label: "重命名…",
                      icon: <EditRegular />,
                      disabled: running,
                      onSelect: () => setRenameTarget(project),
                    },
                    {
                      id: "delete",
                      label: "删除工程…",
                      icon: <DeleteRegular />,
                      danger: true,
                      disabled: running,
                      onSelect: () => setDeleteTarget(project),
                    },
                  ],
                  event,
                )
              }
              title={project.exeFile}
            >
              <span className={styles.rowName}>{project.name}</span>
              <span className={styles.rowMeta}>
                {baseName(project.exeFile) || "未选择主程序"}
                {project.version ? ` · ${project.version}` : ""}
              </span>
            </button>
          ))
        )}
      </div>

      <div className={styles.foot}>
        <span className={styles.footTitle}>工具链</span>
        {(toolStatus?.items ?? []).map((item) => (
          <span key={item.key} className={styles.tool} title={item.path}>
            <span
              className={styles.dot}
              style={{
                background: item.available ? semantic.success : semantic.danger,
              }}
            />
            {item.label}
          </span>
        ))}
      </div>

      <ProjectRenameDialog
        project={renameTarget}
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
      />
      <DeleteProjectDialog
        project={deleteTarget}
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
      />
    </aside>
  );
}
