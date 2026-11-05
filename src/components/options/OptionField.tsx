import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  Switch,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { FolderOpenRegular } from "@fluentui/react-icons";

import type { OptField } from "@/types";

const useStyles = makeStyles({
  boolRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    flexWrap: "wrap",
  },
  badges: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--app-space-1)",
    flexWrap: "wrap",
  },
  hint: {
    display: "block",
    marginTop: "var(--app-space-1)",
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground3,
  },
  unit: {
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-meta)",
  },
  writes: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "var(--app-font-meta)",
  },
});

interface OptionFieldProps {
  field: OptField;
  value: unknown;
  onChange: (value: boolean | string | number) => void;
  onPickPath?: (field: OptField) => void;
}

export function OptionField({ field, value, onChange, onPickPath }: OptionFieldProps) {
  const styles = useStyles();
  const isDefault = String(value) === String(field.def);

  const label = (
    <span className={styles.badges}>
      {field.label}
      {isDefault ? (
        <Badge appearance="tint" size="small" color="subtle">
          默认
        </Badge>
      ) : null}
      {field.writes ? (
        <Badge appearance="outline" size="small" className={styles.writes}>
          {field.writes}
        </Badge>
      ) : null}
    </span>
  );

  if (field.kind === "bool") {
    return (
      <div>
        <div className={styles.boolRow}>
          <Switch
            checked={Boolean(value)}
            onChange={(_, data) => onChange(data.checked)}
            label={field.label}
          />
          <span className={styles.badges}>
            {isDefault ? (
              <Badge appearance="tint" size="small" color="subtle">
                默认
              </Badge>
            ) : null}
            {field.writes ? (
              <Badge appearance="outline" size="small" className={styles.writes}>
                {field.writes}
              </Badge>
            ) : null}
          </span>
        </div>
        <span className={styles.hint}>{field.hint}</span>
      </div>
    );
  }

  if (field.kind === "enum") {
    return (
      <Field label={label} hint={field.hint}>
        <Select value={String(value)} onChange={(_, data) => onChange(data.value)}>
          {field.choices?.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (field.kind === "number") {
    return (
      <Field label={label} hint={field.hint}>
        <Input
          type="number"
          value={String(value)}
          min={field.min}
          max={field.max}
          onChange={(_, data) => {
            const parsed = Number(data.value);
            onChange(Number.isFinite(parsed) ? parsed : 0);
          }}
          contentAfter={field.unit ? <span className={styles.unit}>{field.unit}</span> : undefined}
        />
      </Field>
    );
  }

  const input = (
    <Input
      type={field.secret ? "password" : "text"}
      value={String(value)}
      placeholder={field.placeholder ?? (field.def === "" ? "留空" : String(field.def))}
      onChange={(_, data) => onChange(data.value)}
      contentAfter={
        field.kind === "path" && onPickPath ? (
          <Button
            appearance="transparent"
            size="small"
            icon={<FolderOpenRegular />}
            aria-label="浏览"
            title="浏览"
            onClick={() => onPickPath(field)}
          />
        ) : undefined
      }
    />
  );

  return (
    <Field label={label} hint={field.hint}>
      {input}
    </Field>
  );
}
