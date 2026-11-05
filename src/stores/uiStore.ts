import { create } from "zustand";

import type { StepId } from "@/types";

interface UiState {
  step: StepId;
  setStep: (step: StepId) => void;

  logOpen: boolean;
  setLogOpen: (open: boolean) => void;

  railCollapsed: boolean;
  toggleRail: () => void;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  newProjectOpen: boolean;
  setNewProjectOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  step: "setup",
  setStep: (step) => set({ step }),

  logOpen: true,
  setLogOpen: (logOpen) => set({ logOpen }),

  railCollapsed: false,
  toggleRail: () => set((state) => ({ railCollapsed: !state.railCollapsed })),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  newProjectOpen: false,
  setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
}));
