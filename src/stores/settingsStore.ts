import { create } from "zustand";
import { BrowserSettings, LLMServerStatus } from "../types";

interface SettingsState {
  settings: BrowserSettings;
  llmStatus: LLMServerStatus;
  updateSettings: (updates: Partial<BrowserSettings>) => void;
  resetSettings: () => void;
  setLlmStatus: (status: Partial<LLMServerStatus>) => void;
}

const defaultSettings: BrowserSettings = {
  homepage: "https://www.google.com",
  searchEngine: "google",
  newTabPage: "homepage",
  llmServerPort: 9222,
  llmServerAutoStart: true,
  enableLLMServer: true,
  theme: "system",
  showBookmarkBar: true,
  downloadPath: "",
  clearDataOnExit: false,
};

const defaultLlmStatus: LLMServerStatus = {
  running: false,
  port: 9222,
  connections: 0,
  uptime: 0,
};

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...defaultSettings },
  llmStatus: { ...defaultLlmStatus },

  updateSettings: (updates: Partial<BrowserSettings>) => {
    set((state) => ({
      settings: { ...state.settings, ...updates },
    }));
    // Persist to localStorage
    try {
      const current = JSON.parse(
        localStorage.getItem("llm_browser_settings") || "{}"
      );
      localStorage.setItem(
        "llm_browser_settings",
        JSON.stringify({ ...current, ...updates })
      );
    } catch {
      // Ignore localStorage errors
    }
  },

  resetSettings: () => {
    set({ settings: { ...defaultSettings } });
    try {
      localStorage.removeItem("llm_browser_settings");
    } catch {
      // Ignore localStorage errors
    }
  },

  setLlmStatus: (status: Partial<LLMServerStatus>) => {
    set((state) => ({
      llmStatus: { ...state.llmStatus, ...status },
    }));
  },
}));

// Load persisted settings on import
try {
  const saved = localStorage.getItem("llm_browser_settings");
  if (saved) {
    const parsed = JSON.parse(saved);
    useSettingsStore.getState().updateSettings(parsed);
  }
} catch {
  // Ignore
}
