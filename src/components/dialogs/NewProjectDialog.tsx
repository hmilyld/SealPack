import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  makeStyles,
  tokens,
} from "@fluentui/react-components";

import { pickDirectory, pickExe } from "@/api";
import { useToast } from "@/components/feedback/ToastProvider";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { baseName } from "@/util";

const useStyles = makeStyles({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-4)",
    minWidth: "460px",
    maxWidth: "560px",
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
  hint: {
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground3,
  },
});

export function NewProjectDialog() {
  const styles = useStyles();
  const toast = useToast();
  const open = useUiStore((state) => state.newProjectOpen);
  const setOpen = useUiStore((state) => state.setNewProjectOpen);
  const setStep = useUiStore((state) => state.setStep);
  const create = useProjectStore((state) => state.create);
  const resetWorkspace = useWorkspaceStore((state) => state.reset);
  const ensureTree = useWorkspaceStore((state) => state.ensureTree);
  const refreshIgnores = useWorkspaceStore((state) => state.refreshIgnores);
  const resetBuild = useBuildStore((state) => state.reset);

  const [name, setName] = useState("");
  const [exeFile, setExeFile] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setExeFile("");
    setOutputDir("");
    setTouched(false);
    setBusy(false);
  }, [open]);

  const nameError = touched && !name.trim() ? "请填写工程名称" : "";
  const exeError = touched && !exeFile.trim() ? "请选择主程序" : "";
  const outputError = touched && !outputDir.trim() ? "请选择输出目录" : "";

  const browseExe = async () => {
    const picked = await pickExe().catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), "error");
      return null;
    });
    if (!picked) return;
    setExeFile(picked);
    if (!name.trim()) {
      setName(baseName(picked).replace(/\.exe$/i, ""));
    }
  };

  const browseOutput = async () => {
    const picked = await pickDirectory("选择安装包输出目录").catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), "error");
      return null;
    });
    if (picked) setOutputDir(picked);
  };

  const submit = async () => {
    setTouched(true);
    if (!name.trim() || !exeFile.trim() || !outputDir.trim()) return;
    setBusy(true);
    try {
      await create(name.trim(), exeFile.trim(), outputDir.trim());
      resetWorkspace();
      resetBuild();
      setStep("setup");
      setOpen(false);
      void ensureTree(true);
      void refreshIgnores();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>新建工程</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              <Field
                label="工程名称"
                required
                validationState={nameError ? "error" : "none"}
                validationMessage={nameError || undefined}
              >
                <Input
                  value={name}
                  onChange={(_, data) => setName(data.value)}
                  placeholder="例如 我的工具"
                  autoFocus
                />
              </Field>

              <Field
                label="主程序文件"
                required
                validationState={exeError ? "error" : "none"}
                validationMessage={exeError || undefined}
              >
                <div className={styles.row}>
                  <Input
                    className={styles.grow}
                    value={exeFile}
                    onChange={(_, data) => setExeFile(data.value)}
                    placeholder="编译输出的 .exe"
                  />
                  <Button appearance="secondary" onClick={() => void browseExe()}>
                    浏览
                  </Button>
                </div>
              </Field>

              <Field
                label="安装包输出目录"
                required
                validationState={outputError ? "error" : "none"}
                validationMessage={outputError || undefined}
              >
                <div className={styles.row}>
                  <Input
                    className={styles.grow}
                    value={outputDir}
                    onChange={(_, data) => setOutputDir(data.value)}
                    placeholder="安装包生成位置"
                  />
                  <Button appearance="secondary" onClick={() => void browseOutput()}>
                    浏览
                  </Button>
                </div>
              </Field>

              <span className={styles.hint}>
                创建后会自动推导主程序所在目录、版本号与应用标识，之后都能修改。
              </span>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button appearance="primary" onClick={() => void submit()} disabled={busy}>
              创建
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
