import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { FluentProvider } from "@fluentui/react-components";
import {
  createDarkTheme,
  createLightTheme,
  type Theme,
} from "@fluentui/react-theme";

import { brand } from "./brand";
import { WINDOW_BG } from "./colors";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "sealpack:theme";

const FONT_SANS =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const FONT_MONO =
  '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei", monospace';

const lightTheme: Theme = {
  ...createLightTheme(brand),
  fontFamilyBase: FONT_SANS,
  fontFamilyMonospace: FONT_MONO,
};

const darkTheme: Theme = {
  ...createDarkTheme(brand),
  fontFamilyBase: FONT_SANS,
  fontFamilyMonospace: FONT_MONO,
};

function readMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    /* 存储不可用时用默认值 */
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: ResolvedTheme, mode: ThemeMode): void {
  const root = document.documentElement;
  const dark = theme === "dark";
  root.dataset.theme = theme;
  root.dataset.themeMode = mode;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = theme;
  root.style.backgroundColor = dark ? WINDOW_BG.dark : WINDOW_BG.light;
}

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    applyTheme(resolved, mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* 忽略存储失败 */
    }
  }, [mode, resolved]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);

  const cycle = useCallback(() => {
    setModeState((current) =>
      current === "system" ? "dark" : current === "dark" ? "light" : "system",
    );
  }, []);

  const value = useMemo(
    () => ({ mode, resolved, setMode, cycle }),
    [mode, resolved, setMode, cycle],
  );

  return (
    <ThemeContext.Provider value={value}>
      <FluentProvider
        theme={resolved === "dark" ? darkTheme : lightTheme}
        style={{ height: "100%", background: "transparent" }}
      >
        {children}
      </FluentProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return value;
}
