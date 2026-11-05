import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Badge,
  Button,
  Checkbox,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  ArrowResetRegular,
  DocumentRegular,
  FolderOpenRegular,
} from "@fluentui/react-icons";

import { Panel } from "@/components/common/Panel";
import { formatBytes } from "@/lib/format";
import { semantic } from "@/theme/semantic";
import type { UpgradeDiffEntry, UpgradeFileStatus, UpgradePlan } from "@/types";

const useStyles = makeStyles({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-3)",
  },
  baseline: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--app-space-3)",
    padding: "var(--app-space-3)",
    borderRadius: "var(--app-radius-md)",
    border: "1px solid var(--app-border-default)",
    background: tokens.colorNeutralBackground2,
  },
  baselineText: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
    minWidth: 0,
    flex: 1,
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground2,
  },
  baselineTitle: {
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  path: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-meta)",
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    flexShrink: 0,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  stats: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: "var(--app-space-2)",
  },
  stat: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
    padding: "var(--app-space-2) var(--app-space-3)",
    borderRadius: "var(--app-radius-sm)",
    border: "1px solid var(--app-border-default)",
    background: tokens.colorNeutralBackground1,
    minWidth: 0,
  },
  statLabel: {
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
  },
  statValue: {
    fontSize: "var(--app-font-heading)",
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
  },
  newValue: { color: semantic.success },
  modifiedValue: { color: semantic.warning },
  deletedValue: { color: semantic.danger },
  unchangedValue: { color: tokens.colorNeutralForeground3 },
  listHead: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-3)",
    minHeight: "24px",
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "320px",
    overflow: "auto",
    border: "1px solid var(--app-border-default)",
    borderRadius: "var(--app-radius-md)",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-3)",
    minHeight: "var(--app-row-h)",
    padding: "0 var(--app-space-3)",
    borderBottom: "1px solid var(--app-border-subtle)",
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground2,
  },
  rowPath: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground1,
  },
  rowSize: {
    width: "96px",
    textAlign: "right",
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-meta)",
  },
  group: {
    padding: "var(--app-space-1) var(--app-space-3)",
    background: tokens.colorNeutralBackground2,
    borderBottom: "1px solid var(--app-border-subtle)",
    fontSize: "var(--app-font-meta)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
  },
  empty: {
    padding: "var(--app-space-4)",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-small)",
  },
  center: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    padding: "var(--app-space-4)",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-small)",
  },
});

interface UpgradePanelProps {
  plan: UpgradePlan | null;
  loading: boolean;
  error: string;
  disabled?: boolean;
  onRefresh: () => void;
  onPickManifest: () => void;
  onPickDirectory: () => void;
  onAuto: () => void;
}

const GROUPS: { status: UpgradeFileStatus; label: string; color: "success" | "warning" | "danger" | "subtle" }[] = [
  { status: "new", label: "新增", color: "success" },
  { status: "modified", label: "修改", color: "warning" },
  { status: "deleted", label: "删除", color: "danger" },
  { status: "unchanged", label: "未变", color: "subtle" },
];

type DiffRowItem =
  | { kind: "group"; key: string; label: string; count: number }
  | { kind: "file"; key: string; file: UpgradeDiffEntry };

function statusLabel(status: UpgradeFileStatus): string {
  return GROUPS.find((group) => group.status === status)?.label ?? status;
}

function statusColor(status: UpgradeFileStatus): "success" | "warning" | "danger" | "subtle" {
  return GROUPS.find((group) => group.status === status)?.color ?? "subtle";
}

function formatTime(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("zh-CN");
}

