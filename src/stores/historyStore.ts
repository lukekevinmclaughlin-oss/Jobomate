import { create } from "zustand";
import { HistoryEntry } from "../types";
import { v4 as uuidv4 } from "uuid";

const STORAGE_KEY = "llm_browser_history";
const MAX_ENTRIES = 1000;

interface HistoryState {
  entries: HistoryEntry[];
  addVisit: (url: string, title: string, typed?: boolean) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
  searchHistory: (query: string) => HistoryEntry[];
}

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* ignore quota / serialization errors */
  }
}

function isRecordable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: load(),

  addVisit: (url: string, title: string, typed = false) => {
    if (!isRecordable(url)) return;
    set((state) => {
      const [latest] = state.entries;
      // Collapse consecutive visits to the same URL into one entry.
      if (latest && latest.url === url) {
        const updated: HistoryEntry = {
          ...latest,
          title: title || latest.title,
          visitTime: Date.now(),
          visitCount: latest.visitCount + 1,
          typedCount: latest.typedCount + (typed ? 1 : 0),
        };
        const entries = [updated, ...state.entries.slice(1)];
        persist(entries);
        return { entries };
      }

      const prior = state.entries.find((e) => e.url === url);
      const entry: HistoryEntry = {
        id: uuidv4(),
        url,
        title: title || url,
        visitTime: Date.now(),
        visitCount: (prior?.visitCount ?? 0) + 1,
        typedCount: (prior?.typedCount ?? 0) + (typed ? 1 : 0),
      };
      const entries = [entry, ...state.entries].slice(0, MAX_ENTRIES);
      persist(entries);
      return { entries };
    });
  },

  removeEntry: (id: string) => {
    set((state) => {
      const entries = state.entries.filter((e) => e.id !== id);
      persist(entries);
      return { entries };
    });
  },

  clearHistory: () => {
    persist([]);
    set({ entries: [] });
  },

  searchHistory: (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return get().entries;
    return get().entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)
    );
  },
}));
