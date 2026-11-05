import { tokens } from "@fluentui/react-components";

/**
 * 语义色：组件里不直接写 `colorPaletteGreenForeground1` 这类实现细节，
 * 也不写裸 hex。需要新语义（如「已取消」）时在这里加一项。
 */
export const semantic = {
  success: tokens.colorPaletteGreenForeground1,
  successBg: tokens.colorPaletteGreenBackground1,
  warning: tokens.colorPaletteDarkOrangeForeground1,
  warningBg: tokens.colorPaletteDarkOrangeBackground1,
  danger: tokens.colorPaletteRedForeground1,
  dangerBg: tokens.colorPaletteRedBackground1,
  info: tokens.colorBrandForeground1,
  infoBg: tokens.colorBrandBackground2,
  folder: tokens.colorPaletteYellowForeground2,
  highlight: tokens.colorPaletteYellowBackground2,
  closeHover: "var(--app-close-hover)",
  closeHoverInk: "var(--app-close-hover-ink)",
} as const;
