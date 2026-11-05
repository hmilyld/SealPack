import {
  Badge,
  Button,
  Field,
  Input,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  BroomRegular,
  FolderOpenRegular,
  FolderRegular,
} from "@fluentui/react-icons";

import { api, pickDirectory, pickExe, reveal } from "@/api";
import { useToast } from "@/components/feedback/ToastProvider";
import { Page } from "@/components/common/Page";
import { Panel } from "@/components/common/Panel";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { formatDateTime } from "@/lib/format";
import { artifactKindLabel } from "@/lib/summaries";
import { STAGE_META, type BuildHistoryEntry } from "@/types";
import { baseName, isUnder, uniquePaths } from "@/util";

const useStyles = makeStyles({
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: "var(--app-space-4)",
    "@media (max-width: 900px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
    },
  },
  full: {
    gridColumn: "1 / -1",
  },
  note: {
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground3,
  },
  meta: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gap: "var(--app-space-1) var(--app-space-4)",
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground3,
  },
  metaValue: {
    color: tokens.colorNeutralForeground1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  actions: {
    display: "flex",
    gap: "var(--app-space-2)",
    flexWrap: "wrap",
  },
  actionsSpaced: {
    marginTop: "var(--app-space-3)",
  },
  noteBlock: {
    display: "block",
    marginTop: "var(--app-space-3)",
  },
  historyList: {
    display: "flex",
    flexDirection: "column",
  },
  historyRow: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
    padding: "var(--app-space-3) 0",
    borderBottom: "1px solid var(--app-border-subtle)",
    ":last-child": {
      borderBottom: "none",
    },
  },
  historyHead: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--app-space-3)",
  },
  historyMeta: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
    minWidth: 0,
    flex: 1,
  },
  historyTitle: {
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  historySub: {
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "normal",
  },
  historyTime: {
    flexShrink: 0,
    paddingTop: "2px",
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
  historyArtifacts: {
    display: "flex",
    gap: "var(--app-space-1)",
    flexWrap: "wrap",
  },
  artifactChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--app-space-1)",
    maxWidth: "360px",
    height: "28px",
    padding: "0 var(--app-space-2)",
    border: "1px solid var(--app-border-subtle)",
    borderRadius: "var(--app-radius-sm)",
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    fontSize: "var(--app-font-small)",
    cursor: "default",
    ":hover": {
      background: tokens.colorNeutralBackground3Hover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  artifactName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  emptyHistory: {
    padding: "var(--app-space-3) 0",
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground3,
  },
});

/** 历史产物排序：安装包 → 主程序 → 基线清单 → 校验清单。 */
function artifactRank(path: string): number {
  const name = baseName(path).toLowerCase();
  if (name.startsWith("checksums-")) return 3;
  if (name.startsWith("sealpack-manifest-")) return 2;
  if (name.includes("安装包") || name.includes("升级包")) return 0;
  return 1;
}

