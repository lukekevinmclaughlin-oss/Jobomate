import { describe, it, expect, beforeEach } from "vitest";
import { LlmConnectionManager } from "../electron/llm-connection";
import type { BrowserController, BrowserTab } from "../electron/llm-server";

// Regression tests for the browser_tabs argument-alias fix: models often send
// {op: "new_tab"} (the generic `browser` router and external docs use op names)
// while the schema documents {action: "new"}. dispatchBrowserTabs must accept
// "op" as an alias for "action" and normalize new_tab/create→new,
// switch_tab→switch, close_tab→close.

interface Call { name: string; args: unknown[] }

function makeController(calls: Call[]): BrowserController {
  const tab: BrowserTab = {
    id: "tab_1",
    url: "about:blank",
    title: "New Tab",
    active: true,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const log = <T>(name: string, args: unknown[], ret: T): T => {
    calls.push({ name, args });
    return ret;
  };
  return {
    listTabs: async () => log("listTabs", [], [tab]),
    getCurrentTab: async () => tab,
    createTab: async (url?: string, active?: boolean) =>
      log("createTab", [url, active], { ...tab, id: "tab_2", url: url || "about:blank" }),
    closeTab: async (tabId?: string) =>
      log("closeTab", [tabId], { success: true, closedTabId: tabId || "tab_1", newActiveTabId: null }),
    switchTab: async (tabId: string) => log("switchTab", [tabId], tab),
    navigate: async () => tab,
    goBack: async () => ({ success: true }),
    goForward: async () => ({ success: true }),
    reload: async () => ({ success: true }),
    stop: async () => ({ success: true }),
    getContent: async () => ({}),
    executeJS: async () => ({ result: null }),
    click: async (selector: string) => ({ success: true, found: true, selector }),
    fill: async (selector: string) => ({ success: true, found: true, selector }),
    waitFor: async (selector: string) => ({ found: true, selector, elapsed: 0 }),
    screenshot: async () => ({ screenshot: "", dataUrl: "data:image/png;base64,", format: "png" as const }),
    getCookies: async () => ({ cookies: [] }),
    setCookie: async () => ({ success: true }),
    clearCookies: async () => ({ success: true }),
  };
}

type Dispatcher = {
  dispatchBrowserTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

describe("browser_tabs action/op aliases", () => {
  let calls: Call[];
  let mgr: Dispatcher;

  beforeEach(() => {
    calls = [];
    mgr = new LlmConnectionManager(() => makeController(calls)) as unknown as Dispatcher;
  });

  it('action:"new" creates a tab (documented form)', async () => {
    await mgr.dispatchBrowserTool("browser_tabs", { action: "new", url: "https://example.com/" });
    expect(calls[0]).toEqual({ name: "createTab", args: ["https://example.com/", true] });
  });

  it('op:"new_tab" creates a tab (alias + normalization)', async () => {
    await mgr.dispatchBrowserTool("browser_tabs", { op: "new_tab", url: "https://example.com/" });
    expect(calls[0]).toEqual({ name: "createTab", args: ["https://example.com/", true] });
  });

  it('op:"create" creates a tab', async () => {
    await mgr.dispatchBrowserTool("browser_tabs", { op: "create", url: "https://example.com/" });
    expect(calls[0].name).toBe("createTab");
  });

  it('op:"switch_tab" switches', async () => {
    await mgr.dispatchBrowserTool("browser_tabs", { op: "switch_tab", tabId: "tab_1" });
    expect(calls[0]).toEqual({ name: "switchTab", args: ["tab_1"] });
  });

  it('op:"close_tab" closes', async () => {
    await mgr.dispatchBrowserTool("browser_tabs", { op: "close_tab", tabId: "tab_2" });
    expect(calls[0]).toEqual({ name: "closeTab", args: ["tab_2"] });
  });

  it("no action/op defaults to list", async () => {
    await mgr.dispatchBrowserTool("browser_tabs", {});
    expect(calls[0].name).toBe("listTabs");
  });

  it('op:"list" lists', async () => {
    await mgr.dispatchBrowserTool("browser_tabs", { op: "list" });
    expect(calls[0].name).toBe("listTabs");
  });

  it('"action" wins when both action and op are present', async () => {
    await mgr.dispatchBrowserTool("browser_tabs", { action: "new", op: "close_tab", url: "https://x.test/" });
    expect(calls[0].name).toBe("createTab");
  });

  it("generic browser router: {op:'new_tab'} reaches createTab end-to-end", async () => {
    await mgr.dispatchBrowserTool("browser", {
      input: JSON.stringify({ op: "new_tab", url: "https://example.org/" }),
    });
    expect(calls[0]).toEqual({ name: "createTab", args: ["https://example.org/", true] });
  });
});
