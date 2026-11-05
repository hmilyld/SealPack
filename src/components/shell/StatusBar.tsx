import { useEffect, useState } from "react";
import {
  Button,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { TextBulletListLtrRegular } from "@fluentui/react-icons";

import { appVersion } from "@/api";
import { semantic } from "@/theme/semantic";
import { useBuildStore } from "@/stores/buildStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-3)",
    height: "var(--app-statusbar-h)",
    flexShrink: 0,
    padding: "0 var(--app-space-3)",
    background: tokens.colorNeutralBackground2,
    borderTop: "1px solid var(--app-border-default)",
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
  },
  tool: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--app-space-1)",
    whiteSpace: "nowrap",
  },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
  },
  spacer: {
    flex: 1,
  },
  progress: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    color: tokens.colorBrandForeground1,
  },
  version: {
    whiteSpace: "nowrap",
  },
});

export function StatusBar() {
  const styles = useStyles();
  const toolStatus = useSettingsStore((state) => state.toolStatus);
  const running = useBuildStore((state) => state.running);
  const progress = useBuildStore((state) => state.progress);
  const logOpen = useUiStore((state) => state.logOpen);
  const setLogOpen = useUiStore((state) => state.setLogOpen);
  const [version, setVersion] = useState("");

  useEffect(() => {
    void appVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <footer className={`app-statusbar ${styles.root}`}>
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

      <span className={styles.spacer} />

      {running ? (
        <span className={styles.progress}>
          <Spinner size="extra-tiny" />
          {progress || "正在执行…"}
        </span>
      ) : null}

      <Button
        appearance="subtle"
        size="small"
        icon={<TextBulletListLtrRegular />}
        onClick={() => setLogOpen(!logOpen)}
      >
        运行日志
      </Button>

      <Text className={styles.version} size={100}>
        SealPack {version || "0.2.0"} · © 2026 hmilyld
      </Text>
    </footer>
  );
}
