import type { OptGroup, OptPreset } from "@/types";

/** 按 schema 里声明的 `def` 生成一组默认值。 */
export function defaultsFor(groups: OptGroup[]): Record<string, boolean | string | number> {
  const out: Record<string, boolean | string | number> = {};
  for (const group of groups) {
    for (const field of group.fields) {
      out[field.key] = field.def;
    }
  }
  return out;
}

/** 当前选项是否与某个预设完全一致。 */
export function matchesPreset(
  bag: Record<string, unknown>,
  preset: OptPreset,
): boolean {
  return Object.entries(preset.values).every(
    ([key, value]) => String(bag[key]) === String(value),
  );
}

/** 找出当前选项对应的预设 id；没有完全匹配的返回 null（自定义）。 */
export function inferPreset(
  bag: Record<string, unknown>,
  presets: OptPreset[],
): string | null {
  return presets.find((preset) => matchesPreset(bag, preset))?.id ?? null;
}
