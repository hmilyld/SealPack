import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

import { STEP_META, STEP_ORDER, type StepId } from "@/types";
import { encryptSummary, mergeSummary, packageSummary } from "@/lib/summaries";
import { baseName } from "@/util";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexShrink: 0,
    height: "var(--app-stepnav-h)",
    padding: "0 var(--app-space-4)",
    background: tokens.colorNeutralBackground2,
    borderBottom: "1px solid var(--app-border-default)",
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: "0 var(--app-space-3)",
    border: "none",
    borderBottom: "2px solid transparent",
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
  tabActive: {
    borderBottomColor: tokens.colorBrandBackground,
    ":hover": {
      background: "transparent",
    },
  },
  num: {
    display: "grid",
    placeItems: "center",
    width: "var(--app-icon-box)",
    height: "var(--app-icon-box)",
    flexShrink: 0,
    borderRadius: "50%",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground2,
    fontSize: "var(--app-font-meta)",
    fontWeight: 600,
  },
  numActive: {
    border: `1px solid ${tokens.colorBrandBackground}`,
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  text: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: "var(--app-space-1)",
    minWidth: 0,
    flex: 1,
  },
  title: {
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
    lineHeight: "var(--app-line-body)",
    color: tokens.colorNeutralForeground1,
  },
  sub: {
    width: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--app-font-meta)",
    lineHeight: "var(--app-line-meta)",
    color: tokens.colorNeutralForeground3,
  },
});

export function StepNav() {
  const styles = useStyles();
  const step = useUiStore((state) => state.step);
  const setStep = useUiStore((state) => state.setStep);
  const project = useProjectStore((state) => state.current);
  const ignores = useWorkspaceStore((state) => state.ignores);
  const statuses = useBuildStore((state) => state.statuses);
  const running = useBuildStore((state) => state.running);

  const summary = (id: StepId): string => {
    if (!project) return id === "setup" ? "未选择主程序" : "先选择主程序";
    switch (id) {
      case "setup":
        return baseName(project.exeFile) || "未选择主程序";
      case "merge":
        return mergeSummary(project);
      case "encrypt":
        return encryptSummary(project);
      case "package":
        return packageSummary(project, ignores);
      case "run": {
        if (running) return "执行中…";
        const values = Object.values(statuses);
        if (values.includes("failed")) return "有失败";
        if (values.every((value) => value === "ok" || value === "skipped")) return "已完成";
        return "待执行";
      }
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = STEP_ORDER.indexOf(step);
    let next = index;
    switch (event.key) {
      case "ArrowRight":
        next = Math.min(STEP_ORDER.length - 1, index + 1);
        break;
      case "ArrowLeft":
        next = Math.max(0, index - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = STEP_ORDER.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = STEP_ORDER[next]!;
    setStep(target);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-step="${target}"]`)
      ?.focus();
  };

  return (
    <div className={styles.root} role="tablist" aria-label="操作步骤" onKeyDown={onKeyDown}>
      {STEP_ORDER.map((id) => {
        const meta = STEP_META[id];
        const active = step === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            data-step={id}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={mergeClasses(styles.tab, active && styles.tabActive)}
            title={meta.hint}
            onClick={() => setStep(id)}
          >
            <span className={mergeClasses(styles.num, active && styles.numActive)}>
              {meta.index}
            </span>
            <span className={styles.text}>
              <span className={styles.title}>{meta.title}</span>
              <span className={styles.sub}>{summary(id)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
