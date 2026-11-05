import { Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

import type { OptPreset } from "@/types";

const useStyles = makeStyles({
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "var(--app-space-2)",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "var(--app-space-1)",
    padding: "var(--app-space-2) var(--app-space-3)",
    border: "1px solid var(--app-border-default)",
    borderRadius: "var(--app-radius-md)",
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    textAlign: "left",
    cursor: "default",
    ":hover": {
      background: tokens.colorNeutralBackground3Hover,
      border: `1px solid ${tokens.colorNeutralStroke1}`,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "1px",
    },
  },
  active: {
    border: `1px solid ${tokens.colorBrandBackground}`,
    background: tokens.colorBrandBackground2,
    ":hover": {
      background: tokens.colorBrandBackground2,
      border: `1px solid ${tokens.colorBrandBackground}`,
    },
  },
  label: {
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
  },
  hint: {
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground3,
  },
  custom: {
    display: "block",
    marginTop: "var(--app-space-2)",
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground3,
  },
});

interface PresetPickerProps {
  presets: OptPreset[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function PresetPicker({ presets, activeId, onSelect }: PresetPickerProps) {
  const styles = useStyles();
  return (
    <div>
      <div className={styles.grid}>
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={mergeClasses(styles.card, activeId === preset.id && styles.active)}
            aria-pressed={activeId === preset.id}
            onClick={() => onSelect(preset.id)}
          >
            <span className={styles.label}>{preset.label}</span>
            <span className={styles.hint}>{preset.hint}</span>
          </button>
        ))}
      </div>
      {activeId === null ? (
        <Text className={styles.custom}>
          当前为自定义组合；点任意预设可一键摆到对应位置，之后仍可微调。
        </Text>
      ) : null}
    </div>
  );
}
