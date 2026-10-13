/**
 * 设计（皮肤）切换的单一状态源。
 *
 * 设计约束：
 * - 皮肤与主题是两个正交维度。皮肤挂在 <html data-skin>，主题挂在 <html data-theme>，
 *   两者都作用在根元素上，因此**整个窗口**（含 append 到 body 的对话框、右键菜单、提示条）
 *   同时生效，不存在局部残留旧皮肤的情况。
 * - 明暗有三种模式：跟随系统 / 深色 / 浅色。默认**跟随系统**——本地程序应当尊重
 *   Windows 的「应用模式」设置，而不是自说自话。一旦用户手动指定，就不再被系统覆盖。
 * - 系统明暗取自 `prefers-color-scheme`，WebView2 会把它映射到 Windows 应用模式；
 *   变化时实时跟随，无需重启。
 * - 非自动模式下，每套设计各自记住明暗：网格默认浅色、终端默认深色，
 *   切回某套设计时恢复它上次用的主题，避免「切过去发现明暗不对」。
 * - 所有状态集中在这里读写并落盘 localStorage，组件不各自维护副本，因此不会互相冲突。
 */

export type Skin = "swiss" | "terminal";
export type Theme = "dark" | "light";
/** 明暗模式：跟随系统，或手动指定 */
export type ThemeMode = "auto" | Theme;

export interface SkinMeta {
  key: Skin;
  /** 切换器上的短标签 */
  label: string;
  /** 完整名称，用于 tooltip */
  name: string;
  /** 该设计的自然默认主题（手动模式下切到它时用） */
  defaultTheme: Theme;
  /** 该设计的主色，用于切换器上的色块预览 */
  swatch: string;
}

export const SKINS: readonly SkinMeta[] = [
  { key: "swiss", label: "网格", name: "瑞士技术网格", defaultTheme: "light", swatch: "#d8332a" },
  {
    key: "terminal",
    label: "终端",
    name: "终端 · 赛博安全工具",
    defaultTheme: "dark",
    swatch: "#35d6e8",
  },
] as const;

const STORE_KEY = "sealpack:design";

export interface DesignState {
  skin: Skin;
  /** 每套设计各自记住的明暗（仅在非自动模式下生效） */
  themes: Record<Skin, Theme>;
  /** 是否跟随系统明暗 */
  auto: boolean;
  /**
   * 是否允许使用窗口材质（Windows 11 Mica Alt）。
   * 这是「用户意愿」，不是「实际生效」——还要 Rust 侧 set_effects() 成功才会真的透。
   * 默认允许，因为本地程序本来就该长在系统材质上；渲染异常时右键主题按钮可关掉。
   */
  material: boolean;
}

function isSkin(value: unknown): value is Skin {
  return SKINS.some((s) => s.key === value);
}

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

function defaultState(): DesignState {
  return {
    skin: "swiss",
    themes: { swiss: "light", terminal: "dark" },
    auto: true,
    material: true,
  };
}

/** 读取持久化状态，任何异常都退回默认值（localStorage 可能是脏数据或被禁用）。 */
export function loadDesign(): DesignState {
  const fallback = defaultState();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DesignState>;
    const skin = isSkin(parsed.skin) ? parsed.skin : fallback.skin;
    const themes = { ...fallback.themes };
    for (const meta of SKINS) {
      const value = parsed.themes?.[meta.key];
      if (isTheme(value)) themes[meta.key] = value;
    }
    // 默认跟随系统：本地程序应当尊重 Windows 的「应用模式」设置
    const auto = typeof parsed.auto === "boolean" ? parsed.auto : true;
    const material = typeof parsed.material === "boolean" ? parsed.material : true;
    return { skin, themes, auto, material };
  } catch {
    return fallback;
  }
}

function persist(state: DesignState): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // 忽略：隐私模式或配额不足时不影响本次会话
  }
}

// ---------------------------------------------------------------- 系统明暗

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** 系统当前的明暗（WebView2 映射 Windows 应用模式）。 */
export function systemTheme(): Theme {
  return darkQuery.matches ? "dark" : "light";
}

