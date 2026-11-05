/**
 * 窗口底色。Tauri 的 `setBackgroundColor` 需要真实颜色值，不能传 CSS 变量；
 * `index.html` / `preview.html` 的首帧内联脚本和 `src-tauri/tauri.conf.json`
 * 的 `backgroundColor` 也各有一份同样的值（不能 import）。
 * 改这里时同步那三处。
 */
export const WINDOW_BG = {
  light: "#f3f3f3",
  dark: "#202020",
} as const;
