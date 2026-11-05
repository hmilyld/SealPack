import { create } from "zustand";

import { api } from "@/api";
import {
  ENCRYPT_GROUPS,
  ENCRYPT_PRESETS,
  PACKAGE_GROUPS,
  PACKAGE_PRESETS,
  type EncryptOptions,
  type PackageOptions,
  type Project,
} from "@/types";
import { defaultsFor } from "@/lib/defaults";
import { useProjectStore } from "./projectStore";

type Kind = "encrypt" | "package";

const RENDER_DELAY = 150;

let encryptTimer: number | undefined;
let packageTimer: number | undefined;

interface OptionsState {
  lastError: string;
  clearError: () => void;

  setEncrypt: (patch: Partial<EncryptOptions>) => void;
  setPackage: (patch: Partial<PackageOptions>) => void;

  applyEncryptPreset: (presetId: string, overwrite?: boolean) => Promise<void>;
  applyPackagePreset: (presetId: string, overwrite?: boolean) => Promise<void>;

  reset: (kind: Kind) => Promise<void>;
  regenerate: (kind: Kind) => Promise<void>;
  setGenerated: (kind: Kind, generated: boolean) => void;
}

async function render(kind: Kind): Promise<void> {
  const project = useProjectStore.getState().current;
  if (!project) return;

  try {
    if (kind === "encrypt") {
      if (!project.encryptOptions.generated) return;
      const text = await api.renderEncryptConfig(project.encryptOptions);
      if (useProjectStore.getState().current?.id !== project.id) return;
      useProjectStore.getState().update({ encryptConfig: text });
    } else {
      if (!project.packageOptions.generated) return;
      const text = await api.renderPackageScript(project.packageOptions);
      if (useProjectStore.getState().current?.id !== project.id) return;
      useProjectStore.getState().update({ packageScript: text });
    }
  } catch (error) {
    useOptionsStore.setState({
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

function scheduleRender(kind: Kind): void {
  if (kind === "encrypt") {
    window.clearTimeout(encryptTimer);
    encryptTimer = window.setTimeout(() => void render("encrypt"), RENDER_DELAY);
  } else {
    window.clearTimeout(packageTimer);
    packageTimer = window.setTimeout(() => void render("package"), RENDER_DELAY);
  }
}

function applyValues(
  kind: Kind,
  values: Record<string, boolean | string | number>,
): void {
  if (kind === "encrypt") {
    useProjectStore.getState().updateOptions({
      encryptOptions: values as Partial<EncryptOptions>,
    });
  } else {
    useProjectStore.getState().updateOptions({
      packageOptions: values as Partial<PackageOptions>,
    });
  }
}

export const useOptionsStore = create<OptionsState>((set) => ({
  lastError: "",
  clearError: () => set({ lastError: "" }),

  setEncrypt(patch) {
    useProjectStore.getState().updateOptions({ encryptOptions: patch });
    scheduleRender("encrypt");
  },

  setPackage(patch) {
    useProjectStore.getState().updateOptions({ packageOptions: patch });
    scheduleRender("package");
  },

  async applyEncryptPreset(presetId, overwrite = false) {
    const project = useProjectStore.getState().current;
    const preset = ENCRYPT_PRESETS.find((item) => item.id === presetId);
    if (!project || !preset) return;

    applyValues("encrypt", preset.values);
    if (overwrite || project.encryptOptions.generated) {
      useProjectStore.getState().updateOptions({
        encryptOptions: { ...preset.values, generated: true } as Partial<EncryptOptions>,
      });
      await render("encrypt");
    }
  },

  async applyPackagePreset(presetId, overwrite = false) {
    const project = useProjectStore.getState().current;
    const preset = PACKAGE_PRESETS.find((item) => item.id === presetId);
    if (!project || !preset) return;

    applyValues("package", preset.values);
    if (overwrite || project.packageOptions.generated) {
      useProjectStore.getState().updateOptions({
        packageOptions: { ...preset.values, generated: true } as Partial<PackageOptions>,
      });
      await render("package");
    }
  },

  async reset(kind) {
    const values =
      kind === "encrypt" ? defaultsFor(ENCRYPT_GROUPS) : defaultsFor(PACKAGE_GROUPS);

    if (kind === "encrypt") {
      useProjectStore.getState().updateOptions({
        encryptOptions: { ...values, generated: true } as Partial<EncryptOptions>,
      });
    } else {
      useProjectStore.getState().updateOptions({
        packageOptions: { ...values, generated: true } as Partial<PackageOptions>,
      });
    }
    await render(kind);
  },

  async regenerate(kind) {
    if (kind === "encrypt") {
      useProjectStore.getState().updateOptions({ encryptOptions: { generated: true } });
    } else {
      useProjectStore.getState().updateOptions({ packageOptions: { generated: true } });
    }
    await render(kind);
  },

  setGenerated(kind, generated) {
    if (kind === "encrypt") {
      useProjectStore.getState().updateOptions({ encryptOptions: { generated } });
    } else {
      useProjectStore.getState().updateOptions({ packageOptions: { generated } });
    }
  },
}));

/** 工程切换时清掉在途的模板重建，避免把上一个工程的文本写进新工程。 */
export function cancelPendingRenders(): void {
  window.clearTimeout(encryptTimer);
  window.clearTimeout(packageTimer);
  encryptTimer = undefined;
  packageTimer = undefined;
}

/** 供测试/预览读取当前工程的选项包。 */
export function optionBagOf(project: Project, kind: Kind): Record<string, unknown> {
  return kind === "encrypt"
    ? (project.encryptOptions as unknown as Record<string, unknown>)
    : (project.packageOptions as unknown as Record<string, unknown>);
}
