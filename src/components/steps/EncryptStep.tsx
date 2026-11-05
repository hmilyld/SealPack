import { Badge, Button, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowResetRegular } from "@fluentui/react-icons";

import { pickFile } from "@/api";
import { Page } from "@/components/common/Page";
import { Panel } from "@/components/common/Panel";
import { useToast } from "@/components/feedback/ToastProvider";
import { OptionGroups } from "@/components/options/OptionGroups";
import { PresetPicker } from "@/components/options/PresetPicker";
import { TemplateEditor } from "@/components/options/TemplateEditor";
import { inferPreset } from "@/lib/defaults";
import { enabledProtectionCount } from "@/lib/summaries";
import { useOptionsStore } from "@/stores/optionsStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { ENCRYPT_GROUPS, ENCRYPT_PRESETS, type EncryptOptions, type OptField } from "@/types";

const useStyles = makeStyles({
  status: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    marginTop: "var(--app-space-3)",
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground3,
  },
});

export function EncryptStep() {
  const styles = useStyles();
  const toast = useToast();
  const project = useProjectStore((state) => state.current);
  const update = useProjectStore((state) => state.update);
  const setEncrypt = useOptionsStore((state) => state.setEncrypt);
  const placeholders = useSettingsStore((state) => state.placeholders);

  if (!project) return null;

  const bag = project.encryptOptions as unknown as Record<string, unknown>;
  const active = inferPreset(bag, ENCRYPT_PRESETS);
  const enabled = enabledProtectionCount(project.encryptOptions);

  const applyPreset = (id: string) => {
    void useOptionsStore.getState().applyEncryptPreset(id);
  };

  const reset = () => {
    void useOptionsStore.getState().reset("encrypt");
  };

  const regenerate = () => {
    void useOptionsStore.getState().regenerate("encrypt");
  };

  const pickPath = async (field: OptField) => {
    const picked = await pickFile("选择强名称密钥", [
      { name: "强名称密钥", extensions: ["snk", "pfx"] },
      { name: "全部文件", extensions: ["*"] },
    ]).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), "error");
      return null;
    });
    if (picked) setEncrypt({ [field.key]: picked } as Partial<EncryptOptions>);
  };

  return (
    <Page
      title="加密保护"
      description="先选一档整体强度，再按需微调单项。开关与参数会直接生成 ConfuserEx 配置，不需要手写模板。"
      actions={
        <>
          <Badge appearance="tint" color={enabled > 0 ? "brand" : "subtle"} size="small">
            {enabled > 0 ? `启用 ${enabled} 项保护` : "未启用保护（跳过）"}
          </Badge>
          <Button
            appearance="secondary"
            size="small"
            icon={<ArrowResetRegular />}
            onClick={reset}
          >
            恢复默认
          </Button>
        </>
      }
    >
      <Panel
        title="保护强度"
        description="预设只负责把开关摆到合理位置；套用后仍可逐项微调。"
      >
        <PresetPicker presets={ENCRYPT_PRESETS} activeId={active} onSelect={applyPreset} />
        {!project.encryptOptions.generated ? (
          <div className={styles.status}>
            模板已被手工修改；套用预设只会改变开关，不会重建模板。
          </div>
        ) : null}
      </Panel>

      <Panel title="保护选项" description="参数项只在对应主开关开启后出现；每一项都标注了默认值与写入内容。">
        <OptionGroups
          groups={ENCRYPT_GROUPS}
          bag={bag}
          onChange={(key, value) =>
            setEncrypt({ [key]: value } as Partial<EncryptOptions>)
          }
          onPickPath={(field) => void pickPath(field)}
        />
      </Panel>

      <TemplateEditor
        title="ConfuserEx 配置"
        description="模板由 Rust 侧生成；手工修改后会转为手动模式，不再被开关覆盖。"
        value={project.encryptConfig}
        generated={project.encryptOptions.generated}
        placeholders={placeholders}
        onChange={(value) => {
          update({ encryptConfig: value });
          useOptionsStore.getState().setGenerated("encrypt", false);
        }}
        onRegenerate={regenerate}
      />
    </Page>
  );
}
