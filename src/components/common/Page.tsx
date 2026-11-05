import type { ReactNode } from "react";
import { Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-4)",
    padding: "var(--app-page-pad)",
    maxWidth: "var(--app-page-max)",
    margin: "0 auto",
  },
  wide: {
    maxWidth: "none",
  },
  fill: {
    height: "100%",
    minHeight: 0,
    paddingBottom: "var(--app-space-4)",
  },
  head: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--app-space-4)",
    paddingBottom: "var(--app-space-3)",
    borderBottom: "1px solid var(--app-border-default)",
  },
  headText: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-1)",
    minWidth: 0,
    flex: 1,
  },
  title: {
    fontFamily: "var(--app-font-display)",
    fontSize: "var(--app-font-title)",
    lineHeight: "var(--app-line-title)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  description: {
    fontSize: "var(--app-font-body)",
    lineHeight: "var(--app-line-body)",
    color: tokens.colorNeutralForeground3,
    maxWidth: "760px",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    flexShrink: 0,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-4)",
  },
  bodyFill: {
    flex: 1,
    minHeight: 0,
  },
});

interface PageProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  wide?: boolean;
  fill?: boolean;
  children: ReactNode;
}

export function Page({ title, description, actions, wide, fill, children }: PageProps) {
  const styles = useStyles();
  return (
    <div className={mergeClasses(styles.root, wide && styles.wide, fill && styles.fill)}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <Text as="h1" className={styles.title}>
            {title}
          </Text>
          {description ? <span className={styles.description}>{description}</span> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      <div className={mergeClasses(styles.body, fill && styles.bodyFill)}>{children}</div>
    </div>
  );
}
