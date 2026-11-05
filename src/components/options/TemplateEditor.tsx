import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwiseRegular, CopyRegular, InfoRegular } from "@fluentui/react-icons";

import { Panel } from "@/components/common/Panel";
import { useToast } from "@/components/feedback/ToastProvider";

const useStyles = makeStyles({
  editor: {
    width: "100%",
    // Fluent Textarea 的 className 落在外层 span 上；只给外层 minHeight 会让
    // 内层 textarea 仍是默认 52px，外框里空一大截。高度和等宽字体都设到内层。
    "& textarea": {
      minHeight: "240px",
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: "var(--app-font-small)",
      lineHeight: "var(--app-line-body)",
      tabSize: 2,
    },
  },
  placeholders: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
    maxHeight: "320px",
    overflow: "auto",
    minWidth: "360px",
  },
  placeholderRow: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gap: "var(--app-space-3)",
    fontSize: "var(--app-font-small)",
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorBrandForeground1,
    whiteSpace: "nowrap",
  },
  hint: {
    color: tokens.colorNeutralForeground3,
  },
  message: {
    marginBottom: "var(--app-space-3)",
  },
});

interface TemplateEditorProps {
  title: string;
  description?: string;
  value: string;
  generated: boolean;
  placeholders: [string, string][];
  onChange: (value: string) => void;
  onRegenerate: () => void;
}

export function TemplateEditor({
  title,
  description,
  value,
  generated,
  placeholders,
  onChange,
  onRegenerate,
}: TemplateEditorProps) {
  const styles = useStyles();
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast("模板已复制", "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  return (
    <Panel
      title={title}
      description={description}
      actions={
        <>
          <Badge appearance="tint" size="small" color={generated ? "success" : "warning"}>
            {generated ? "自动生成" : "手动编辑"}
          </Badge>
          <Popover>
            <PopoverTrigger disableButtonEnhancement>
              <Button appearance="subtle" size="small" icon={<InfoRegular />}>
                占位符
              </Button>
            </PopoverTrigger>
            <PopoverSurface>
              <div className={styles.placeholders}>
                {placeholders.length === 0 ? (
                  <Text size={200}>没有可用的占位符说明。</Text>
                ) : (
                  placeholders.map(([key, help]) => (
                    <div key={key} className={styles.placeholderRow}>
                      <code className={styles.code}>{`\${${key}}`}</code>
                      <span className={styles.hint}>{help}</span>
                    </div>
                  ))
                )}
              </div>
            </PopoverSurface>
          </Popover>
          <Button
            appearance="subtle"
            size="small"
            icon={<CopyRegular />}
            onClick={() => void copy()}
          >
            复制
          </Button>
          <Button
            appearance="secondary"
            size="small"
            icon={<ArrowClockwiseRegular />}
            onClick={onRegenerate}
          >
            重新生成
          </Button>
        </>
      }
    >
      {!generated ? (
        <MessageBar intent="warning" className={styles.message}>
          <MessageBarBody>
            模板已被手工修改；开关不会再覆盖它。
            <Button appearance="transparent" size="small" onClick={onRegenerate}>
              用当前选项覆盖模板
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}
      <Textarea
        className={styles.editor}
        value={value}
        resize="vertical"
        spellCheck={false}
        onChange={(_, data) => onChange(data.value)}
      />
    </Panel>
  );
}
