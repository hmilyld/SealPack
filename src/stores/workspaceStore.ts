import { create } from "zustand";

import { api } from "@/api";
import type { FileNode, IgnorePreview } from "@/types";
import { useProjectStore } from "./projectStore";

interface WorkspaceState {
  tree: FileNode | null;
  treeError: string;
  scanning: boolean;

  ignores: IgnorePreview | null;
  ignoresError: string;

  ensureTree: (force?: boolean) => Promise<void>;
  rescan: () => Promise<void>;
  refreshIgnores: () => Promise<void>;
  reset: () => void;
}

let scanEpoch = 0;
let ignoreEpoch = 0;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  tree: null,
  treeError: "",
  scanning: false,

  ignores: null,
  ignoresError: "",

  async ensureTree(force = false) {
    const project = useProjectStore.getState().current;
    if (!project) {
      set({ tree: null, treeError: "", scanning: false });
      return;
    }
    if (!force && get().tree) return;

    const epoch = (scanEpoch += 1);
    set({ scanning: true, treeError: "" });

    try {
      const tree = await api.scanTree(project.rootPath);
      // 期间切了工程或又发起了新扫描 → 本次结果作废
      if (epoch !== scanEpoch || useProjectStore.getState().current?.id !== project.id) {
        return;
      }
      set({ tree, scanning: false });
    } catch (error) {
      if (epoch !== scanEpoch) return;
      set({
        tree: null,
        treeError: error instanceof Error ? error.message : String(error),
        scanning: false,
      });
    }
  },

  async rescan() {
    set({ tree: null });
    await get().ensureTree(true);
    await get().refreshIgnores();
  },

  async refreshIgnores() {
    const project = useProjectStore.getState().current;
    if (!project) {
      set({ ignores: null, ignoresError: "" });
      return;
    }

    const epoch = (ignoreEpoch += 1);
    try {
      const ignores = await api.projectIgnores(project);
      if (epoch !== ignoreEpoch || useProjectStore.getState().current?.id !== project.id) {
        return;
      }
      set({ ignores, ignoresError: "" });
    } catch (error) {
      if (epoch !== ignoreEpoch) return;
      set({
        ignores: null,
        ignoresError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  reset() {
    scanEpoch += 1;
    ignoreEpoch += 1;
    set({
      tree: null,
      treeError: "",
      scanning: false,
      ignores: null,
      ignoresError: "",
    });
  },
}));
