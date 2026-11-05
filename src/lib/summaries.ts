import type {
  ArtifactKind,
  EncryptOptions,
  IgnorePreview,
  Project,
  Stage,
  StageStatus,
} from "@/types";

const PROTECTION_KEYS: (keyof EncryptOptions)[] = [
  "antiIldasm",
  "antiDebug",
  "antiDump",
  "antiTamper",
  "constants",
  "controlFlow",
  "invalidMetadata",
  "rename",
  "harden",
  "refProxy",
  "resources",
];

export function enabledProtectionCount(options: EncryptOptions): number {
  return PROTECTION_KEYS.filter((key) => options[key]).length;
}

export function mergeSummary(project: Project): string {
  return project.mergeDlls.length > 0
    ? `${project.mergeDlls.length} 个程序集`
    : "未勾选（跳过）";
}

export function encryptSummary(project: Project): string {
  const count = enabledProtectionCount(project.encryptOptions);
  return count > 0 ? `${count} 项保护` : "未启用（跳过）";
}

/** 产物类型的中文短标签。 */
export function artifactKindLabel(kind: ArtifactKind | "none"): string {
  switch (kind) {
    case "upgrade":
      return "升级包";
    case "both":
      return "完整包 + 升级包";
    case "installer":
      return "完整包";
    default:
      return "无产物";
  }
}

export function artifactLabel(project: Project): string {
  return artifactKindLabel(project.buildOptions?.artifact ?? "installer");
}

export function packageSummary(project: Project, ignores: IgnorePreview | null): string {
  const count = (ignores?.auto.length ?? 0) + project.excludePaths.length;
  const suffix = count > 0 ? `${count} 项排除` : "未设置排除";
  return `${artifactLabel(project)} · ${suffix}`;
}

export function stageSummary(
  project: Project,
  stage: Stage,
  ignores: IgnorePreview | null,
): string {
  switch (stage) {
    case "merge":
      return mergeSummary(project);
    case "encrypt":
      return encryptSummary(project);
    case "package": {
      const excluded = (ignores?.auto.length ?? 0) + project.excludePaths.length;
      const packed = ignores?.packedCount;
      return packed === undefined
        ? `${excluded} 项排除`
        : `打包 ${packed} 个文件 · 排除 ${excluded} 项`;
    }
  }
}

export function stageStatusLabel(status: StageStatus): string {
  switch (status) {
    case "idle":
      return "待执行";
    case "running":
      return "执行中";
    case "ok":
      return "已完成";
    case "skipped":
      return "已跳过";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

export function stageStatusColor(
  status: StageStatus,
): "subtle" | "informative" | "success" | "warning" | "danger" {
  switch (status) {
    case "running":
      return "informative";
    case "ok":
      return "success";
    case "skipped":
      return "warning";
    case "failed":
      return "danger";
    case "cancelled":
      return "warning";
    default:
      return "subtle";
  }
}
