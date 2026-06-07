// ─── Tab Types ──────────────────────────────────────────────────────────

export interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  history: string[];
  historyIndex: number;
}

// ─── Bookmark Types ─────────────────────────────────────────────────────

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  favicon?: string;
  folder?: string;
  createdAt: number;
}

export interface BookmarkFolder {
  id: string;
  name: string;
  bookmarks: Bookmark[];
}

// ─── Settings Types ──────────────────────────────────────────────────────

export interface BrowserSettings {
  homepage: string;
  searchEngine: "google" | "bing" | "duckduckgo" | "custom";
  customSearchUrl?: string;
  newTabPage: "homepage" | "blank" | "custom";
  customNewTabUrl?: string;
  llmServerPort: number;
  llmServerAutoStart: boolean;
  enableLLMServer: boolean;
  theme: "system" | "light" | "dark";
  showBookmarkBar: boolean;
  downloadPath: string;
  clearDataOnExit: boolean;
}

// ─── LLM Server Types ────────────────────────────────────────────────────

export interface LLMServerStatus {
  running: boolean;
  port: number;
  connections: number;
  uptime: number;
}

// ─── Tool Call Types (for LLM API) ──────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ─── Omnibox Suggestion Types ────────────────────────────────────────────

export interface OmniboxSuggestion {
  type: "history" | "bookmark" | "search" | "url";
  title: string;
  url: string;
  description?: string;
}

// ─── Download Types ──────────────────────────────────────────────────────

export interface DownloadItem {
  id: string;
  url: string;
  filename: string;
  path: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  startTime: number;
  mimeType: string;
}

// ─── History Types ──────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitTime: number;
  visitCount: number;
  typedCount: number;
}
