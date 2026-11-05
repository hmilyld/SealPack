import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Tab,
  TabList,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { ArrowDownloadRegular, FolderOpenRegular } from "@fluentui/react-icons";

import { appVersion, openExternal, pickToolExe } from "@/api";
import { useToast } from "@/components/feedback/ToastProvider";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";
import type { Settings } from "@/types";

const FIELD_OF_TOOL: Record<string, keyof Settings> = {
  ilmerge: "ilmergePath",
  confuser: "confuserPath",
  iscc: "isccPath",
};

const useStyles = makeStyles({
  surface: {
    width: "760px",
    maxWidth: "92vw",
    height: "760px",
    maxHeight: "86vh",
    // Fluent 的 DialogSurface 默认是 block；不改成 flex 的话，DialogBody 的
    // flex:1 不会生效，内容会把 footer 顶到对话框外面。
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    // 打开时把焦点放在对话框容器上；容器不是控件，不需要焦点框。
    outline: "none",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-3)",
    minHeight: 0,
    flex: 1,
  },
  tabs: {
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    paddingRight: "var(--app-space-1)",
    paddingBottom: "var(--app-space-2)",
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-4)",
  },
  toolHead: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
  },
  toolMeta: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
    fontSize: "var(--app-font-meta)",
    color: tokens.colorNeutralForeground3,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    justifyContent: "flex-end",
    paddingTop: "var(--app-space-3)",
    borderTop: "1px solid var(--app-border-subtle)",
  },
  toolSection: {
    paddingTop: "var(--app-space-3)",
    borderTop: "1px solid var(--app-border-subtle)",
  },
  mono: {
    fontFamily: "var(--app-font-mono)",
    fontSize: "var(--app-font-small)",
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

export function SettingsDialog() {
  const styles = useStyles();
  const toast = useToast();
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const toolStatus = useSettingsStore((state) => state.toolStatus);
  const saved = useSettingsStore((state) => state.settings);
  const runtime = useSettingsStore((state) => state.runtime);
  const save = useSettingsStore((state) => state.save);
  const download = useSettingsStore((state) => state.download);
  const refresh = useSettingsStore((state) => state.refresh);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"tools" | "runtime" | "about">("tools");
  const [draft, setDraft] = useState<Settings>({
    ilmergePath: "",
    confuserPath: "",
    isccPath: "",
  });
  const [version, setVersion] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [saving, setSaving] = useState(false);

  // 只在打开时刷新一次；不能把 `saved` 放进依赖里 —— refresh 会写入新的
  // settings 对象，依赖变化会再次触发 refresh，形成无限循环。
  useEffect(() => {
    if (!open) return;
    void refresh().catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), "error");
    });
  }, [open, refresh, toast]);

  useEffect(() => {
    if (open && saved) setDraft(saved);
  }, [open, saved]);

  // Fluent 的焦点陷阱默认落在第一个可聚焦元素（第一个 tab）上，会立刻画出
  // 一圈焦点框。打开时先把焦点放到对话框容器，用户按 Tab 再进入 tab。
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      surfaceRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    void appVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const items = useMemo(() => toolStatus?.items ?? [], [toolStatus]);

  const browse = async (key: string) => {
    const field = FIELD_OF_TOOL[key];
    if (!field) return;
    const picked = await pickToolExe(`选择 ${key} 可执行文件`).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), "error");
      return null;
    });
    if (picked) setDraft((current) => ({ ...current, [field]: picked }));
  };

  const doDownload = async (key: string) => {
    setBusyKey(key);
    try {
      await download(key);
      toast("工具已就绪", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyKey("");
    }
  };

  const submit = async () => {
    setSaving(true);
    try {
      await save(draft);
      toast("设置已保存", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
      <DialogSurface ref={surfaceRef} className={styles.surface}>
        <DialogBody className={styles.body}>
          <DialogTitle>设置</DialogTitle>
          <DialogContent className={styles.content}>
            <div className={styles.body}>
              <TabList
                className={styles.tabs}
                selectedValue={tab}
                onTabSelect={(_, data) => setTab(data.value as typeof tab)}
              >
                <Tab value="tools">工具链</Tab>
                <Tab value="runtime">运行环境</Tab>
                <Tab value="about">关于</Tab>
              </TabList>

              {tab === "tools" ? (
                <div className={styles.stack}>
                  {items.map((item, index) => {
                    const field = FIELD_OF_TOOL[item.key];
                    const downloadInfo = item.download;
                    return (
                      <div
                        key={item.key}
                        className={mergeClasses(styles.stack, index > 0 && styles.toolSection)}
                      >
                        <div className={styles.toolHead}>
                          <Text weight="semibold">{item.label}</Text>
                          <Badge
                            appearance="tint"
                            color={item.available ? "success" : "danger"}
                            size="small"
                          >
                            {item.available ? "可用" : "未找到"}
                          </Badge>
                          <Badge appearance="outline" size="small">
                            {item.origin === "custom"
                              ? "自定义"
                              : item.origin === "bundled"
                                ? "内置"
                                : "已下载"}
                          </Badge>
                          {downloadInfo ? (
                            <Text size={100} className={styles.toolMeta}>
                              下载版本 {downloadInfo.version} · {downloadInfo.origin}
                            </Text>
                          ) : null}
                        </div>
                        {field ? (
                          <Field label="可执行文件路径" hint="留空则按「用户设置 > 内置 > 下载目录」的顺序解析。">
                            <div className={styles.row}>
                              <Input
                                className={styles.grow}
                                value={draft[field]}
                                onChange={(_, data) =>
                                  setDraft((current) => ({ ...current, [field]: data.value }))
                                }
                                placeholder={item.defaultPath}
                              />
                              <Button
                                appearance="secondary"
                                icon={<FolderOpenRegular />}
                                onClick={() => void browse(item.key)}
                              >
                                浏览
                              </Button>
                              {downloadInfo ? (
                                <Button
                                  appearance="secondary"
                                  icon={<ArrowDownloadRegular />}
                                  disabled={busyKey === item.key}
                                  onClick={() => void doDownload(item.key)}
                                >
                                  {busyKey === item.key ? "处理中…" : "下载"}
                                </Button>
                              ) : null}
                            </div>
                          </Field>
                        ) : null}
                        <Text className={mergeClasses(styles.mono, styles.muted)}>
                          {item.path}
                        </Text>
                      </div>
                    );
                  })}
                  <Text size={100} className={styles.muted}>
                    工具解析顺序：用户设置 &gt; 应用内置 &gt; 用户下载目录。内置目录在 Program Files
                    下只读，自动下载的工具会落到用户目录。
                  </Text>
                </div>
              ) : null}

              {tab === "runtime" ? (
                <div className={styles.stack}>
                  <Field label=".NET Framework">
                    <div className={styles.row}>
                      <Badge
                        appearance="tint"
                        color={runtime?.dotnetAvailable ? "success" : "warning"}
                        size="small"
                      >
                        {runtime?.dotnetAvailable ? "已安装" : "未检测到"}
                      </Badge>
                      <Text>{runtime?.dotnetDisplay || "正在检测…"}</Text>
                    </div>
                  </Field>
                  <Text size={200} className={styles.muted}>
                    ILMerge 与 ConfuserEx 依赖 .NET Framework 4.x；Inno Setup 不依赖它。
                  </Text>
                  <Button
                    appearance="secondary"
                    size="small"
                    onClick={() => void refresh().catch(() => {})}
                  >
                    重新检测
                  </Button>
                </div>
              ) : null}

              {tab === "about" ? (
                <div className={styles.stack}>
                  <Text weight="semibold">SealPack {version || "0.2.0"}</Text>
                  <Text size={200} className={styles.muted}>
                    程序合并、加密与打包工作台。界面使用 React + Fluent UI React；后端使用 Tauri 2 +
                    Rust。
                  </Text>
                  <div className={styles.row}>
                    <Button
                      appearance="secondary"
                      size="small"
                      onClick={() =>
                        void openExternal("https://github.com/hmilyld/SealPack").catch(() => {})
                      }
                    >
                      项目主页
                    </Button>
                    <Button
                      appearance="secondary"
                      size="small"
                      onClick={() =>
                        void openExternal("https://jrsoftware.org/ishelp/").catch(() => {})
                      }
                    >
                      Inno Setup 文档
                    </Button>
                  </div>
                  <Text size={100} className={styles.muted}>
                    © 2026 hmilyld · MIT License
                  </Text>
                </div>
              ) : null}
            </div>
          </DialogContent>

          <div className={styles.footer}>
            <Button appearance="secondary" onClick={() => setOpen(false)}>
              关闭
            </Button>
            <Button appearance="primary" disabled={saving} onClick={() => void submit()}>
              {saving ? "保存中…" : "保存设置"}
            </Button>
          </div>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
