import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { AddRegular } from "@fluentui/react-icons";

import { useProjectStore } from "@/stores/projectStore";
import { useUiStore } from "@/stores/uiStore";
import { EncryptStep } from "./EncryptStep";
import { MergeStep } from "./MergeStep";
import { PackageStep } from "./PackageStep";
import { RunStep } from "./RunStep";
import { SetupStep } from "./SetupStep";

const useStyles = makeStyles({
  empty: {
    display: "grid",
    placeItems: "center",
    height: "100%",
    padding: "var(--app-space-6)",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--app-space-3)",
    maxWidth: "420px",
    padding: "var(--app-space-7)",
    textAlign: "center",
    border: "1px solid var(--app-border-default)",
    borderRadius: "var(--app-radius-lg)",
    background: tokens.colorNeutralBackground1,
  },
  title: {
    fontFamily: "var(--app-font-display)",
    fontSize: "var(--app-font-heading)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  description: {
    fontSize: "var(--app-font-body)",
    lineHeight: "var(--app-line-body-lg)",
    color: tokens.colorNeutralForeground3,
  },
});

function EmptyWorkspace() {
  const styles = useStyles();
  const setNewProjectOpen = useUiStore((state) => state.setNewProjectOpen);
  return (
    <div className={styles.empty}>
      <div className={styles.card}>
        <Text as="h1" className={styles.title}>
          还没有工程
        </Text>
        <span className={styles.description}>
          新建一个工程，选好主程序，就能开始合并、加密与打包。
        </span>
        <Button
          appearance="primary"
          icon={<AddRegular />}
          onClick={() => setNewProjectOpen(true)}
        >
          新建工程
        </Button>
      </div>
    </div>
  );
}

export function Workspace() {
  const step = useUiStore((state) => state.step);
  const project = useProjectStore((state) => state.current);

  if (!project) return <EmptyWorkspace />;

  switch (step) {
    case "setup":
      return <SetupStep />;
    case "merge":
      return <MergeStep />;
    case "encrypt":
      return <EncryptStep />;
    case "package":
      return <PackageStep />;
    case "run":
      return <RunStep />;
  }
}
