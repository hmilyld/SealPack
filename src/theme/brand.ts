import type { BrandVariants } from "@fluentui/react-theme";

/**
 * Windows 11 蓝的 Fluent 品牌色阶。
 *
 * Fluent UI React 的 `createLightTheme` / `createDarkTheme` 需要 10–160 的
 * 完整色阶；这里以 #005FB8 为基准生成，保证主按钮、链接、选中态、焦点环
 * 都落在同一套蓝色上。
 */
export const brand: BrandVariants = {
  10: "#001a2e",
  20: "#002a46",
  30: "#003a5f",
  40: "#004a78",
  50: "#005a92",
  60: "#006aab",
  70: "#007ac4",
  80: "#0f8ad6",
  90: "#269ae4",
  100: "#45aaf0",
  110: "#63baf8",
  120: "#81c9fd",
  130: "#9fd8ff",
  140: "#bde5ff",
  150: "#d9f0ff",
  160: "#f0f8ff",
};
