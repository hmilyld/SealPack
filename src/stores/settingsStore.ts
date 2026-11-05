import { create } from "zustand";

import { api } from "@/api";
import type { RuntimeStatus, Settings, ToolStatus } from "@/types";

interface SettingsState {
  toolStatus: ToolStatus | null;
  settings: Settings | null;
  runtime: RuntimeStatus | null;
  placeholders: [string, string][];
  loading: boolean;
  saving: boolean;

  refresh: () => Promise<void>;
  save: (settings: Settings) => Promise<void>;
  download: (key: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  toolStatus: null,
  settings: null,
  runtime: null,
  placeholders: [],
  loading: false,
  saving: false,

  async refresh() {
    set({ loading: true });
    try {
      const [toolStatus, settings, runtime, placeholders] = await Promise.all([
        api.toolStatus(),
        api.getSettings(),
        api.environmentStatus(),
        api.placeholders(),
      ]);
      set({ toolStatus, settings, runtime, placeholders, loading: false });
    } catch (error) {
      set({ loading: false });
      throw error;
    }
  },

  async save(settings) {
    set({ saving: true });
    try {
      const toolStatus = await api.saveSettings(settings);
      set({ settings, toolStatus, saving: false });
    } catch (error) {
      set({ saving: false });
      throw error;
    }
  },

  async download(key) {
    const toolStatus = await api.downloadTool(key);
    set({ toolStatus });
  },
}));
