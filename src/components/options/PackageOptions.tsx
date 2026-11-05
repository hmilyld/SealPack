import { Badge, Button, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowResetRegular } from "@fluentui/react-icons";

import { Panel } from "@/components/common/Panel";
import { OptionGroups } from "@/components/options/OptionGroups";
import { PresetPicker } from "@/components/options/PresetPicker";
import { TemplateEditor } from "@/components/options/TemplateEditor";
import { inferPreset } from "@/lib/defaults";
import { useOptionsStore } from "@/stores/optionsStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  PACKAGE_GROUPS,
  PACKAGE_PRESETS,
  type PackageOptions,
} from "@/types";

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

export function PackageOptions() {
  const styles = useStyles();
  const project = useProjectStore((state) => state.current);
  const update = useProjectStore((state) => state.update);
  const setPackage = useOptionsStore((state) => state.setPackage);
  const placeholders = useSettingsStore((state) => state.placeholders);

  if (!project) return null;

  const bag = project.packageOptions as unknown as Record<string, unknown>;
  const active = inferPreset(bag, PACKAGE_PRESETS);
  const enabled = PACKAGE_GROUPS.flatMap((group) => group.fields).filter(
    (field) => field.kind === "bool" && Boolean(bag[field.key]),
  ).length;

  const applyPreset = (id: string) => {
    void useOptionsStore.getState().applyPackagePreset(id);
  };

  const reset = () => {
    void useOptionsStore.getState().reset("package");
  };

  const regenerate = () => {
    void useOptionsStore.getState().regenerate("package");
  };

  return (
    <>
      <Panel
        variant="plain"
        title="打包预设"
        description="复杂选项不该从零开始勾；先选一档，再按需微调。"
        actions={
          <>
            <Badge appearance="tint" color={enabled > 0 ? "brand" : "subtle"} size="small">
              启用 {enabled} 项
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
        <PresetPicker presets={PACKAGE_PRESETS} activeId={active} onSelect={applyPreset} />
        {!project.packageOptions.generated ? (
          <div className={styles.status}>
            模板已被手工修改；套用预设只会改变开关，不会重建模板。
          </div>
        ) : null}
      </Panel>

      <Panel
        variant="plain"
        title="安装包选项"
        description="每一项都标注了默认值与适用场景；带参数的选项只在对应功能开启后出现。"
      >
        <OptionGroups
          groups={PACKAGE_GROUPS}
          bag={bag}
          onChange={(key, value) =>
            setPackage({ [key]: value } as Partial<PackageOptions>)
          }
        />
      </Panel>

      <TemplateEditor
        title="Inno Setup 脚本"
        description="模板由 Rust 侧生成；手工修改后会转为手动模式，不再被开关覆盖。"
        value={project.packageScript}
        generated={project.packageOptions.generated}
        placeholders={placeholders}
        onChange={(value) => {
          update({ packageScript: value });
          useOptionsStore.getState().setGenerated("package", false);
        }}
        onRegenerate={regenerate}
      />
    </>
  );
}
