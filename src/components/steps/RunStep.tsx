import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  ErrorCircleRegular,
  FolderOpenRegular,
  InfoRegular,
  PlayRegular,
  StopRegular,
  WarningRegular,
} from "@fluentui/react-icons";

import { api, reveal } from "@/api";
import { Page } from "@/components/common/Page";
import { Panel } from "@/components/common/Panel";
import { useToast } from "@/components/feedback/ToastProvider";
import { stageStatusColor, stageStatusLabel, stageSummary } from "@/lib/summaries";
import { semantic } from "@/theme/semantic";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { STAGE_META, type PreflightReport, type Stage } from "@/types";
import { baseName } from "@/util";

const STAGES: Stage[] = ["merge", "encrypt", "package"];

const useStyles = makeStyles({
  list: {
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-4)",
    padding: "var(--app-space-3) var(--app-space-4)",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    ":last-child": {
      borderBottom: "none",
    },
  },
  index: {
    display: "grid",
    placeItems: "center",
    width: "24px",
    height: "24px",
    flexShrink: 0,
    borderRadius: "50%",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground2,
    fontSize: "var(--app-font-meta)",
    fontWeight: 600,
  },
  text: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
    minWidth: 0,
    flex: 1,
  },
  title: {
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  hint: {
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground3,
  },
  summary: {
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground2,
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    flexShrink: 0,
  },
  artifacts: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-1)",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    maxWidth: "360px",
  },
  progress: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    fontSize: "var(--app-font-small)",
    color: tokens.colorBrandForeground1,
  },
  checks: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
  },
  checkRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--app-space-2)",
    fontSize: "var(--app-font-small)",
  },
  checkLabel: {
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    whiteSpace: "nowrap",
  },
  checkDetail: {
    color: tokens.colorNeutralForeground3,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ok: { color: semantic.success },
  warn: { color: semantic.warning },
  error: { color: semantic.danger },
  info: { color: semantic.info },
  muted: { color: tokens.colorNeutralForeground3 },
  dialogList: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
    maxHeight: "260px",
    overflow: "auto",
    fontSize: "var(--app-font-small)",
  },
});

function checkIcon(status: "ok" | "info" | "warn" | "error", styles: ReturnType<typeof useStyles>) {
  switch (status) {
    case "ok":
      return <CheckmarkCircleRegular className={styles.ok} />;
    case "warn":
      return <WarningRegular className={styles.warn} />;
    case "error":
      return <ErrorCircleRegular className={styles.error} />;
    default:
      return <InfoRegular className={styles.info} />;
  }
}

