import { useEffect, useRef, useState } from "react";
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
import { ArrowClockwiseRegular } from "@fluentui/react-icons";

import { api } from "@/api";
import { useToast } from "@/components/feedback/ToastProvider";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import type { Project } from "@/types";

const useStyles = makeStyles({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-4)",
    minWidth: "420px",
    maxWidth: "520px",
  },
  hint: {
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground3,
  },
});

interface ProjectRenameDialogProps {
  project: Project | null;
  open: boolean;
  onClose: () => void;
}

export function ProjectRenameDialog({ project, open, onClose }: ProjectRenameDialogProps) {
  const styles = useStyles();
  const toast = useToast();
  const rename = useProjectStore((state) => state.rename);
  const running = useBuildStore((state) => state.running);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const dirtyRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setTouched(false);
    setBusy(false);
    dirtyRef.current = false;

    // 打开时自动用主程序的 ProductName 预填；拿不到就保留当前工程名。
    // 如果用户在结果回来前已经改了输入框，就不要覆盖他的输入。
    const request = ++requestRef.current;
    void api
      .exeProductName(project.exeFile)
      .then((suggestion) => {
        if (request !== requestRef.current || dirtyRef.current) return;
        const next = suggestion.trim();
        if (next) setName(next);
      })
      .catch(() => {});
  }, [open, project]);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  if (!project) return null;

  const error = touched && !name.trim() ? "工程名称不能为空" : "";

  const suggest = async () => {
    const request = ++requestRef.current;
    const suggestion = await api.exeProductName(project.exeFile).catch(() => "");
    if (request !== requestRef.current) return;
    const next = suggestion.trim();
    if (next) {
      dirtyRef.current = true;
      setName(next);
    } else {
      toast("未能从主程序读取产品名，请手动填写", "warning");
    }
  };

  const submit = async () => {
    setTouched(true);
    if (!name.trim()) return;
    setBusy(true);
    try {
      await rename(project.id, name.trim());
      toast("工程已重命名", "success");
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>重命名工程</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              <Field
                label="工程名称"
                required
                validationState={error ? "error" : "none"}
                validationMessage={error || undefined}
              >
                <Input
                  value={name}
                  autoFocus
                  onChange={(_, data) => {
                    dirtyRef.current = true;
                    setName(data.value);
                  }}
                  contentAfter={
                    <Button
                      appearance="transparent"
                      size="small"
                      icon={<ArrowClockwiseRegular />}
                      aria-label="从主程序推导"
                      title="从主程序推导"
                      onClick={() => void suggest()}
                    />
                  }
                />
              </Field>
              <span className={styles.hint}>
                会用于安装包名、默认安装目录和输出文件名；主程序与输出目录里的旧文件不会被改名。
              </span>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              appearance="primary"
              onClick={() => void submit()}
              disabled={busy || running}
            >
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
