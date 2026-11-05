import { useEffect, useRef, useState } from "react";
import {
  Button,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  BroomRegular,
  ChevronDownRegular,
  CopyRegular,
} from "@fluentui/react-icons";
import { useVirtualizer } from "@tanstack/react-virtual";

import { api, pickSavePath, reveal } from "@/api";
import { useContextMenu } from "@/components/common/ContextMenu";
import { useToast } from "@/components/feedback/ToastProvider";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUiStore } from "@/stores/uiStore";
import type { Stage } from "@/types";

const STAGE_LABEL: Record<Stage, string> = {
  merge: "合并",
  encrypt: "加密",
  package: "打包",
};

// 与 src/styles/tokens.css 的 --app-log-row-h 保持一致（虚拟滚动需要数字）
const ROW_HEIGHT = 20;

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: tokens.colorNeutralBackground1,
    borderTop: "1px solid var(--app-border-default)",
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    height: "var(--app-log-head-h)",
    flexShrink: 0,
    padding: "0 var(--app-space-3)",
    borderBottom: "1px solid var(--app-border-subtle)",
  },
  title: {
    fontSize: "var(--app-font-small)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
  },
  count: {
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
  },
  spacer: {
    flex: 1,
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    background: tokens.colorNeutralBackground2,
    fontFamily: "var(--app-font-mono)",
    fontSize: "var(--app-font-small)",
    lineHeight: `${ROW_HEIGHT}px`,
    userSelect: "text",
  },
  inner: {
    position: "relative",
    width: "100%",
  },
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    display: "flex",
    gap: "var(--app-space-2)",
    padding: "0 var(--app-space-3)",
    whiteSpace: "pre",
  },
  stage: {
    flexShrink: 0,
    width: "36px",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-meta)",
  },
  stderr: {
    color: tokens.colorPaletteRedForeground1,
  },
  system: {
    color: tokens.colorBrandForeground1,
  },
  empty: {
    display: "grid",
    placeItems: "center",
    height: "100%",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-small)",
  },
});

export function LogDrawer() {
  const styles = useStyles();
  const toast = useToast();
  const { openMenu } = useContextMenu();
  const logs = useBuildStore((state) => state.logs);
  const clearLogs = useBuildStore((state) => state.clearLogs);
  const project = useProjectStore((state) => state.current);
  const setLogOpen = useUiStore((state) => state.setLogOpen);
  const parentRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  useEffect(() => {
    if (!atBottom || logs.length === 0) return;
    virtualizer.scrollToIndex(logs.length - 1, { align: "end" });
  }, [logs.length, atBottom, virtualizer]);

  const text = () =>
    logs.map((event) => `[${STAGE_LABEL[event.stage]}/${event.stream}] ${event.line}`).join("\r\n");

  const save = async () => {
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, "-")
      .slice(0, 19);
    const safeName = (project?.name || "sealpack").replace(/[\\/:*?"<>|]/g, "_");
    try {
      const path = await pickSavePath("保存运行日志", `${safeName}-${stamp}.txt`, [
        { name: "文本文件", extensions: ["txt"] },
      ]);
      if (!path) return;
      const header = [
        `SealPack 运行日志`,
        `工程：${project?.name ?? "-"}`,
        `版本：${project?.version ?? "-"}`,
        `时间：${new Date().toLocaleString()}`,
        "",
      ].join("\r\n");
      await api.saveLog(path, `${header}${text()}\r\n`);
      toast("日志已保存", "success");
      void reveal(path).catch(() => {});
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      toast("日志已复制", "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  return (
    <section
      className={styles.root}
      aria-label="运行日志"
      onContextMenu={(event) =>
        openMenu(
          [
            {
              id: "copy-log",
              label: "复制全部输出",
              icon: <CopyRegular />,
              onSelect: () => void copy(),
            },
            {
              id: "save-log",
              label: "保存日志…",
              icon: <ArrowDownloadRegular />,
              onSelect: () => void save(),
            },
            { id: "sep", separator: true },
            {
              id: "clear-log",
              label: "清空日志",
              icon: <BroomRegular />,
              onSelect: clearLogs,
            },
          ],
          event,
        )
      }
    >
      <div className={styles.head}>
        <Text className={styles.title}>运行日志</Text>
        <span className={styles.count}>{logs.length} 行</span>
        <span className={styles.spacer} />
        <Button appearance="subtle" size="small" icon={<ArrowDownloadRegular />} onClick={() => void save()}>
          保存
        </Button>
        <Button appearance="subtle" size="small" icon={<CopyRegular />} onClick={() => void copy()}>
          复制
        </Button>
        <Button appearance="subtle" size="small" icon={<BroomRegular />} onClick={clearLogs}>
          清空
        </Button>
        <Button
          appearance="subtle"
          size="small"
          icon={<ChevronDownRegular />}
          onClick={() => setLogOpen(false)}
        >
          折叠
        </Button>
      </div>

      {logs.length === 0 ? (
        <div className={styles.empty}>暂无输出。执行任意阶段后，命令行回显会实时出现在这里。</div>
      ) : (
        <div
          ref={parentRef}
          className={styles.body}
          onScroll={(event) => {
            const el = event.currentTarget;
            setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
          }}
        >
          <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const event = logs[item.index]!;
              return (
                <div
                  key={item.key}
                  className={mergeClasses(
                    styles.row,
                    event.stream === "stderr" && styles.stderr,
                    event.stream === "system" && styles.system,
                  )}
                  style={{ transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
                >
                  <span className={styles.stage}>{STAGE_LABEL[event.stage]}</span>
                  <span>{event.line}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