/** 生效主题：自动模式看系统，否则看该设计记住的值。 */
export function resolveTheme(state: DesignState, system: Theme = systemTheme()): Theme {
  return state.auto ? system : state.themes[state.skin];
}

/**
 * 把状态写到 DOM 上。只改根元素的三个属性，
 * 不触碰任何子树，所以不存在「部分元素还是旧皮肤」的中间态。
 * 返回实际生效的主题，供调用方同步窗口底色等。
 */
export function applyDesign(state: DesignState, system: Theme = systemTheme()): Theme {
  const root = document.documentElement;
  const theme = resolveTheme(state, system);
  root.dataset.skin = state.skin;
  root.dataset.theme = theme;
  root.dataset.themeMode = state.auto ? "auto" : "manual";
  // 保留 .dark 类，让可能残留的 Tailwind `dark:` 工具类也跟随主题
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  return theme;
}

export interface DesignController {
  get(): DesignState;
  /** 当前生效的明暗 */
  theme(): Theme;
  mode(): ThemeMode;
  setSkin(skin: Skin): void;
  /** 自动 → 深色 → 浅色 → 自动 */
  cycleTheme(): void;
  /** 材质是否真的透出来了（用户允许 **且** 系统支持） */
  materialOn(): boolean;
  /** 系统是否支持窗口材质；不支持时切换项应置灰 */
  materialSupported(): boolean;
  toggleMaterial(): void;
  /** Rust 侧报告 set_effects() 的结果后调用 */
  setMaterialSupported(supported: boolean): void;
  /** 订阅状态变化（含系统明暗变化引起的重绘） */
  subscribe(fn: (state: DesignState, theme: Theme) => void): () => void;
}

/**
 * 创建一个控制器。状态只有这一份，切换时先落盘再应用，
 * 保证 DOM 与存储始终一致（刷新后不会回退）。
 */
export function createDesignController(): DesignController {
  let state = loadDesign();
  let system = systemTheme();
  /** 系统/后端是否支持窗口材质。Rust 侧异步回报，所以先当作不支持。 */
  let materialSupported = false;
  const listeners = new Set<(state: DesignState, theme: Theme) => void>();

  const notify = (theme: Theme) => {
    for (const fn of listeners) fn(state, theme);
  };

  /** 把皮肤 + 主题 + 材质一次性写到根元素，避免出现「换了皮肤但材质没跟上」的中间态。 */
  const apply = (): Theme => {
    const theme = applyDesign(state, system);
    document.documentElement.dataset.material =
      state.material && materialSupported ? "on" : "off";
    return theme;
  };

  const commit = (next: DesignState) => {
    state = next;
    persist(state);
    notify(apply());
  };

  const applied = apply();

  // 系统明暗变化：自动模式下实时跟随
  const onSystemChange = () => {
    system = systemTheme();
    if (state.auto) notify(apply());
  };
  darkQuery.addEventListener("change", onSystemChange);

  return {
    get: () => state,
    theme: () => resolveTheme(state, system),
    mode: () => (state.auto ? "auto" : state.themes[state.skin]),
    setSkin(skin) {
      if (!isSkin(skin) || skin === state.skin) return;
      commit({ ...state, skin });
    },
    cycleTheme() {
      // 自动 → 深色 → 浅色 → 自动
      if (state.auto) {
        commit({ ...state, auto: false, themes: { ...state.themes, [state.skin]: "dark" } });
        return;
      }
      if (state.themes[state.skin] === "dark") {
        commit({ ...state, auto: false, themes: { ...state.themes, [state.skin]: "light" } });
        return;
      }
      commit({ ...state, auto: true });
    },
    materialOn: () => state.material && materialSupported,
    materialSupported: () => materialSupported,
    toggleMaterial() {
      commit({ ...state, material: !state.material });
    },
    setMaterialSupported(supported) {
      if (supported === materialSupported) return;
      materialSupported = supported;
      notify(apply());
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(state, applied);
      return () => listeners.delete(fn);
    },
  };
}
