import { create } from "zustand";
import { DownloadItem } from "../types";

const STORAGE_KEY = "llm_browser_downloads";
const MAX_ITEMS = 200;

interface DownloadState {
  items: DownloadItem[];
  upsert: (item: DownloadItem) => void;
  syncActive: (items: DownloadItem[]) => void;
  removeItem: (id: string) => void;
  clearCompleted: () => void;
}

function load(): DownloadItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A download that was still progressing when the app closed can never
    // resume, so surface it as interrupted rather than stuck at 0%.
    return parsed.map((item: DownloadItem) =>
      item.state === "progressing" ? { ...item, state: "interrupted" } : item
    );
  } catch {
    return [];
  }
}

function persist(items: DownloadItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

export const useDownloadStore = create<DownloadState>((set) => ({
  items: load(),

  upsert: (item: DownloadItem) => {
    set((state) => {
      const exists = state.items.some((d) => d.id === item.id);
      const items = (
        exists
          ? state.items.map((d) => (d.id === item.id ? { ...d, ...item } : d))
          : [item, ...state.items]
      ).slice(0, MAX_ITEMS);
      persist(items);
      return { items };
    });
  },

  // Merge the authoritative list of in-flight downloads from the main process
  // with any persisted history, keeping a single entry per id.
  syncActive: (active: DownloadItem[]) => {
    set((state) => {
      const byId = new Map(state.items.map((d) => [d.id, d]));
      for (const item of active) byId.set(item.id, { ...byId.get(item.id), ...item });
      const items = Array.from(byId.values())
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, MAX_ITEMS);
      persist(items);
      return { items };
    });
  },

  removeItem: (id: string) => {
    set((state) => {
      const items = state.items.filter((d) => d.id !== id);
      persist(items);
      return { items };
    });
  },

  clearCompleted: () => {
    set((state) => {
      const items = state.items.filter((d) => d.state === "progressing");
      persist(items);
      return { items };
    });
  },
}));
