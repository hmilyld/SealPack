import type { ReactNode } from "react";
import { Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  panel: {
    display: "flex",
    flexDirection: "column",
    border: "1px solid var(--app-border-default)",
    borderRadius: "var(--app-radius-lg)",
    background: tokens.colorNeutralBackground1,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    minHeight: 0,
  },
  plain: {
    border: "none",
    borderRadius: 0,
    background: "transparent",
    overflow: "visible",
  },
  plainHead: {
    padding: "0 0 var(--app-space-3)",
    background: "transparent",
    borderBottom: "1px solid var(--app-border-subtle)",
  },
  plainBody: {
    padding: "var(--app-space-3) 0 0",
  },
  head: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--app-space-3)",
    padding: "var(--app-space-3) var(--app-space-4)",
    borderBottom: "1px solid var(--app-border-subtle)",
    background: tokens.colorNeutralBackground2,
  },
  headText: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
    minWidth: 0,
    flex: 1,
  },
  title: {
    fontSize: "var(--app-font-body)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  description: {
    fontSize: "var(--app-font-small)",
    lineHeight: "var(--app-line-small)",
    color: tokens.colorNeutralForeground3,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    flexShrink: 0,
  },
  body: {
    padding: "var(--app-space-4)",
  },
  flush: {
    padding: 0,
  },
  bodyFill: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
});

interface PanelProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  flush?: boolean;
  fill?: boolean;
  /** card = 白色内容卡；plain = 画布上的次级分区（无卡片边框/底色）。 */
  variant?: "card" | "plain";
  children: ReactNode;
}

export function Panel({
  title,
  description,
  actions,
  flush,
  fill,
  variant = "card",
  children,
}: PanelProps) {
  const styles = useStyles();
  const plain = variant === "plain";
  return (
    <section
      className={mergeClasses(
        styles.panel,
        plain && styles.plain,
        fill && styles.fill,
      )}
    >
      {title ? (
        <header className={mergeClasses(styles.head, plain && styles.plainHead)}>
          <div className={styles.headText}>
            <Text as="h2" className={styles.title}>
              {title}
            </Text>
            {description ? <span className={styles.description}>{description}</span> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      <div
        className={mergeClasses(
          styles.body,
          flush && styles.flush,
          fill && styles.bodyFill,
          plain && styles.plainBody,
        )}
      >
        {children}
      </div>
    </section>
  );
}
