import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  makeStyles,
  tokens,
} from "@fluentui/react-components";

import type { OptField, OptGroup } from "@/types";
import { OptionField } from "./OptionField";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    minWidth: 0,
  },
  title: {
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  note: {
    display: "block",
    marginBottom: "var(--app-space-3)",
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground3,
  },
  fields: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-4)",
  },
});

function isVisible(field: OptField, bag: Record<string, unknown>): boolean {
  if (!field.when) return true;
  const current = bag[field.when.key];
  const matched = field.when.in.some((value) => String(value) === String(current));
  return field.when.negate ? !matched : matched;
}

interface OptionGroupsProps {
  groups: OptGroup[];
  bag: Record<string, unknown>;
  onChange: (key: string, value: boolean | string | number) => void;
  onPickPath?: (field: OptField) => void;
}

export function OptionGroups({ groups, bag, onChange, onPickPath }: OptionGroupsProps) {
  const styles = useStyles();
  return (
    <Accordion multiple collapsible defaultOpenItems={groups.map((group) => group.id)}>
      {groups.map((group) => {
        const enabled = group.fields.filter(
          (field) => field.kind === "bool" && Boolean(bag[field.key]),
        ).length;
        const fields = group.fields.filter((field) => isVisible(field, bag));
        return (
          <AccordionItem key={group.id} value={group.id}>
            <AccordionHeader expandIconPosition="end">
              <span className={styles.header}>
                <span className={styles.title}>{group.title}</span>
                {enabled > 0 ? (
                  <Badge appearance="tint" size="small" color="brand">
                    启用 {enabled} 项
                  </Badge>
                ) : null}
              </span>
            </AccordionHeader>
            <AccordionPanel>
              <span className={styles.note}>{group.note}</span>
              <div className={styles.fields}>
                {fields.map((field) => (
                  <OptionField
                    key={field.key}
                    field={field}
                    value={bag[field.key] ?? field.def}
                    onChange={(value) => onChange(field.key, value)}
                    onPickPath={onPickPath}
                  />
                ))}
              </div>
            </AccordionPanel>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}