export function SetupStep() {
  const styles = useStyles();
  const toast = useToast();
  const project = useProjectStore((state) => state.current);
  const update = useProjectStore((state) => state.update);
  const updateOptions = useProjectStore((state) => state.updateOptions);
  const resetWorkspace = useWorkspaceStore((state) => state.reset);
  const ensureTree = useWorkspaceStore((state) => state.ensureTree);
  const refreshIgnores = useWorkspaceStore((state) => state.refreshIgnores);
  const resetBuild = useBuildStore((state) => state.reset);

  if (!project) return null;

  const pickMainExe = async () => {
    const picked = await pickExe().catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), "error");
      return null;
    });
    if (!picked) return;

    const rootPath = picked.replace(/[\\/][^\\/]+$/, "");
    const version = (await api.exeVersion(picked).catch(() => "")) || project.version;
    let appId = project.packageOptions.appId;
    if (!appId.trim()) {
      appId = await api.exeAppId(picked).catch(() => "");
    }

    const kept = project.mergeDlls.filter((path) => isUnder(rootPath, path));
    const dropped = project.mergeDlls.length - kept.length;

    update({ exeFile: picked, rootPath, version, mergeDlls: kept });
    if (appId !== project.packageOptions.appId) {
      updateOptions({ packageOptions: { appId } });
    }

    resetWorkspace();
    resetBuild();
    void ensureTree(true);
    void refreshIgnores();

    if (dropped > 0) {
      toast(`主程序目录已变更，${dropped} 个原目录下的合并项已移除`, "info");
    }
  };

  const pickOutput = async () => {
    const picked = await pickDirectory("选择安装包输出目录").catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), "error");
      return null;
    });
    if (!picked) return;
    update({ outputDir: picked });
    void refreshIgnores();
  };

  const detectVersion = async () => {
    if (!project.exeFile) {
      toast("请先选择主程序", "warning");
      return;
    }
    const version = await api.exeVersion(project.exeFile).catch(() => "");
    if (!version) {
      toast("未能读取版本号，请手动填写", "error");
      return;
    }
    update({ version });
    toast(`已读取版本号 ${version}`, "success");
  };

  const detectAppId = async () => {
    if (!project.exeFile) {
      toast("请先选择主程序", "warning");
      return;
    }
    const appId = await api.exeAppId(project.exeFile).catch(() => "");
    if (!appId) {
      toast("未能推导应用标识，请手动填写", "error");
      return;
    }
    updateOptions({ packageOptions: { appId } });
    toast("已由主程序推导应用标识", "success");
  };

  const open = (path: string) => {
    if (!path) return;
    void reveal(path).catch(() => toast("无法打开目录", "error"));
  };

  const history = project.buildHistory ?? [];
  const clearHistory = () => update({ buildHistory: [] });
  const scopeLabel = (scope: BuildHistoryEntry["scope"]) =>
    scope === "all" ? "全部执行" : STAGE_META[scope].title;
  const statusColor = (status: BuildHistoryEntry["status"]) =>
    status === "ok"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "cancelled"
          ? "warning"
          : "subtle";
  const statusLabel = (status: BuildHistoryEntry["status"]) =>
    status === "ok"
      ? "成功"
      : status === "failed"
        ? "失败"
        : status === "cancelled"
          ? "已取消"
          : "已跳过";

  return (
    <Page
      title="主程序"
      description="合并、加密、打包都以这个程序为目标。选好主程序后，它所在目录会成为后续步骤的扫描根目录。"
      actions={
        <>
          <Button
            appearance="subtle"
            size="small"
            icon={<FolderOpenRegular />}
            disabled={!project.rootPath}
            onClick={() => open(project.rootPath)}
          >
            打开程序目录
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<FolderRegular />}
            disabled={!project.outputDir}
            onClick={() => open(project.outputDir)}
          >
            打开输出目录
          </Button>
        </>
      }
    >
      <Panel title="工程信息" description="这些信息会写进安装包，并随工程文件保存。">
        <div className={styles.grid}>
          <Field
            label="工程名称"
            required
            hint="会写进安装包，也会显示在工程栏。"
          >
            <Input
              value={project.name}
              onChange={(_, data) => update({ name: data.value })}
              placeholder="例如 我的工具"
            />
          </Field>

          <Field label="版本号（用于安装包）" hint="可以手动填写，也可以从主程序的版本资源里读取。">
            <Input
              value={project.version}
              onChange={(_, data) => update({ version: data.value })}
              placeholder="1.0.0.0"
              contentAfter={
                <Button
                  appearance="transparent"
                  size="small"
                  icon={<ArrowClockwiseRegular />}
                  aria-label="自动探测版本号"
                  title="自动探测版本号"
                  onClick={() => void detectVersion()}
                />
              }
            />
          </Field>

          <Field label="主程序文件" required className={styles.full}>
            <Input
              value={project.exeFile}
              onChange={(_, data) => update({ exeFile: data.value })}
              placeholder="编译输出的 .exe"
              contentAfter={
                <Button
                  appearance="transparent"
                  size="small"
                  icon={<FolderOpenRegular />}
                  aria-label="浏览主程序"
                  title="浏览主程序"
                  onClick={() => void pickMainExe()}
                />
              }
            />
          </Field>

          <Field
            label="安装包输出目录"
            required
            hint="安装包、基线清单和校验清单都会写到这里。"
          >
            <Input
              value={project.outputDir}
              onChange={(_, data) => update({ outputDir: data.value })}
              placeholder="安装包生成位置"
              contentAfter={
                <Button
                  appearance="transparent"
                  size="small"
                  icon={<FolderOpenRegular />}
                  aria-label="浏览输出目录"
                  title="浏览输出目录"
                  onClick={() => void pickOutput()}
                />
              }
            />
          </Field>

          <Field
            label="安装包密码"
            hint="留空表示不加密码；口令以明文保存在工程文件里。"
          >
            <Input
              type="password"
              value={project.password}
              onChange={(_, data) => update({ password: data.value })}
              placeholder="留空则不加密码"
            />
          </Field>

          <Field
            label="应用标识（AppId）"
            hint="决定重新打包后是覆盖升级还是全新安装。默认由主程序的产品身份推导。"
            className={styles.full}
          >
            <Input
              value={project.packageOptions.appId}
              onChange={(_, data) => updateOptions({ packageOptions: { appId: data.value } })}
              placeholder="选好主程序后自动推导，也可手工填写"
              contentAfter={
                <Button
                  appearance="transparent"
                  size="small"
                  icon={<ArrowClockwiseRegular />}
                  aria-label="自动探测应用标识"
                  title="自动探测应用标识"
                  onClick={() => void detectAppId()}
                />
              }
            />
          </Field>

          <Field label="主程序所在目录" className={styles.full}>
            <Input value={project.rootPath} readOnly placeholder="选择主程序后自动填入" />
          </Field>
        </div>
      </Panel>

      <Panel
        variant="plain"
        title="当前配置"
        description="改完即自动保存；左侧工程列表可以随时切换。"
      >
        <div className={styles.meta}>
          <span>主程序</span>
          <span className={styles.metaValue}>
            {project.exeFile ? baseName(project.exeFile) : "未选择"}
          </span>
          <span>版本</span>
          <span className={styles.metaValue}>{project.version || "未填写"}</span>
          <span>输出目录</span>
          <span className={styles.metaValue}>{project.outputDir || "未设置"}</span>
          <span>AppId</span>
          <span className={styles.metaValue}>{project.packageOptions.appId || "未推导"}</span>
        </div>
        <div className={mergeClasses(styles.actions, styles.actionsSpaced)}>
          <Button
            appearance="secondary"
            size="small"
            icon={<FolderRegular />}
            disabled={!project.outputDir}
            onClick={() => open(project.outputDir)}
          >
            打开输出目录
          </Button>
        </div>
        <Text className={mergeClasses(styles.note, styles.noteBlock)}>
          口令类字段（安装包密码、密钥口令、符号还原口令）以明文保存在
          <code> %APPDATA%\com.hmilyld.sealpack\projects\ </code>
          下，这是为了让工具链能够无人值守地重跑。
        </Text>
      </Panel>

      <Panel
        variant="plain"
        title="构建历史"
        description="保留最近 20 次构建记录；产物标签可直接定位。"
        actions={
          <Button
            appearance="subtle"
            size="small"
            icon={<BroomRegular />}
            disabled={history.length === 0}
            onClick={clearHistory}
          >
            清空
          </Button>
        }
      >
        {history.length === 0 ? (
          <span className={styles.emptyHistory}>
            还没有构建记录。执行一次后，这里会保留最近 20 次。
          </span>
        ) : (
          <div className={styles.historyList}>
            {history.slice(0, 8).map((entry) => {
              const artifacts = uniquePaths(entry.artifacts).sort(
                (a, b) =>
                  artifactRank(a) - artifactRank(b) ||
                  baseName(a).localeCompare(baseName(b)),
              );
              return (
                <div key={entry.id} className={styles.historyRow}>
                  <div className={styles.historyHead}>
                    <Badge appearance="tint" color={statusColor(entry.status)} size="small">
                      {statusLabel(entry.status)}
                    </Badge>
                    <div className={styles.historyMeta}>
                      <span className={styles.historyTitle}>
                        {scopeLabel(entry.scope)} · v{entry.version || "-"}
                        {entry.artifact !== "none"
                          ? ` · ${artifactKindLabel(entry.artifact)}`
                          : ""}
                      </span>
                      <span className={styles.historySub} title={entry.message}>
                        {entry.message}
                      </span>
                    </div>
                    <span className={styles.historyTime}>
                      {formatDateTime(entry.finishedAt)}
                    </span>
                  </div>
                  {artifacts.length > 0 ? (
                    <div className={styles.historyArtifacts}>
                      {artifacts.map((path) => (
                        <button
                          key={path}
                          type="button"
                          className={styles.artifactChip}
                          title={path}
                          onClick={() => open(path)}
                        >
                          <FolderOpenRegular />
                          <span className={styles.artifactName}>{baseName(path)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </Page>
  );
}
