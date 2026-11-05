import { makeStyles, tokens } from "@fluentui/react-components";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { useUiStore } from "@/stores/uiStore";
import { LogDrawer } from "./LogDrawer";
import { ProjectRail } from "./ProjectRail";
import { StatusBar } from "./StatusBar";
import { StepNav } from "./StepNav";
import { TitleBar } from "./TitleBar";
import { Workspace } from "../steps/Workspace";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  panels: {
    flex: 1,
    minHeight: 0,
  },
  body: {
    display: "flex",
    height: "100%",
    minHeight: 0,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    // Windows 11 的「画布 / 卡片」层级：外壳与页面底是灰色，内容面板是白色。
    background: tokens.colorNeutralBackground2,
  },
  workspace: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
  },
  handle: {
    height: "var(--app-space-1)",
    background: "transparent",
    transition: `background ${tokens.durationFast} ${tokens.curveEasyEase}`,
    ":hover": {
      background: tokens.colorBrandBackground2,
    },
  },
});

export function AppShell() {
  const styles = useStyles();
  const logOpen = useUiStore((state) => state.logOpen);

  return (
    <div className={`app-root ${styles.root}`}>
      <TitleBar />
      <PanelGroup direction="vertical" className={`app-body ${styles.panels}`}>
        <Panel defaultSize={82} minSize={40}>
          <div className={styles.body}>
            <ProjectRail />
            <main className={`app-main ${styles.main}`}>
              <StepNav />
              <div className={styles.workspace}>
                <Workspace />
              </div>
            </main>
          </div>
        </Panel>
        {logOpen ? (
          <>
            <PanelResizeHandle className={styles.handle} />
            <Panel defaultSize={18} minSize={10} maxSize={50}>
              <LogDrawer />
            </Panel>
          </>
        ) : null}
      </PanelGroup>
      <StatusBar />
    </div>
  );
}
