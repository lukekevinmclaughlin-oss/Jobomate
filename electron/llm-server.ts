import * as http from "http";
import * as crypto from "crypto";
import express = require("express");
import type { NextFunction, Request, Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  active: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserController {
  listTabs: () => Promise<BrowserTab[]>;
  getCurrentTab: () => Promise<BrowserTab | null>;
  createTab: (url?: string, active?: boolean) => Promise<BrowserTab>;
  closeTab: (tabId?: string) => Promise<{
    success: boolean;
    closedTabId: string;
    newActiveTabId: string | null;
  }>;
  switchTab: (tabId: string) => Promise<BrowserTab>;
  navigate: (url: string, tabId?: string) => Promise<BrowserTab>;
  goBack: (tabId?: string) => Promise<{ success: boolean }>;
  goForward: (tabId?: string) => Promise<{ success: boolean }>;
  reload: (tabId?: string) => Promise<{ success: boolean }>;
  stop: (tabId?: string) => Promise<{ success: boolean }>;
  getContent: (
    format?: "text" | "html",
    tabId?: string
  ) => Promise<Record<string, unknown>>;
  executeJS: (code: string, tabId?: string) => Promise<{ result: unknown }>;
  click: (
    selector: string,
    tabId?: string
  ) => Promise<{ success: boolean; found: boolean; selector: string }>;
  fill: (
    selector: string,
    value: string,
    tabId?: string
  ) => Promise<{ success: boolean; found: boolean; selector: string }>;
  waitFor: (
    selector: string,
    timeout?: number,
    tabId?: string
  ) => Promise<{ found: boolean; selector: string; elapsed: number }>;
  screenshot: (tabId?: string) => Promise<{
    screenshot: string;
    dataUrl: string;
    format: "png";
  }>;
  getCookies: (tabId?: string) => Promise<{ cookies: unknown[] }>;
  setCookie: (
    cookie: Record<string, unknown>,
    tabId?: string
  ) => Promise<{ success: boolean }>;
  clearCookies: (tabId?: string) => Promise<{ success: boolean }>;
}

export interface ControlApiMethod {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Single source of truth for the Control API surface. Every case in
// LLMBrowserServer.dispatch() MUST have exactly one entry here (and vice versa);
// the unit suite (tests/control-api-parity.test.ts) regexes the dispatch switch
// and fails on any drift. listTools() is generated from this list, so the
// advertised catalog can never fall out of sync with what is dispatchable.
export const CONTROL_API_METHODS: ControlApiMethod[] = [
  { name: "browser.navigate", description: "Navigate to a URL", parameters: { url: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.go_back", description: "Go back in history", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.go_forward", description: "Go forward in history", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.reload", description: "Reload the current page", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.stop", description: "Stop loading the current page", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.get_content", description: "Get page content as text or HTML", parameters: { format: { type: "string", enum: ["text", "html"], default: "text" }, tabId: { type: "string", optional: true } } },
  { name: "browser.get_html", description: "Get full page HTML", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.get_text", description: "Get page text content", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.get_title", description: "Get page title", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.get_url", description: "Get current URL", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.execute_js", description: "Execute JavaScript in the page", parameters: { code: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.click", description: "Click an element by CSS selector", parameters: { selector: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.fill", description: "Fill an input field", parameters: { selector: { type: "string", required: true }, value: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.submit", description: "Submit a form (defaults to the first <form>)", parameters: { selector: { type: "string", optional: true, default: "form" }, tabId: { type: "string", optional: true } } },
  { name: "browser.scroll", description: "Scroll the page to absolute coordinates", parameters: { x: { type: "number", default: 0 }, y: { type: "number", default: 0 }, tabId: { type: "string", optional: true } } },
  { name: "browser.scroll_to", description: "Scroll an element into view by CSS selector", parameters: { selector: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.hover", description: "Hover an element (dispatches mouseenter/mouseover)", parameters: { selector: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.select", description: "Select a <select> option by value", parameters: { selector: { type: "string", required: true }, value: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.press_key", description: "Press a key on the focused element (keydown/keyup)", parameters: { key: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.upload_file", description: "Not yet supported — always returns uploadSupported:false (programmatic upload needs a native file-picker workflow)", parameters: { selector: { type: "string", optional: true }, path: { type: "string", optional: true } } },
  { name: "browser.focus", description: "Focus an element by CSS selector", parameters: { selector: { type: "string", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.screenshot", description: "Take a page screenshot (base64 PNG)", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.get_tabs", description: "List open tabs", parameters: {} },
  { name: "browser.new_tab", description: "Create a new tab", parameters: { url: { type: "string", optional: true }, active: { type: "boolean", default: true } } },
  { name: "browser.close_tab", description: "Close a tab (active tab if no tabId)", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.switch_tab", description: "Switch to a tab", parameters: { tabId: { type: "string", required: true } } },
  { name: "browser.wait_for", description: "Wait for an element to appear", parameters: { selector: { type: "string", required: true }, timeout: { type: "number", default: 10000 }, tabId: { type: "string", optional: true } } },
  { name: "browser.wait_for_timeout", description: "Wait for a fixed delay in milliseconds", parameters: { timeout: { type: "number", default: 1000 } } },
  { name: "browser.get_cookies", description: "Get cookies", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.set_cookie", description: "Set a cookie", parameters: { cookie: { type: "object", required: true }, tabId: { type: "string", optional: true } } },
  { name: "browser.clear_cookies", description: "Clear cookies", parameters: { tabId: { type: "string", optional: true } } },
  { name: "browser.list_tools", description: "List available tools", parameters: {} },
  { name: "browser.get_info", description: "Get browser information", parameters: {} },
];

interface LLMToolRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface LLMToolResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class LLMBrowserServer {
  private app: express.Application;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private connections: Map<string, WebSocket> = new Map();
  private startedAt = 0;
  private controller: BrowserController;
  private port: number;
  private authToken: string;

  constructor(controller: BrowserController, port = 9222, authToken?: string) {
    this.controller = controller;
    this.port = port;
    // A per-launch bearer token gates every control endpoint (except /health).
    this.authToken =
      authToken ||
      process.env.JOBOMATE_BRIDGE_TOKEN ||
      crypto.randomBytes(32).toString("hex");
    this.app = express();
    this.setupExpress();
  }

  getAuthToken(): string {
    return this.authToken;
  }

  setController(controller: BrowserController): void {
    this.controller = controller;
  }

  setPort(port: number): void {
    if (this.isRunning()) {
      throw new Error("Cannot change the LLM server port while it is running");
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("Port must be an integer between 1024 and 65535");
    }
    this.port = port;
  }

  private setupExpress(): void {
    this.app.use(express.json({ limit: "50mb" }));

    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        name: "Jobomate",
        version: "1.0.0",
        protocol: "json-rpc-2.0 + REST",
        port: this.port,
        running: this.isRunning(),
        connections: this.connections.size,
        uptime: this.getUptime(),
        endpoints: {
          health: "GET /health",
          rpc: "POST /api/rpc",
          tabs: "GET /api/tabs",
          content: "GET /api/content",
          screenshot: "GET /api/screenshot",
          sse: "GET /api/sse",
          ws: `ws://127.0.0.1:${this.port}/ws`,
        },
      });
    });

    // Everything under /api requires a loopback Host header (anti DNS-rebinding),
    // a local/absent Origin and a valid bearer token. /health stays open.
    this.app.use("/api", (req: Request, res: Response, next: NextFunction) => {
      this.applyGuard(req, res, next);
    });

    this.app.post("/api/rpc", async (req: Request, res: Response) => {
      try {
        const response = await this.handleToolCall(req.body as LLMToolRequest);
        res.json(response);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({
          jsonrpc: "2.0",
          id: (req.body as LLMToolRequest | undefined)?.id ?? null,
          error: { code: -32603, message },
        });
      }
    });

    this.app.get("/api/tabs", async (_req: Request, res: Response) => {
      try {
        res.json({ tabs: await this.controller.listTabs() });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    });

    this.app.get("/api/content", async (req: Request, res: Response) => {
      try {
        const format = req.query.format === "html" ? "html" : "text";
        const tabId = typeof req.query.tabId === "string" ? req.query.tabId : undefined;
        res.json(await this.controller.getContent(format, tabId));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    });

    this.app.get("/api/screenshot", async (req: Request, res: Response) => {
      try {
        const tabId = typeof req.query.tabId === "string" ? req.query.tabId : undefined;
        res.json(await this.controller.screenshot(tabId));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    });

    this.app.get("/api/sse", (_req: Request, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "connected", port: this.port })}\n\n`);
      const interval = setInterval(() => {
        res.write(": keepalive\n\n");
      }, 15000);
      res.on("close", () => clearInterval(interval));
    });
  }

  private setupWebSocket(): void {
    if (!this.server) return;

    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });

    this.wss.on("connection", (ws: WebSocket, req) => {
      const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
      const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
      if (!this.isHostAllowed(host) || !this.isOriginAllowed(origin)) {
        ws.close(1008, "Origin not allowed");
        return;
      }
      let token = this.tokenFromHeaders(req.headers);
      try {
        const parsed = new URL(req.url || "/ws", `http://${host || "127.0.0.1"}`);
        token = parsed.searchParams.get("token") || token;
      } catch {
        /* ignore malformed url */
      }
      if (!this.tokenMatches(token)) {
        ws.close(1008, "Unauthorized");
        return;
      }

      const connId = uuidv4();
      this.connections.set(connId, ws);

      ws.send(
        JSON.stringify({
          type: "connected",
          connectionId: connId,
          port: this.port,
          protocol: "json-rpc-2.0",
        })
      );

      ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString()) as LLMToolRequest;
          const response = await this.handleToolCall(msg);
          ws.send(JSON.stringify(response));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: `Parse error: ${message}` },
            })
          );
        }
      });

      ws.on("close", () => {
        this.connections.delete(connId);
      });
    });
  }

  private applyGuard(req: Request, res: Response, next: NextFunction): void {
    if (!this.isHostAllowed(req.headers.host)) {
      res.status(403).json({ error: "Forbidden: Host header must be loopback" });
      return;
    }
    if (!this.isOriginAllowed(req.headers.origin)) {
      res.status(403).json({ error: "Forbidden: cross-origin requests are not allowed" });
      return;
    }
    if (!this.tokenMatches(this.tokenFromHeaders(req.headers))) {
      res.status(401).json({
        error:
          "Unauthorized: missing or invalid bridge token (Authorization: Bearer <token> or X-Jobomate-Bridge-Token)",
      });
      return;
    }
    next();
  }

  private isHostAllowed(hostHeader: string | string[] | undefined): boolean {
    const value = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (!value) return false;
    const hostname = value.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  }

  private isOriginAllowed(origin: string | string[] | undefined): boolean {
    const value = Array.isArray(origin) ? origin[0] : origin;
    if (!value) return true;
    try {
      const parsed = new URL(value);
      return (
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1"
      );
    } catch {
      return value === "file://";
    }
  }

  private tokenFromHeaders(headers: http.IncomingHttpHeaders): string | null {
    const auth = headers.authorization;
    if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
      return auth.replace(/^Bearer\s+/i, "").trim();
    }
    const custom = headers["x-jobomate-bridge-token"];
    if (typeof custom === "string" && custom.trim()) return custom.trim();
    return null;
  }

  private tokenMatches(provided: string | null): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.authToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private async handleToolCall(request: LLMToolRequest): Promise<LLMToolResponse> {
    const id = request.id ?? null;
    const method = request.method;
    const params = request.params || {};

    if (request.jsonrpc !== "2.0" || !method) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      };
    }

    try {
      const result = await this.dispatch(method, params);
      return { jsonrpc: "2.0", id, result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `Tool error: ${message}` },
      };
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const tabId = typeof params.tabId === "string" ? params.tabId : undefined;

    switch (method) {
      case "browser.navigate":
        return this.controller.navigate(String(params.url || ""), tabId);
      case "browser.go_back":
        return this.controller.goBack(tabId);
      case "browser.go_forward":
        return this.controller.goForward(tabId);
      case "browser.reload":
        return this.controller.reload(tabId);
      case "browser.stop":
        return this.controller.stop(tabId);
      case "browser.get_content":
        return this.controller.getContent(
          params.format === "html" ? "html" : "text",
          tabId
        );
      case "browser.get_html":
        return this.controller.getContent("html", tabId);
      case "browser.get_text":
        return this.controller.getContent("text", tabId);
      case "browser.get_title": {
        const tab = tabId
          ? (await this.controller.listTabs()).find((item) => item.id === tabId)
          : await this.controller.getCurrentTab();
        if (!tab) throw new Error("Tab not found");
        return { title: tab.title, url: tab.url };
      }
      case "browser.get_url": {
        const tab = tabId
          ? (await this.controller.listTabs()).find((item) => item.id === tabId)
          : await this.controller.getCurrentTab();
        if (!tab) throw new Error("Tab not found");
        return { url: tab.url, title: tab.title };
      }
      case "browser.execute_js":
        return this.controller.executeJS(String(params.code || ""), tabId);
      case "browser.click":
        return this.controller.click(String(params.selector || ""), tabId);
      case "browser.fill":
        return this.controller.fill(
          String(params.selector || ""),
          String(params.value ?? ""),
          tabId
        );
      case "browser.submit":
        return this.submitForm(String(params.selector || "form"), tabId);
      case "browser.scroll":
        return this.scrollPage(Number(params.x || 0), Number(params.y || 0), tabId);
      case "browser.scroll_to":
        return this.scrollToElement(String(params.selector || ""), tabId);
      case "browser.hover":
        return this.hoverElement(String(params.selector || ""), tabId);
      case "browser.select":
        return this.selectOption(
          String(params.selector || ""),
          String(params.value ?? ""),
          tabId
        );
      case "browser.press_key":
        return this.pressKey(String(params.key || ""), tabId);
      case "browser.upload_file":
        return {
          success: false,
          uploadSupported: false,
          note: "Programmatic file upload requires a native file picker workflow.",
        };
      case "browser.focus":
        return this.focusElement(String(params.selector || ""), tabId);
      case "browser.screenshot":
        return this.controller.screenshot(tabId);
      case "browser.get_tabs":
        return { tabs: await this.controller.listTabs() };
      case "browser.new_tab":
        return this.controller.createTab(
          typeof params.url === "string" ? params.url : undefined,
          params.active !== false
        );
      case "browser.close_tab":
        return this.controller.closeTab(tabId);
      case "browser.switch_tab":
        if (!tabId) throw new Error("tabId is required");
        return this.controller.switchTab(tabId);
      case "browser.wait_for":
        return this.controller.waitFor(
          String(params.selector || ""),
          Number(params.timeout || 10000),
          tabId
        );
      case "browser.wait_for_timeout":
        return this.waitForTimeout(Number(params.timeout || 1000));
      case "browser.get_cookies":
        return this.controller.getCookies(tabId);
      case "browser.set_cookie":
        // Accept both the documented nested form {cookie:{...}} and the flat
        // {name,value,...} form that external clients commonly send.
        return this.controller.setCookie(
          (params.cookie as Record<string, unknown>) ||
            (params.name !== undefined ? (params as Record<string, unknown>) : {}),
          tabId
        );
      case "browser.clear_cookies":
        return this.controller.clearCookies(tabId);
      case "browser.list_tools":
        return this.listTools();
      case "browser.get_info":
        return {
          name: "Jobomate",
          version: "1.0.0",
          port: this.port,
          platform: process.platform,
          nodeVersion: process.versions.node,
        };
      default:
        return {
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
            availableMethods: this.listTools().tools.map((tool) => tool.name),
          },
        };
    }
  }

  private async submitForm(selector: string, tabId?: string): Promise<unknown> {
    const selectorJson = JSON.stringify(selector || "form");
    return this.controller.executeJS(
      `
      (() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { success: false, found: false };
        if (typeof el.requestSubmit === 'function') el.requestSubmit();
        else el.submit();
        return { success: true, found: true };
      })()
    `,
      tabId
    );
  }

  private async scrollPage(x: number, y: number, tabId?: string): Promise<unknown> {
    return this.controller.executeJS(
      `window.scrollTo(${JSON.stringify(x)}, ${JSON.stringify(y)}); ({ success: true, scrollX: window.scrollX, scrollY: window.scrollY })`,
      tabId
    );
  }

  private async scrollToElement(selector: string, tabId?: string): Promise<unknown> {
    const selectorJson = JSON.stringify(selector);
    return this.controller.executeJS(
      `
      (() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { success: false, found: false };
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        return { success: true, found: true };
      })()
    `,
      tabId
    );
  }

  private async hoverElement(selector: string, tabId?: string): Promise<unknown> {
    const selectorJson = JSON.stringify(selector);
    return this.controller.executeJS(
      `
      (() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { success: false, found: false };
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { success: true, found: true };
      })()
    `,
      tabId
    );
  }

  private async selectOption(
    selector: string,
    value: string,
    tabId?: string
  ): Promise<unknown> {
    const selectorJson = JSON.stringify(selector);
    const valueJson = JSON.stringify(value);
    return this.controller.executeJS(
      `
      (() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { success: false, found: false };
        el.value = ${valueJson};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, found: true };
      })()
    `,
      tabId
    );
  }

  private async pressKey(key: string, tabId?: string): Promise<unknown> {
    const keyJson = JSON.stringify(key);
    return this.controller.executeJS(
      `
      (() => {
        const key = ${keyJson};
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        return { success: true, key };
      })()
    `,
      tabId
    );
  }

  private async focusElement(selector: string, tabId?: string): Promise<unknown> {
    const selectorJson = JSON.stringify(selector);
    return this.controller.executeJS(
      `
      (() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { success: false, found: false };
        el.focus();
        return { success: true, found: true };
      })()
    `,
      tabId
    );
  }

  private async waitForTimeout(timeout: number): Promise<{ elapsed: number }> {
    await new Promise((resolve) => setTimeout(resolve, timeout));
    return { elapsed: timeout };
  }

  private listTools(): { tools: ControlApiMethod[] } {
    // Generated from CONTROL_API_METHODS so the advertised catalog always matches
    // every method dispatch() implements (33 methods). Copies guard against mutation.
    return { tools: CONTROL_API_METHODS.map((method) => ({ ...method })) };
  }

  async start(attemptsLeft = 10): Promise<number> {
    if (this.isRunning()) return this.port;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.app);
      this.setupWebSocket();

      this.server.listen(this.port, "127.0.0.1", () => {
        this.startedAt = Date.now();
        console.log(
          `[LLM Server] Jobomate control server running on http://127.0.0.1:${this.port}`
        );
        resolve(this.port);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attemptsLeft > 1) {
          this.port += 1;
          this.server?.close();
          this.server = null;
          this.start(attemptsLeft - 1).then(resolve).catch(reject);
        } else if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Jobomate control server could not bind a free port near ${this.port} after 10 attempts`
            )
          );
        } else {
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    for (const [, ws] of this.connections) {
      ws.close(1000, "Server shutting down");
    }
    this.connections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.server = null;
        this.startedAt = 0;
        resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return Boolean(this.server?.listening);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getUptime(): number {
    return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
  }
}

let serverInstance: LLMBrowserServer | null = null;

export function getLlmServer(controller?: BrowserController): LLMBrowserServer {
  if (!serverInstance) {
    if (!controller) {
      throw new Error("LLM server has not been initialized");
    }
    serverInstance = new LLMBrowserServer(controller);
  } else if (controller) {
    serverInstance.setController(controller);
  }
  return serverInstance;
}

export async function startLlmServer(
  controller: BrowserController,
  port?: number
): Promise<number> {
  const server = getLlmServer(controller);
  if (port && !server.isRunning()) {
    server.setPort(port);
  }
  return server.start();
}

export async function stopLlmServer(): Promise<void> {
  if (serverInstance) {
    await serverInstance.stop();
    serverInstance = null;
  }
}
