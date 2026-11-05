import { useEffect } from "react";

import {
  closeWindow,
  onLog,
  onStage,
  setWindowBackground,
  windowMaterial,
} from "@/api";
import { installDesktopBehaviour, registerShortcut, revealWindowWhenReady } from "@/desktop";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { STEP_ORDER } from "@/types";
import { WINDOW_BG } from "@/theme/colors";
import { ThemeProvider, useTheme } from "@/theme/ThemeProvider";
import { ToastProvider, useToast } from "@/components/feedback/ToastProvider";
import { ContextMenuProvider } from "@/components/common/ContextMenu";
import { NewProjectDialog } from "@/components/dialogs/NewProjectDialog";
import { SettingsDialog } from "@/components/dialogs/SettingsDialog";
import { AppShell } from "@/components/shell/AppShell";
import { ResizeZones } from "@/components/shell/ResizeZones";

function AppContent() {
  const toast = useToast();
  const { resolved } = useTheme();
  const currentId = useProjectStore((state) => state.current?.id);

  // 桌面化行为：拦浏览器快捷键、拖拽、缩放、原生右键菜单
  useEffect(() => installDesktopBehaviour(), []);

  // 快捷键：设置、关闭、步骤切换
  useEffect(() => {
    const dispose = [
      registerShortcut("mod+,", () => useUiStore.getState().setSettingsOpen(true)),
      registerShortcut("mod+w", () => void closeWindow().catch(() => {})),
      registerShortcut("alt+arrowright", () => {
        const { step, setStep } = useUiStore.getState();
        const index = STEP_ORDER.indexOf(step);
        if (index < STEP_ORDER.length - 1) setStep(STEP_ORDER[index + 1]!);
      }),
      registerShortcut("alt+arrowleft", () => {
        const { step, setStep } = useUiStore.getState();
        const index = STEP_ORDER.indexOf(step);
        if (index > 0) setStep(STEP_ORDER[index - 1]!);
      }),
    ];
    return () => dispose.forEach((off) => off());
  }, []);

  // 首次启动：读取设置、工具链、工程列表
  useEffect(() => {
    void useSettingsStore
      .getState()
      .refresh()
      .catch((error: unknown) => {
        toast(`初始化失败：${error instanceof Error ? error.message : String(error)}`, "error");
      });
    void useProjectStore
      .getState()
      .refresh()
      .catch((error: unknown) => {
        toast(`读取工程列表失败：${error instanceof Error ? error.message : String(error)}`, "error");
      });
  }, [toast]);

  // 切换工程：重置扫描/执行状态，再按新工程扫描目录与排除项
  useEffect(() => {
    if (!currentId) return;
    const workspace = useWorkspaceStore.getState();
    workspace.reset();
    void workspace.ensureTree();
    void workspace.refreshIgnores();
  }, [currentId]);

  // 运行日志与阶段事件
  //
  // Tauri 的 listen() 是异步的：StrictMode 下 effect 会 mount → cleanup → mount。
  // 如果第一轮的 Promise 在 cleanup 之后才 resolve，直接丢掉 offLog 会留下一个
  // 监听器；第二轮再注册一次，日志就会每行出现两次。用 disposed 兜住这个窗口。
  useEffect(() => {
    let disposed = false;
    let offLog: (() => void) | undefined;
    let offStage: (() => void) | undefined;
    void onLog((event) => useBuildStore.getState().appendLog(event))
      .then((unlisten) => {
        if (disposed) unlisten();
        else offLog = unlisten;
      })
      .catch((error) => console.error("订阅运行日志失败", error));
    void onStage((event) => useBuildStore.getState().setStageStatus(event))
      .then((unlisten) => {
        if (disposed) unlisten();
        else offStage = unlisten;
      })
      .catch((error) => console.error("订阅阶段事件失败", error));
    return () => {
      disposed = true;
      offLog?.();
      offStage?.();
    };
  }, []);

  // 窗口底色跟随主题，避免缩放/最大化时露出旧底色
  useEffect(() => {
    void setWindowBackground(
      resolved === "dark" ? WINDOW_BG.dark : WINDOW_BG.light,
    ).catch(() => {});
  }, [resolved]);

  // 窗口材质 + 首帧显示
  useEffect(() => {
    void windowMaterial()
      .then((active) => {
        document.documentElement.dataset.material = active ? "on" : "off";
      })
      .catch(() => {
        document.documentElement.dataset.material = "off";
      });
    revealWindowWhenReady();
  }, []);

  return (
    <ContextMenuProvider>
      <AppShell />
      <NewProjectDialog />
      <SettingsDialog />
      <ResizeZones />
    </ContextMenuProvider>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ThemeProvider>
  );
}
