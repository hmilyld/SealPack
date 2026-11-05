import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

export type ContextMenuEntry =
  | {
      id: string;
      label: string;
      icon?: ReactNode;
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    }
  | { id: string; separator: true };

interface MenuState {
  entries: ContextMenuEntry[];
  x: number;
  y: number;
}

interface ContextMenuValue {
  openMenu: (entries: ContextMenuEntry[], event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => void;
  closeMenu: () => void;
}

const ContextMenuContext = createContext<ContextMenuValue | null>(null);

const useStyles = makeStyles({
  menu: {
    position: "fixed",
    zIndex: 1000,
    minWidth: "190px",
    padding: "var(--app-space-1)",
    borderRadius: "var(--app-radius-md)",
    border: "1px solid var(--app-border-default)",
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    outline: "none",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
    width: "100%",
    padding: "var(--app-space-2) var(--app-space-3)",
    border: "none",
    borderRadius: "var(--app-radius-sm)",
    background: "transparent",
    color: tokens.colorNeutralForeground1,
    fontSize: "var(--app-font-body)",
    lineHeight: "var(--app-line-body)",
    textAlign: "left",
    cursor: "default",
    ":hover": {
      background: tokens.colorNeutralBackground3Hover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  danger: {
    color: tokens.colorPaletteRedForeground1,
  },
  disabled: {
    color: tokens.colorNeutralForegroundDisabled,
    ":hover": {
      background: "transparent",
    },
  },
  separator: {
    height: "1px",
    margin: "var(--app-space-1) var(--app-space-2)",
    background: tokens.colorNeutralStroke2,
  },
  icon: {
    display: "grid",
    placeItems: "center",
    width: "var(--app-icon-box-sm)",
    flexShrink: 0,
  },
});

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = useCallback<ContextMenuValue["openMenu"]>((entries, event) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ entries, x: event.clientX, y: event.clientY });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onWindowBlur = () => setMenu(null);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8));
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
  }, [menu]);

  const select = (entry: ContextMenuEntry) => {
    if ("separator" in entry || entry.disabled) return;
    setMenu(null);
    entry.onSelect();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!menu) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setMenu(null);
        break;
      case "ArrowDown":
        event.preventDefault();
        items[(index + 1 + items.length) % items.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        (document.activeElement as HTMLButtonElement | null)?.click();
        break;
      default:
        break;
    }
  };

  return (
    <ContextMenuContext.Provider value={{ openMenu, closeMenu }}>
      {children}
      {menu ? (
        <div
          ref={menuRef}
          className={styles.menu}
          role="menu"
          tabIndex={-1}
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={onKeyDown}
        >
          {menu.entries.map((entry) =>
            "separator" in entry ? (
              <div key={entry.id} className={styles.separator} role="separator" />
            ) : (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                disabled={entry.disabled}
                className={mergeClasses(
                  styles.item,
                  entry.danger ? styles.danger : undefined,
                  entry.disabled ? styles.disabled : undefined,
                )}
                onClick={() => select(entry)}
              >
                {entry.icon ? <span className={styles.icon}>{entry.icon}</span> : null}
                {entry.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </ContextMenuContext.Provider>
  );
}

export function useContextMenu(): ContextMenuValue {
  const value = useContext(ContextMenuContext);
  if (!value) throw new Error("useContextMenu 必须在 ContextMenuProvider 内使用");
  return value;
}