export function RunStep() {
  const styles = useStyles();
  const toast = useToast();
  const project = useProjectStore((state) => state.current);
  const ignores = useWorkspaceStore((state) => state.ignores);
  const statuses = useBuildStore((state) => state.statuses);
  const artifacts = useBuildStore((state) => state.artifacts);
  const running = useBuildStore((state) => state.running);
  const progress = useBuildStore((state) => state.progress);
  const runAll = useBuildStore((state) => state.runAll);
  const runStage = useBuildStore((state) => state.runStage);
  const cancel = useBuildStore((state) => state.cancel);

  const [report, setReport] = useState<PreflightReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refreshPreflight = useCallback(async (): Promise<PreflightReport | null> => {
    const current = useProjectStore.getState().current;
    if (!current) return null;
    setLoading(true);
    try {
      const next = await api.preflight(current);
      if (useProjectStore.getState().current?.id !== current.id) return null;
      setReport(next);
      return next;
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
      return null;
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refreshPreflight();
  }, [
    project?.id,
    project?.buildOptions?.artifact,
    project?.buildOptions?.baselinePath,
    refreshPreflight,
  ]);

  if (!project) return null;

  const start = async () => {
    const next = await refreshPreflight();
    if (!next) return;
    if (next.hasError) {
      toast("预检有错误，先处理后再执行", "error");
      return;
    }
    if (next.hasWarning) {
      setConfirmOpen(true);
      return;
    }
    void runAll();
  };

  const openArtifact = (path: string) => {
    void reveal(path).catch(() => toast("无法定位产物，可能已被移动或删除", "error"));
  };

  const errors = report?.checks.filter((check) => check.status === "error") ?? [];
  const warnings = report?.checks.filter((check) => check.status === "warn") ?? [];

  return (
    <Page
      title="执行"
      description="按顺序完成合并、加密、打包。没有勾选内容的步骤会自动跳过；某一步失败会停下并保留日志。"
      wide
      actions={
        running ? (
          <Button appearance="primary" icon={<StopRegular />} onClick={() => void cancel()}>
            取消构建
          </Button>
        ) : (
          <Button appearance="primary" icon={<PlayRegular />} onClick={() => void start()}>
            全部执行
          </Button>
        )
      }
    >
      {running ? (
        <div className={styles.progress}>
          <Text>{progress || "正在执行…"}</Text>
        </div>
      ) : null}

      <Panel
        title="构建预检"
        description="启动前检查路径、模板、工具链与运行时；有错误会阻止执行，有警告会先确认一次。"
        actions={
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowClockwiseRegular />}
            disabled={loading}
            onClick={() => void refreshPreflight()}
          >
            重新检查
          </Button>
        }
      >
        {loading && !report ? (
          <div className={styles.progress}>
            <Spinner size="tiny" />
            正在检查…
          </div>
        ) : report ? (
          <div className={styles.checks}>
            {report.hasError ? (
              <MessageBar intent="error">
                <MessageBarBody>有 {errors.length} 项错误，修复后才能执行。</MessageBarBody>
              </MessageBar>
            ) : report.hasWarning ? (
              <MessageBar intent="warning">
                <MessageBarBody>有 {warnings.length} 项警告；开始时会再确认一次。</MessageBarBody>
              </MessageBar>
            ) : (
              <MessageBar intent="success">
                <MessageBarBody>预检通过，可以开始构建。</MessageBarBody>
              </MessageBar>
            )}
            {report.checks.map((check) => (
              <div key={check.id} className={styles.checkRow}>
                {checkIcon(check.status, styles)}
                <span className={styles.checkLabel}>{check.label}</span>
                <span className={styles.checkDetail}>{check.detail}</span>
              </div>
            ))}
          </div>
        ) : (
          <Text size={200} className={styles.muted}>
            还没有预检结果。
          </Text>
        )}
      </Panel>

      <Panel title="执行计划" flush>
        <div className={styles.list}>
          {STAGES.map((stage) => {
            const meta = STAGE_META[stage];
            const status = statuses[stage];
            const stageArtifacts = artifacts[stage] ?? [];
            return (
              <div key={stage} className={styles.row}>
                <span className={styles.index}>{meta.index}</span>
                <div className={styles.text}>
                  <span className={styles.title}>{meta.title}</span>
                  <span className={styles.hint}>{meta.hint}</span>
                  <span className={styles.summary}>{stageSummary(project, stage, ignores)}</span>
                </div>
                <div className={styles.right}>
                  <div className={styles.artifacts}>
                    {stageArtifacts.map((path) => (
                      <Button
                        key={path}
                        appearance="subtle"
                        size="small"
                        icon={<FolderOpenRegular />}
                        title={path}
                        onClick={() => openArtifact(path)}
                      >
                        {baseName(path)}
                      </Button>
                    ))}
                  </div>
                  <Badge appearance="tint" color={stageStatusColor(status)} size="small">
                    {stageStatusLabel(status)}
                  </Badge>
                  <Button
                    appearance="secondary"
                    size="small"
                    disabled={running}
                    onClick={() => void runStage(stage)}
                  >
                    {meta.action}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <Dialog open={confirmOpen} onOpenChange={(_, data) => setConfirmOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>预检有 {warnings.length} 项警告</DialogTitle>
            <DialogContent>
              <div className={styles.dialogList}>
                {warnings.map((check) => (
                  <div key={check.id}>
                    <b>{check.label}</b>：{check.detail}
                  </div>
                ))}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmOpen(false)}>
                取消
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  setConfirmOpen(false);
                  void runAll();
                }}
              >
                仍然开始
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Page>
  );
}
