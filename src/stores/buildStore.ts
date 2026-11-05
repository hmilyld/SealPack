import { create } from "zustand";

import { api } from "@/api";
import type {
  BuildHistoryEntry,
  LogEvent,
  Stage,
  StageEvent,
  StageOutcome,
  StageStatus,
} from "@/types";
import { uniquePaths } from "@/util";
import { useProjectStore } from "./projectStore";

const STAGES: Stage[] = ["merge", "encrypt", "package"];
const MAX_LOGS = 5000;

const STAGE_PROGRESS: Record<Stage, string> = {
  merge: "正在合并程序集…",
  encrypt: "正在加密主程序…",
  package: "正在生成安装包…",
};

function idleStatuses(): Record<Stage, StageStatus> {
  return { merge: "idle", encrypt: "idle", package: "idle" };
}

function worstStatus(outcomes: StageOutcome[]): BuildHistoryEntry["status"] {
  if (outcomes.some((outcome) => outcome.status === "failed")) return "failed";
  if (outcomes.some((outcome) => outcome.status === "cancelled")) return "cancelled";
  if (outcomes.length === 0 || outcomes.every((outcome) => outcome.status === "skipped")) {
    return "skipped";
  }
  return "ok";
}

function recordHistory(
  projectId: string,
  scope: BuildHistoryEntry["scope"],
  startedAt: string,
  outcomes: StageOutcome[],
): void {
  const store = useProjectStore.getState();
  const project = store.current;
  // 运行期间工程列表被锁，但快捷键仍可能切走；切走了就不要把记录写到别的工程
  if (!project || project.id !== projectId) return;

  const status = worstStatus(outcomes);
  // 合并和加密都会把主程序报成产物；同一个路径只保留一次。
  const artifacts = uniquePaths(outcomes.flatMap((outcome) => outcome.artifacts));
  const packageOutcome = outcomes.find(
    (outcome) => outcome.stage === "package" && outcome.artifact !== "none",
  );
  const artifact: BuildHistoryEntry["artifact"] = packageOutcome?.artifact ?? "none";
  const message =
    outcomes
      .map((outcome) => outcome.message)
      .filter(Boolean)
      .join("；") || (status === "skipped" ? "没有可执行的阶段" : "执行结束");

  const entry: BuildHistoryEntry = {
    id: crypto.randomUUID(),
    startedAt,
    finishedAt: new Date().toISOString(),
    version: project.version,
    scope,
    artifact,
    status,
    artifacts,
    message,
  };

  const history = [entry, ...(project.buildHistory ?? [])].slice(0, 20);
  store.update({ buildHistory: history });
}

interface BuildState {
  statuses: Record<Stage, StageStatus>;
  outcomes: Partial<Record<Stage, StageOutcome>>;
  artifacts: Partial<Record<Stage, string[]>>;
  logs: LogEvent[];
  running: boolean;
  cancelled: boolean;
  progress: string;

  runStage: (stage: Stage) => Promise<StageOutcome | null>;
  runAll: () => Promise<void>;
  cancel: () => Promise<void>;

  appendLog: (event: LogEvent) => void;
  setStageStatus: (event: StageEvent) => void;
  clearLogs: () => void;
  reset: () => void;
}

let logBuffer: LogEvent[] = [];
let logFrame: number | undefined;

export const useBuildStore = create<BuildState>((set, get) => {
  const flushLogs = () => {
    logFrame = undefined;
    if (logBuffer.length === 0) return;
    const batch = logBuffer;
    logBuffer = [];
    set((state) => ({ logs: [...state.logs, ...batch].slice(-MAX_LOGS) }));
  };

  const appendLog = (event: LogEvent) => {
    logBuffer.push(event);
    if (logFrame === undefined) {
      logFrame = requestAnimationFrame(flushLogs);
    }
  };

  const execute = async (stage: Stage): Promise<StageOutcome | null> => {
    const project = useProjectStore.getState().current;
    if (!project) return null;

    set((state) => ({
      statuses: { ...state.statuses, [stage]: "running" },
      progress: STAGE_PROGRESS[stage],
    }));

    try {
      const outcome = await api.runStage(project, stage);
      // 运行期间工程列表被锁，但快捷键/程序化路径仍可能切走：写回前校验
      if (useProjectStore.getState().current?.id !== project.id) return null;

      set((state) => ({
        statuses: { ...state.statuses, [stage]: outcome.status },
        outcomes: { ...state.outcomes, [stage]: outcome },
        artifacts: { ...state.artifacts, [stage]: outcome.artifacts },
      }));
      return outcome;
    } catch (error) {
      // 后端在进入流水线之前就会拒绝（主程序不存在、工具链缺失、保存失败等）。
      // 这些错误不会经过 pipeline:log，必须在这里落到日志与历史里，否则界面只剩一个红点。
      const message = error instanceof Error ? error.message : String(error);
      if (useProjectStore.getState().current?.id === project.id) {
        set((state) => ({ statuses: { ...state.statuses, [stage]: "failed" } }));
        appendLog({ stage, stream: "system", line: message });
      }
      return {
        stage,
        status: "failed",
        artifact: "none",
        exitCode: null,
        message,
        artifacts: [],
      };
    }
  };

  return {
    statuses: idleStatuses(),
    outcomes: {},
    artifacts: {},
    logs: [],
    running: false,
    cancelled: false,
    progress: "",

    async runStage(stage) {
      if (get().running) return null;
      const project = useProjectStore.getState().current;
      if (!project) return null;
      const startedAt = new Date().toISOString();
      set({ running: true, cancelled: false, progress: "" });
      try {
        const outcome = await execute(stage);
        recordHistory(
          project.id,
          stage,
          startedAt,
          outcome
            ? [outcome]
            : [
                {
                  stage,
                  status: "failed",
                  artifact: "none",
                  exitCode: null,
                  message: "执行失败，请查看日志",
                  artifacts: [],
                },
              ],
        );
        return outcome;
      } finally {
        set({ running: false, progress: "" });
      }
    },

    async runAll() {
      if (get().running) return;
      const project = useProjectStore.getState().current;
      if (!project) return;
      const startedAt = new Date().toISOString();
      set({
        running: true,
        cancelled: false,
        statuses: idleStatuses(),
        outcomes: {},
        artifacts: {},
        progress: "",
      });
      const outcomes: StageOutcome[] = [];
      try {
        for (const stage of STAGES) {
          if (get().cancelled) break;
          const outcome = await execute(stage);
          if (!outcome) break;
          outcomes.push(outcome);
          if (outcome.status === "failed" || outcome.status === "cancelled") {
            break;
          }
        }
      } finally {
        recordHistory(project.id, "all", startedAt, outcomes);
        set({ running: false, progress: "" });
      }
    },

    async cancel() {
      if (!get().running) return;
      set({ cancelled: true, progress: "正在取消…" });
      try {
        await api.cancelBuild();
      } catch {
        // 后端尚未提供 cancel_build 时，至少让界面进入“已请求取消”的状态
      }
    },

    appendLog,
    setStageStatus(event) {
      set((state) => ({
        statuses: { ...state.statuses, [event.stage]: event.status },
      }));
    },
    clearLogs() {
      logBuffer = [];
      set({ logs: [] });
    },
    reset() {
      logBuffer = [];
      if (logFrame !== undefined) {
        cancelAnimationFrame(logFrame);
        logFrame = undefined;
      }
      set({
        statuses: idleStatuses(),
        outcomes: {},
        artifacts: {},
        logs: [],
        running: false,
        cancelled: false,
        progress: "",
      });
    },
  };
});
