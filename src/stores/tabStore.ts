import { create } from "zustand";
import { Tab } from "../types";
import { v4 as uuidv4 } from "uuid";

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (url?: string) => string;
  syncTabs: (tabs: Array<Partial<Tab> & Pick<Tab, "id">>) => void;
  upsertTab: (tab: Partial<Tab> & Pick<Tab, "id">) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Tab>) => void;
  getActiveTab: () => Tab | undefined;
  getTabById: (id: string) => Tab | undefined;
  moveTab: (fromIndex: number, toIndex: number) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  closeAllTabs: () => void;
  duplicateTab: (id: string) => void;
  reloadTab: (id: string) => void;
}

const toTab = (tab: Partial<Tab> & Pick<Tab, "id">): Tab => {
  const url = tab.url || "about:blank";
  return {
    id: tab.id,
    url,
    title: tab.title || (url === "about:blank" ? "New Tab" : url),
    favicon: tab.favicon,
    isLoading: Boolean(tab.isLoading),
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    history: tab.history || [url],
    historyIndex: tab.historyIndex ?? 0,
  };
};

export const useTabStore = create<TabState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (url?: string) => {
    const id = uuidv4();
    const newTab: Tab = {
      id,
      url: url || "about:blank",
      title: "New Tab",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      history: [url || "about:blank"],
      historyIndex: 0,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
    }));
    return id;
  },

  syncTabs: (tabs) => {
    const nextTabs = tabs.map(toTab);
    const active = tabs.find((tab) => Boolean((tab as { active?: boolean }).active));
    set((state) => {
      const preservedActive = nextTabs.find((tab) => tab.id === state.activeTabId);
      return {
        tabs: nextTabs,
        activeTabId: active?.id || preservedActive?.id || nextTabs[0]?.id || null,
      };
    });
  },

  upsertTab: (tab) => {
    set((state) => {
      const nextTab = toTab({
        ...state.tabs.find((item) => item.id === tab.id),
        ...tab,
      });
      const exists = state.tabs.some((item) => item.id === tab.id);
      const tabs = exists
        ? state.tabs.map((item) => (item.id === tab.id ? nextTab : item))
        : [...state.tabs, nextTab];
      const activeTabId = (tab as { active?: boolean }).active
        ? tab.id
        : state.activeTabId || tab.id;
      return { tabs, activeTabId };
    });
  },

  removeTab: (id: string) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      const newTabs = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;
      if (state.activeTabId === id) {
        if (newTabs.length === 0) {
          newActiveId = null;
        } else if (idx >= newTabs.length) {
          newActiveId = newTabs[newTabs.length - 1].id;
        } else {
          newActiveId = newTabs[idx]?.id || newTabs[0]?.id;
        }
      }
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  setActiveTab: (id: string) =>
    set((state) =>
      state.tabs.some((tab) => tab.id === id) ? { activeTabId: id } : state
    ),

  updateTab: (id: string, updates: Partial<Tab>) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }));
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId);
  },

  getTabById: (id: string) => {
    return get().tabs.find((t) => t.id === id);
  },

  moveTab: (fromIndex: number, toIndex: number) => {
    set((state) => {
      const newTabs = [...state.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);
      return { tabs: newTabs };
    });
  },

  closeOtherTabs: (id: string) => {
    set((state) => ({
      tabs: state.tabs.filter((t) => t.id === id),
      activeTabId: id,
    }));
  },

  closeTabsToRight: (id: string) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return state;
      const newTabs = state.tabs.slice(0, idx + 1);
      const newActiveId = state.activeTabId && newTabs.find(t => t.id === state.activeTabId)
        ? state.activeTabId
        : id;
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  closeAllTabs: () => set({ tabs: [], activeTabId: null }),

  duplicateTab: (id: string) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    get().addTab(tab.url);
  },

  reloadTab: (id: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, isLoading: true } : t
      ),
    }));
  },
}));