export function UpgradePanel({
  plan,
  loading,
  error,
  disabled,
  onRefresh,
  onPickManifest,
  onPickDirectory,
  onAuto,
}: UpgradePanelProps) {
  const styles = useStyles();
  const [showUnchanged, setShowUnchanged] = useState(false);

  const rows = useMemo<DiffRowItem[]>(() => {
    const files = plan?.files ?? [];
    const out: DiffRowItem[] = [];
    for (const group of GROUPS) {
      const groupFiles = files.filter(
        (file) => file.status === group.status && (showUnchanged || file.status !== "unchanged"),
      );
      if (groupFiles.length === 0) continue;
      out.push({
        kind: "group",
        key: `group:${group.status}`,
        label: group.label,
        count: groupFiles.length,
      });
      for (const file of groupFiles) {
        out.push({ kind: "file", key: `${group.status}:${file.path}`, file });
      }
    }
    return out;
  }, [plan?.files, showUnchanged]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === "group" ? 24 : 30),
    overscan: 12,
  });

  const baseline = plan?.baseline;
  const fatal = error || plan?.error || "";
  const warnings = plan?.warnings ?? [];

  return (
    <Panel
      title="升级差异"
      description="升级包按基线自动计算：新增 / 修改进包，删除项写入 [InstallDelete]，未变化文件不重复打包。"
      actions={
        <Button
          appearance="secondary"
          size="small"
          icon={<ArrowClockwiseRegular />}
          disabled={loading || disabled}
          onClick={onRefresh}
        >
          刷新
        </Button>
      }
    >
      <div className={styles.body}>
        <div className={styles.baseline}>
          <div className={styles.baselineText}>
            {loading ? (
              <div className={styles.center}>
                <Spinner size="tiny" />
                正在计算升级差异…
              </div>
            ) : baseline ? (
              <>
                <span className={styles.baselineTitle}>
                  {baseline.source === "directory" ? "旧版本目录" : "基线清单"}
                  {baseline.version ? ` · ${baseline.version}` : ""}
                </span>
                <span>
                  {baseline.fileCount} 个文件 · {formatBytes(baseline.totalBytes)} ·{" "}
                  {formatTime(baseline.createdAt)}
                </span>
                <span className={styles.path} title={baseline.path}>
                  {baseline.path}
                </span>
              </>
            ) : (
              <>
                <span className={styles.baselineTitle}>还没有基线</span>
                <span>先打一次完整安装包，或手动选择旧版本清单 / 目录。</span>
              </>
            )}
          </div>
          <div className={styles.controls}>
            <Button
              appearance="secondary"
              size="small"
              icon={<DocumentRegular />}
              disabled={disabled}
              onClick={onPickManifest}
            >
              选清单
            </Button>
            <Button
              appearance="secondary"
              size="small"
              icon={<FolderOpenRegular />}
              disabled={disabled}
              onClick={onPickDirectory}
            >
              选目录
            </Button>
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowResetRegular />}
              disabled={disabled}
              onClick={onAuto}
            >
              自动
            </Button>
          </div>
        </div>

        {fatal ? (
          <MessageBar intent="error">
            <MessageBarBody>{fatal}</MessageBarBody>
          </MessageBar>
        ) : null}

        {warnings.map((warning) => (
          <MessageBar key={warning} intent="warning">
            <MessageBarBody>{warning}</MessageBarBody>
          </MessageBar>
        ))}

        {plan ? (
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>新增</span>
              <span className={mergeClasses(styles.statValue, styles.newValue)}>
                {plan.newCount}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>修改</span>
              <span className={mergeClasses(styles.statValue, styles.modifiedValue)}>
                {plan.modifiedCount}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>删除</span>
              <span className={mergeClasses(styles.statValue, styles.deletedValue)}>
                {plan.deletedCount}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>未变</span>
              <span className={mergeClasses(styles.statValue, styles.unchangedValue)}>
                {plan.unchangedCount}
              </span>
            </div>
          </div>
        ) : null}

        {plan ? (
          <>
            <div className={styles.listHead}>
              <Text size={100} className={styles.grow}>
                升级包将包含 {plan.newCount + plan.modifiedCount} 个文件 ·{" "}
                {formatBytes(plan.totalBytes)}
              </Text>
              <Checkbox
                checked={showUnchanged}
                onChange={(_, data) => setShowUnchanged(Boolean(data.checked))}
                label="显示未变化"
              />
            </div>
            <div className={styles.list} ref={scrollRef}>
              {rows.length === 0 ? (
                <div className={styles.empty}>没有可显示的差异</div>
              ) : (
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualizer.getVirtualItems().map((item) => {
                    const row = rows[item.index];
                    if (!row) return null;
                    return (
                      <div
                        key={row.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${item.start}px)`,
                        }}
                      >
                        {row.kind === "group" ? (
                          <div className={styles.group}>
                            {row.label} · {row.count}
                          </div>
                        ) : (
                          <DiffRow file={row.file} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function DiffRow({ file }: { file: UpgradeDiffEntry }) {
  const styles = useStyles();
  return (
    <div className={styles.row}>
      <Badge appearance="tint" size="small" color={statusColor(file.status)}>
        {statusLabel(file.status)}
      </Badge>
      <span className={styles.rowPath} title={file.path}>
        {file.path}
      </span>
      <span className={styles.rowSize}>
        {file.status === "deleted" ? formatBytes(file.oldSize) : formatBytes(file.size)}
      </span>
    </div>
  );
}
