import { useEffect, useState } from "react";
import {
  Button,
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowMinimizeRegular,
  DesktopRegular,
  DismissRegular,
  SettingsRegular,
  SquareRegular,
  SubtractRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
} from "@fluentui/react-icons";

import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from "@/api";
import { useProjectStore } from "@/stores/projectStore";
import { useUiStore } from "@/stores/uiStore";
import { semantic } from "@/theme/semantic";
import { useTheme, type ThemeMode } from "@/theme/ThemeProvider";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    height: "var(--app-titlebar-h)",
    flexShrink: 0,
    paddingLeft: "var(--app-space-3)",
    background: tokens.colorNeutralBackground2,
    borderBottom: "1px solid var(--app-border-default)",
    userSelect: "none",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    paddingRight: "var(--app-space-1)",
  },
  mark: {
    display: "grid",
    placeItems: "center",
    width: "var(--app-mark-size)",
    height: "var(--app-mark-size)",
    borderRadius: "var(--app-radius-sm)",
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: "var(--app-font-meta)",
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
  brandName: {
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  project: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    minWidth: 0,
    marginLeft: "4px",
    paddingLeft: "var(--app-space-3)",
    borderLeft: "1px solid var(--app-border-subtle)",
    color: tokens.colorNeutralForeground2,
  },
  projectName: {
    maxWidth: "260px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  saveState: {
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-meta)",
    whiteSpace: "nowrap",
  },
  spacer: {
    flex: 1,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-1)",
    paddingRight: "var(--app-space-1)",
  },
  caption: {
    display: "flex",
    alignItems: "stretch",
    height: "var(--app-titlebar-h)",
    marginLeft: "4px",
  },
  captionButton: {
    display: "grid",
    placeItems: "center",
    width: "var(--app-caption-w)",
    height: "var(--app-titlebar-h)",
    padding: 0,
    border: "none",
    background: "transparent",
    color: tokens.colorNeutralForeground1,
    cursor: "default",
    ":hover": {
      background: tokens.colorNeutralBackground3Hover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  closeButton: {
    ":hover": {
      background: semantic.closeHover,
      color: semantic.closeHoverInk,
    },
  },
});

export function TitleBar() {
  const styles = useStyles();
  const project = useProjectStore((state) => state.current);
  const saveState = useProjectStore((state) => state.saveState);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const { mode, setMode } = useTheme();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void onWindowResized(() => {
      void isWindowMaximized()
        .then(setMaximized)
        .catch((error) => console.error("读取窗口状态失败", error));
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch((error) => console.error("订阅窗口尺寸失败", error));
    void isWindowMaximized()
      .then(setMaximized)
      .catch((error) => console.error("读取窗口状态失败", error));
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  const saveLabel =
    saveState === "saving"
      ? "保存中…"
      : saveState === "saved"
        ? "已保存"
        : saveState === "error"
          ? "保存失败"
          : "";

  return (
    <header className={`app-titlebar ${styles.root}`} data-tauri-drag-region="deep">
      <div className={styles.brand}>
        <span className={styles.mark}>SP</span>
        <span className={styles.brandName}>SealPack</span>
      </div>

      <div className={styles.project}>
        <Text size={300} className={styles.projectName}>
          {project ? project.name : "未选择工程"}
        </Text>
        {saveLabel ? <span className={styles.saveState}>{saveLabel}</span> : null}
      </div>

      <div className={styles.spacer} />

      <div className={styles.actions}>
        <Menu
          hasCheckmarks
          checkedValues={{ theme: [mode] }}
          onCheckedValueChange={(_, data) => {
            if (data.name === "theme" && data.checkedItems[0]) {
              setMode(data.checkedItems[0] as ThemeMode);
            }
          }}
        >
          <MenuTrigger disableButtonEnhancement>
            <Button
              appearance="subtle"
              size="small"
              icon={
                mode === "system" ? (
                  <DesktopRegular />
                ) : mode === "dark" ? (
                  <WeatherMoonRegular />
                ) : (
                  <WeatherSunnyRegular />
                )
              }
              title="主题"
              aria-label="主题"
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItemRadio name="theme" value="system">
                跟随系统
              </MenuItemRadio>
              <MenuItemRadio name="theme" value="light">
                浅色
              </MenuItemRadio>
              <MenuItemRadio name="theme" value="dark">
                深色
              </MenuItemRadio>
            </MenuList>
          </MenuPopover>
        </Menu>

        <Button
          appearance="subtle"
          size="small"
          icon={<SettingsRegular />}
          title="设置 (Ctrl+,)"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
        />
      </div>

      <div className={styles.caption}>
        <button
          type="button"
          className={styles.captionButton}
          title="最小化"
          aria-label="最小化"
          onClick={() => void minimizeWindow().catch(() => {})}
        >
          <SubtractRegular />
        </button>
        <button
          type="button"
          className={styles.captionButton}
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => {
            void toggleMaximizeWindow()
              .then(setMaximized)
              .catch(() => {});
          }}
        >
          {maximized ? <ArrowMinimizeRegular /> : <SquareRegular />}
        </button>
        <button
          type="button"
          className={mergeClasses(styles.captionButton, styles.closeButton)}
          title="关闭"
          aria-label="关闭"
          onClick={() => void closeWindow().catch(() => {})}
        >
          <DismissRegular />
        </button>
      </div>
    </header>
  );
}
