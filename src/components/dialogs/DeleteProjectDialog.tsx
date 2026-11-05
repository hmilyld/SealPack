import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { DeleteRegular } from "@fluentui/react-icons";

import { useToast } from "@/components/feedback/ToastProvider";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { Project } from "@/types";

const useStyles = makeStyles({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-3)",
    minWidth: "420px",
    maxWidth: "520px",
  },
  note: {
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground3,
  },
});

interface DeleteProjectDialogProps {
  project: Project | null;
  open: boolean;
  onClose: () => void;
}

export function DeleteProjectDialog({ project, open, onClose }: DeleteProjectDialogProps) {
  const styles = useStyles();
  const toast = useToast();
  const remove = useProjectStore((state) => state.remove);
  const current = useProjectStore((state) => state.current);
  const resetWorkspace = useWorkspaceStore((state) => state.reset);
  const resetBuild = useBuildStore((state) => state.reset);
  const running = useBuildStore((state) => state.running);
  const setStep = useUiStore((state) => state.setStep);
  const [busy, setBusy] = useState(false);

  if (!project) return null;

  const submit = async () => {
    const wasCurrent = current?.id === project.id;
    setBusy(true);
    try {
      await remove(project.id);
      if (wasCurrent) {
        resetWorkspace();
        resetBuild();
        setStep("setup");
      }
      toast("工程已删除", "success");
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
          <DialogTitle>删除工程</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              <Text>确定删除工程「{project.name}」吗？</Text>
              <span className={styles.note}>
                只删除工程配置（%APPDATA%\com.hmilyld.sealpack\projects\{project.id}.json）。
                主程序、输出目录里的安装包、校验清单和日志都会保留。
              </span>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              appearance="primary"
              icon={<DeleteRegular />}
              onClick={() => void submit()}
              disabled={busy || running}
            >
              {busy ? "删除中…" : "删除"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
