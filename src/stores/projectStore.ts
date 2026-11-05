import { create } from "zustand";

import { api } from "@/api";
import type { BuildOptions, EncryptOptions, PackageOptions, Project } from "@/types";

type SaveState = "idle" | "saving" | "saved" | "error";

interface OptionsPatch {
  encryptOptions?: Partial<EncryptOptions>;
  packageOptions?: Partial<PackageOptions>;
}

interface ProjectState {
  projects: Project[];
  current: Project | null;
  unreadable: string[];
  loading: boolean;
  saveState: SaveState;

  refresh: (preferId?: string) => Promise<void>;
  select: (id: string) => Promise<void>;
  create: (name: string, exeFile: string, outputDir: string) => Promise<Project>;
  remove: (id: string) => Promise<void>;

  update: (patch: Partial<Project>) => void;
  updateOptions: (patch: OptionsPatch) => void;
  updateBuildOptions: (patch: Partial<BuildOptions>) => void;
  rename: (id: string, name: string) => Promise<void>;
  reload: (id: string) => Promise<Project>;

  scheduleSave: () => void;
  flush: () => Promise<void>;
  discard: () => void;
}

const SAVE_DELAY = 600;

let saveTimer: number | undefined;
let pending: Project | null = null;

function snapshot(project: Project): Project {
  return structuredClone(project);
}

function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  current: null,
  unreadable: [],
  loading: false,
  saveState: "idle",

  async refresh(preferId) {
    await get().flush();
    set({ loading: true });
    try {
      const list = await api.listProjects();
      const current = get().current;
      const wantedId = preferId ?? current?.id;
      const next =
        list.projects.find((project) => project.id === wantedId) ??
        list.projects[0] ??
        null;
      set({
        projects: sortProjects(list.projects),
        unreadable: list.unreadable,
        current: next,
        loading: false,
        saveState: "idle",
      });
    } catch (error) {
      set({ loading: false });
      throw error;
    }
  },

  async select(id) {
    if (get().current?.id === id) return;
    await get().flush();
    const project = await api.loadProject(id);
    set({ current: project, saveState: "idle" });
  },

  async create(name, exeFile, outputDir) {
    await get().flush();
    const project = await api.createProject(name, exeFile, outputDir);
    set((state) => ({
      projects: sortProjects([...state.projects, project]),
      current: project,
      saveState: "idle",
    }));
    return project;
  },

  async remove(id) {
    if (get().current?.id === id) get().discard();
    await api.deleteProject(id);
    set((state) => {
      const projects = state.projects.filter((project) => project.id !== id);
      const removedCurrent = state.current?.id === id;
      return {
        projects,
        current: removedCurrent ? (projects[0] ?? null) : state.current,
      };
    });
  },

  update(patch) {
    const current = get().current;
    if (!current) return;
    set((state) => ({
      current: { ...current, ...patch },
      // 工程栏显示的是 projects 列表里的副本；不同步的话，在主程序页改名后
      // 左侧工程名会一直停留在旧值。
      projects: sortProjects(
        state.projects.map((project) =>
          project.id === current.id ? { ...project, ...patch } : project,
        ),
      ),
    }));
    get().scheduleSave();
  },

  updateOptions({ encryptOptions, packageOptions }) {
    const current = get().current;
    if (!current) return;
    set({
      current: {
        ...current,
        encryptOptions: encryptOptions
          ? { ...current.encryptOptions, ...encryptOptions }
          : current.encryptOptions,
        packageOptions: packageOptions
          ? { ...current.packageOptions, ...packageOptions }
          : current.packageOptions,
      },
    });
    get().scheduleSave();
  },

  updateBuildOptions(patch) {
    const current = get().current;
    if (!current) return;
    set({
      current: {
        ...current,
        buildOptions: { ...current.buildOptions, ...patch },
      },
    });
    get().scheduleSave();
  },

  async rename(id, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const current = get().current;
    if (current?.id === id) {
      get().update({ name: trimmed });
      await get().flush();
      return;
    }
    const project = await api.loadProject(id);
    await api.saveProject({ ...project, name: trimmed });
    set((state) => ({
      projects: sortProjects(
        state.projects.map((item) =>
          item.id === id ? { ...item, name: trimmed } : item,
        ),
      ),
    }));
  },

  async reload(id) {
    // 先把 600ms 防抖里的修改落盘，再从磁盘重新读；这样外部删文件/改 JSON
    // 都能反映出来，同时不会丢掉用户刚输入还没保存的内容。
    await get().flush();
    const project = await api.loadProject(id);
    if (get().current?.id === id) {
      set({ current: project, saveState: "idle" });
    }
    set((state) => ({
      projects: sortProjects(
        state.projects.map((item) => (item.id === id ? project : item)),
      ),
    }));
    return project;
  },

  scheduleSave() {
    const current = get().current;
    if (!current) return;
    pending = snapshot(current);
    set({ saveState: "saving" });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void get().flush();
    }, SAVE_DELAY);
  },

  async flush() {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    const project = pending;
    pending = null;
    if (!project) return;
    try {
      await api.saveProject(project);
      if (get().current?.id === project.id) set({ saveState: "saved" });
    } catch (error) {
      set({ saveState: "error" });
      throw error;
    }
  },

  discard() {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    pending = null;
  },
}));
