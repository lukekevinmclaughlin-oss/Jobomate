import * as electron from "electron";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import {
  BrowserController,
  getLlmServer,
  startLlmServer,
  stopLlmServer,
} from "./llm-server";
import { LlmConnectionManager } from "./llm-connection";
import { startEngine, stopEngine, ENGINE_PORT } from "./jobomate-engine";

/**
 * Per-session shared secret for the loopback engine API. Generated fresh each launch, handed to the
 * engine process (env) and to the renderer (via the `jobomate:engine-info` IPC). The engine rejects
 * any HTTP request that doesn't echo it back in the X-Jobomate-Token header, so web pages opened in
 * the in-app browser cannot reach the engine cross-origin.
 */
const ENGINE_TOKEN = crypto.randomBytes(32).toString("hex");

interface TabSnapshot {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  active: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface TabRecord {
  id: string;
  view: electron.BrowserView;
  requestedUrl: string;
  title: string;
  favicon?: string;
  isLoading: boolean;
}

const devServerArg = process.argv.find((arg) => arg.startsWith("--dev-server="));
const devServerUrl =
  process.env.VITE_DEV_SERVER_URL ||
  devServerArg?.replace("--dev-server=", "") ||
  "";
// Dev iff a dev-server URL was provided (env or --dev-server). We deliberately do NOT also gate on
// !app.isPackaged: the dev shim renames the Electron binary to "Jobomate" (so the Dock reads
// "Jobomate"), which makes app.isPackaged a false-positive. A real packaged build never receives a
// dev-server URL, so this stays correct there.
const isDev = Boolean(devServerUrl);
const WINDOW_STATE_PATH = path.join(electron.app.getPath("userData"), "window-state.json");
const BRIDGE_AUTH_PATH = path.join(electron.app.getPath("userData"), "bridge-auth.json");
const DEFAULT_HOME = "https://www.google.com";

// Persist the browser-control server port + per-launch bearer token (0600) so
// trusted external automation clients can discover how to authenticate.
function writeBridgeAuthFile(port: number, token: string): void {
  try {
    fs.writeFileSync(
      BRIDGE_AUTH_PATH,
      JSON.stringify({ port, token, url: `http://127.0.0.1:${port}` }, null, 2),
      { mode: 0o600 }
    );
    fs.chmodSync(BRIDGE_AUTH_PATH, 0o600);
  } catch (error) {
    console.error("[LLM Server] Failed to write bridge auth file:", (error as Error).message);
  }
}

function removeBridgeAuthFile(): void {
  try {
    fs.rmSync(BRIDGE_AUTH_PATH, { force: true });
  } catch {
    /* ignore */
  }
}
const FALLBACK_CONTENT_TOP = 92;

// All web browsing happens in a dedicated, persistent session — isolated from the app's own
// storage (settings/history/bookmarks). So the user can clear cookies, cache and site data like
// any browser, without wiping the app's configuration.
const BROWSING_PARTITION = "persist:jobomate-web";
const browsingSession = (): electron.Session => electron.session.fromPartition(BROWSING_PARTITION);

let mainWindow: electron.BrowserWindow | null = null;
const browserViews: Map<string, TabRecord> = new Map();
let activeTabId: string | null = null;
let tabCounter = 0;
let browserBounds: electron.Rectangle | null = null;
let llmConnectionManager: LlmConnectionManager | null = null;

electron.app.setName("Jobomate");
electron.app.setAppUserModelId("com.jobomate.app");

// Single-instance: a second launch focuses the existing window instead of starting a duplicate
// (which would collide on the control-server / engine ports). gotLock gates app startup so a
// losing instance exits WITHOUT running whenReady (which would otherwise bind the ports and crash).
const gotSingleInstanceLock = electron.app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const APP_ICON_PATH = path.join(__dirname, "../assets/jobomate-logo.png");

function applyDockIcon(): void {
  // On macOS the BrowserWindow `icon` option and electron-builder's .icns are
  // ignored when running unpackaged (`electron .`), so the Dock shows the
  // default Electron icon. Set it explicitly from the brand logo.
  if (process.platform !== "darwin" || !electron.app.dock) return;
  const icon = electron.nativeImage.createFromPath(APP_ICON_PATH);
  if (!icon.isEmpty()) {
    electron.app.dock.setIcon(icon);
  }
}

electron.app.on("open-url", (event, url) => {
  event.preventDefault();
  llmConnectionManager?.handleOAuthCallback(url).then((message) => {
    mainWindow?.webContents.send("llmConnection:oauth-updated", { message });
  }).catch((error: Error) => {
    mainWindow?.webContents.send("llmConnection:oauth-updated", {
      message: error.message,
      error: true,
    });
  });
});

interface DownloadSnapshot {
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

const downloads: Map<string, electron.DownloadItem> = new Map();
let downloadCounter = 0;

function downloadDirectory(): string {
  try {
    return electron.app.getPath("downloads");
  } catch {
    return electron.app.getPath("temp");
  }
}

// Avoid clobbering an existing file: "report.pdf" -> "report (1).pdf".
function uniqueSavePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${counter})${ext}`);
    counter += 1;
  }
  return candidate;
}

function serializeDownload(
  id: string,
  item: electron.DownloadItem
): DownloadSnapshot {
  return {
    id,
    url: item.getURL(),
    filename: item.getFilename(),
    path: item.getSavePath(),
    totalBytes: item.getTotalBytes(),
    receivedBytes: item.getReceivedBytes(),
    state: item.getState(),
    startTime: Math.round(item.getStartTime() * 1000),
    mimeType: item.getMimeType(),
  };
}

function emitDownload(channel: string, payload: DownloadSnapshot): void {
  mainWindow?.webContents.send(channel, payload);
}

function setupDownloads(): void {
  // Downloads originate from the browsing session (where the BrowserViews live).
  browsingSession().on("will-download", (_event, item) => {
    const id = `dl-${++downloadCounter}`;
    downloads.set(id, item);

    // Chrome-style: save straight to the Downloads folder without a prompt.
    try {
      item.setSavePath(uniqueSavePath(downloadDirectory(), item.getFilename()));
    } catch {
      /* fall back to Electron's default save dialog */
    }

    emitDownload("download:started", serializeDownload(id, item));
    item.on("updated", () => emitDownload("download:updated", serializeDownload(id, item)));
    item.once("done", () => emitDownload("download:updated", serializeDownload(id, item)));
  });
}

function createMainWindow(): void {
  let savedBounds: Partial<electron.Rectangle> = {};
  try {
    if (fs.existsSync(WINDOW_STATE_PATH)) {
      savedBounds = JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, "utf-8"));
    }
  } catch { /* use defaults */ }
  mainWindow = new electron.BrowserWindow({
    width: savedBounds.width || 1400,
    height: savedBounds.height || 900,
    minWidth: 800,
    minHeight: 500,
    title: "Jobomate",
    icon: APP_ICON_PATH,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("resize", updateVisibleBrowserViewBounds);

  const saveWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify(mainWindow.getBounds())); } catch { /* ignore */ }
  };
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);


  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function setupApplicationMenu(): void {
  const template: electron.MenuItemConstructorOptions[] = [
    {
      label: "Jobomate",
      submenu: [
        { role: "about", label: "About Jobomate" },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CommandOrControl+,",
          click: () => mainWindow?.webContents.send("shortcut:toggle-settings"),
        },
        { type: "separator" },
        { role: "hide", label: "Hide Jobomate" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: "Quit Jobomate" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Tab",
          accelerator: "CommandOrControl+T",
          click: () => mainWindow?.webContents.send("shortcut:new-tab"),
        },
        {
          label: "Close Tab",
          accelerator: "CommandOrControl+W",
          click: () => mainWindow?.webContents.send("shortcut:close-tab"),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "front" },
      ],
    },
  ];

  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
  electron.app.setAboutPanelOptions({
    applicationName: "Jobomate",
    applicationVersion: electron.app.getVersion(),
    iconPath: path.join(__dirname, "../assets/jobomate-logo.png"),
  });
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function normalizeUrl(input?: string): string {
  const trimmed = (input || "about:blank").trim();
  if (!trimmed || trimmed === "about:blank") return "about:blank";

  if (
    /^https?:\/\//i.test(trimmed) ||
    /^file:\/\//i.test(trimmed)
  ) {
    return trimmed;
  }

  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return "http://" + trimmed;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(trimmed)) {
    return "http://" + trimmed;
  }

  if (hasScheme(trimmed)) {
    throw new Error(`Unsupported URL scheme: ${trimmed.split(":")[0]}`);
  }

  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    return "https://" + trimmed;
  }

  return "https://www.google.com/search?q=" + encodeURIComponent(trimmed);
}

function shouldShowBrowserView(url: string): boolean {
  return url !== "about:blank";
}

function getBrowserViewBounds(): electron.Rectangle {
  if (browserBounds) {
    return browserBounds;
  }

  if (!mainWindow) {
    return { x: 0, y: FALLBACK_CONTENT_TOP, width: 0, height: 0 };
  }

  const [width, height] = mainWindow.getContentSize();
  return {
    x: 0,
    y: FALLBACK_CONTENT_TOP,
    width,
    height: Math.max(0, height - FALLBACK_CONTENT_TOP),
  };
}

function setBrowserBounds(bounds: electron.Rectangle): void {
  browserBounds = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
  updateVisibleBrowserViewBounds();
}

function updateVisibleBrowserViewBounds(): void {
  if (!mainWindow || !activeTabId) return;
  const record = browserViews.get(activeTabId);
  if (!record || !shouldShowBrowserView(getTabUrl(record))) return;
  record.view.setBounds(getBrowserViewBounds());
}

function getTabUrl(record: TabRecord): string {
  if (record.isLoading && record.requestedUrl) {
    return record.requestedUrl;
  }
  return record.view.webContents.getURL() || record.requestedUrl || "about:blank";
}

function canGoBack(webContents: electron.WebContents): boolean {
  const navigationHistory = (
    webContents as electron.WebContents & {
      navigationHistory?: { canGoBack: () => boolean };
    }
  ).navigationHistory;
  return navigationHistory?.canGoBack() ?? webContents.canGoBack();
}

function canGoForward(webContents: electron.WebContents): boolean {
  const navigationHistory = (
    webContents as electron.WebContents & {
      navigationHistory?: { canGoForward: () => boolean };
    }
  ).navigationHistory;
  return navigationHistory?.canGoForward() ?? webContents.canGoForward();
}

function snapshotTab(tabId: string): TabSnapshot | null {
  const record = browserViews.get(tabId);
  if (!record) return null;

  const url = getTabUrl(record);
  const title =
    (record.isLoading ? record.title : record.view.webContents.getTitle()) ||
    record.title ||
    (url === "about:blank" ? "New Tab" : url);

  return {
    id: record.id,
    url,
    title,
    favicon: record.favicon,
    active: record.id === activeTabId,
    isLoading: record.isLoading,
    canGoBack: canGoBack(record.view.webContents),
    canGoForward: canGoForward(record.view.webContents),
  };
}

function emitTabCreated(tab: TabSnapshot): void {
  mainWindow?.webContents.send("tab:created", tab);
}

function emitTabUpdated(tabId: string): void {
  const tab = snapshotTab(tabId);
  if (tab) {
    mainWindow?.webContents.send("tab:updated", tab);
  }
}

function emitTabSwitched(tabId: string): void {
  const tab = snapshotTab(tabId);
  if (tab) {
    mainWindow?.webContents.send("tab:switched", tab);
  }
}

function wireBrowserViewEvents(record: TabRecord): void {
  const { id, view } = record;

  view.webContents.on("did-start-loading", () => {
    record.isLoading = true;
    emitTabUpdated(id);
  });

  view.webContents.on("did-stop-loading", () => {
    record.isLoading = false;
    record.requestedUrl = getTabUrl(record);
    record.title = view.webContents.getTitle() || record.title;
    emitTabUpdated(id);
  });

  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (errorCode === -3) return;
    record.isLoading = false;
    record.title = errorDescription || "Load failed";
    emitTabUpdated(id);
  });

  view.webContents.on("page-title-updated", (_event, title) => {
    record.title = title || getTabUrl(record);
    emitTabUpdated(id);
  });

  view.webContents.on("page-favicon-updated", (_event, favicons) => {
    record.favicon = favicons[0];
    emitTabUpdated(id);
  });

  view.webContents.on("did-navigate", (_event, url) => {
    record.requestedUrl = url || record.requestedUrl;
    emitTabUpdated(id);
  });

  view.webContents.on("did-navigate-in-page", (_event, url) => {
    record.requestedUrl = url || record.requestedUrl;
    emitTabUpdated(id);
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    createTab(url, true);
    return { action: "deny" };
  });
}

function createBrowserView(rawUrl?: string): TabSnapshot {
  const id = String(++tabCounter);
  const url = normalizeUrl(rawUrl);
  const view = new electron.BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: BROWSING_PARTITION,
    },
  });

  view.setAutoResize({ width: true, height: true });

  const record: TabRecord = {
    id,
    view,
    requestedUrl: url,
    title: url === "about:blank" ? "New Tab" : url,
    isLoading: shouldShowBrowserView(url),
  };

  browserViews.set(id, record);
  wireBrowserViewEvents(record);

  if (shouldShowBrowserView(url)) {
    view.webContents.loadURL(url).catch((error: Error) => {
      record.isLoading = false;
      record.title = error.message;
      emitTabUpdated(id);
    });
  }

  const snapshot = snapshotTab(id);
  if (!snapshot) throw new Error("Failed to create tab");
  return snapshot;
}

function listTabs(): TabSnapshot[] {
  return Array.from(browserViews.keys())
    .map((id) => snapshotTab(id))
    .filter((tab): tab is TabSnapshot => Boolean(tab));
}

function getCurrentTab(): TabSnapshot | null {
  return activeTabId ? snapshotTab(activeTabId) : null;
}

function showBrowserView(tabId: string, emit = true): TabSnapshot {
  if (!mainWindow) throw new Error("Main window is not ready");
  const record = browserViews.get(tabId);
  if (!record) throw new Error(`Tab not found: ${tabId}`);

  for (const [, tab] of browserViews) {
    mainWindow.removeBrowserView(tab.view);
  }

  activeTabId = tabId;

  if (shouldShowBrowserView(getTabUrl(record))) {
    record.view.setBounds(getBrowserViewBounds());
    mainWindow.addBrowserView(record.view);
  }

  if (emit) {
    emitTabSwitched(tabId);
    emitTabUpdated(tabId);
  }

  const snapshot = snapshotTab(tabId);
  if (!snapshot) throw new Error("Failed to switch tab");
  return snapshot;
}

function createTab(url?: string, active = true): TabSnapshot {
  const tab = createBrowserView(url);
  if (active) {
    showBrowserView(tab.id, false);
  }
  const snapshot = snapshotTab(tab.id) || tab;
  emitTabCreated(snapshot);
  if (active) emitTabSwitched(tab.id);
  return snapshot;
}

function closeTab(tabId?: string): {
  success: boolean;
  closedTabId: string;
  newActiveTabId: string | null;
} {
  const targetTabId = tabId || activeTabId;
  if (!targetTabId) throw new Error("No active tab");
  const record = browserViews.get(targetTabId);
  if (!record) throw new Error(`Tab not found: ${targetTabId}`);

  const ids = Array.from(browserViews.keys());
  const closedIndex = ids.indexOf(targetTabId);

  if (mainWindow) {
    mainWindow.removeBrowserView(record.view);
  }

  const webContents = record.view.webContents as electron.WebContents & {
    destroy?: () => void;
  };
  webContents.destroy?.();
  browserViews.delete(targetTabId);

  let newActiveTabId: string | null = activeTabId;
  if (activeTabId === targetTabId) {
    const remaining = Array.from(browserViews.keys());
    newActiveTabId =
      remaining[closedIndex] || remaining[closedIndex - 1] || remaining[0] || null;
    if (newActiveTabId) {
      showBrowserView(newActiveTabId);
    } else {
      activeTabId = null;
    }
  }

  mainWindow?.webContents.send("tab:closed", {
    tabId: targetTabId,
    newActiveTabId,
  });

  if (browserViews.size === 0) {
    const blank = createTab("about:blank", true);
    newActiveTabId = blank.id;
  }

  return { success: true, closedTabId: targetTabId, newActiveTabId };
}

function getRecord(tabId?: string): TabRecord {
  const targetTabId = tabId || activeTabId;
  if (!targetTabId) throw new Error("No active tab");
  const record = browserViews.get(targetTabId);
  if (!record) throw new Error(`Tab not found: ${targetTabId}`);
  return record;
}

function navigateTab(tabId: string | undefined, rawUrl: string): TabSnapshot {
  const record = getRecord(tabId);
  const url = normalizeUrl(rawUrl);

  record.requestedUrl = url;
  record.title = url === "about:blank" ? "New Tab" : url;
  record.favicon = undefined;
  record.isLoading = shouldShowBrowserView(url);

  if (activeTabId === record.id) {
    showBrowserView(record.id, false);
  }

  if (shouldShowBrowserView(url)) {
    record.view.webContents.loadURL(url).catch((error: Error) => {
      record.isLoading = false;
      record.title = error.message;
      emitTabUpdated(record.id);
    });
  } else {
    record.view.webContents.loadURL("about:blank").catch(() => undefined);
    if (mainWindow) {
      mainWindow.removeBrowserView(record.view);
    }
    record.isLoading = false;
  }

  emitTabUpdated(record.id);
  const snapshot = snapshotTab(record.id);
  if (!snapshot) throw new Error("Failed to navigate tab");
  return snapshot;
}

function goBack(tabId?: string): { success: boolean } {
  const record = getRecord(tabId);
  if (!canGoBack(record.view.webContents)) {
    throw new Error("Cannot go back");
  }
  record.view.webContents.goBack();
  return { success: true };
}

function goForward(tabId?: string): { success: boolean } {
  const record = getRecord(tabId);
  if (!canGoForward(record.view.webContents)) {
    throw new Error("Cannot go forward");
  }
  record.view.webContents.goForward();
  return { success: true };
}

function reload(tabId?: string): { success: boolean } {
  getRecord(tabId).view.webContents.reload();
  return { success: true };
}

function stopLoading(tabId?: string): { success: boolean } {
  getRecord(tabId).view.webContents.stop();
  return { success: true };
}

async function getPageContent(
  tabId?: string,
  format: "text" | "html" = "text"
): Promise<Record<string, unknown>> {
  const record = getRecord(tabId);
  const webContents = record.view.webContents;
  const url = getTabUrl(record);
  const title = webContents.getTitle() || record.title;

  if (format === "html") {
    const html = await webContents.executeJavaScript(
      "document.documentElement ? document.documentElement.outerHTML : ''"
    );
    return { html, url, title };
  }

  const text = await webContents.executeJavaScript(
    "document.body ? document.body.innerText : ''"
  );
  return { text, url, title };
}

async function executeJavaScript(
  tabId: string | undefined,
  code: string
): Promise<{ result: unknown }> {
  if (!code) throw new Error("JavaScript code is required");
  const result = await getRecord(tabId).view.webContents.executeJavaScript(code);
  return { result };
}

async function clickElement(
  tabId: string | undefined,
  selector: string
): Promise<{ success: boolean; found: boolean; selector: string }> {
  if (!selector) throw new Error("CSS selector is required");
  const selectorJson = JSON.stringify(selector);
  const result = await getRecord(tabId).view.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${selectorJson});
      if (!el) return { found: false };
      el.click();
      return { found: true, tagName: el.tagName };
    })()
  `);
  const found = Boolean((result as { found?: boolean }).found);
  return { success: found, found, selector, ...(result as object) };
}

async function fillInput(
  tabId: string | undefined,
  selector: string,
  value: string
): Promise<{ success: boolean; found: boolean; selector: string }> {
  if (!selector) throw new Error("CSS selector is required");
  const selectorJson = JSON.stringify(selector);
  const valueJson = JSON.stringify(value || "");
  const result = await getRecord(tabId).view.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${selectorJson});
      if (!el) return { found: false };
      el.focus();
      el.value = ${valueJson};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, tagName: el.tagName };
    })()
  `);
  const found = Boolean((result as { found?: boolean }).found);
  return { success: found, found, selector, ...(result as object) };
}

async function waitForSelector(
  tabId: string | undefined,
  selector: string,
  timeout = 10000
): Promise<{ found: boolean; selector: string; elapsed: number }> {
  if (!selector) throw new Error("CSS selector is required");
  const startedAt = Date.now();
  const selectorJson = JSON.stringify(selector);
  const timeoutJson = JSON.stringify(timeout);
  const found = await getRecord(tabId).view.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const selector = ${selectorJson};
      const timeout = ${timeoutJson};
      const startedAt = Date.now();
      const check = () => {
        if (document.querySelector(selector)) return resolve(true);
        if (Date.now() - startedAt >= timeout) return resolve(false);
        setTimeout(check, 100);
      };
      check();
    })
  `);
  return { found: Boolean(found), selector, elapsed: Date.now() - startedAt };
}

async function takeScreenshot(tabId?: string): Promise<{
  screenshot: string;
  dataUrl: string;
  format: "png";
}> {
  const image = await getRecord(tabId).view.webContents.capturePage();
  const dataUrl = image.toDataURL();
  return { screenshot: dataUrl, dataUrl, format: "png" };
}

async function getCookies(tabId?: string): Promise<{ cookies: electron.Cookie[] }> {
  const cookies = await getRecord(tabId).view.webContents.session.cookies.get({});
  return { cookies };
}

async function setCookie(
  tabId: string | undefined,
  cookie: Record<string, unknown>
): Promise<{ success: boolean }> {
  const record = getRecord(tabId);
  if (typeof cookie.name !== "string" || typeof cookie.value !== "string") {
    throw new Error("Cookie name and value are required");
  }

  const details: Electron.CookiesSetDetails = {
    url: typeof cookie.url === "string" ? cookie.url : getTabUrl(record),
    name: cookie.name,
    value: cookie.value,
    domain: typeof cookie.domain === "string" ? cookie.domain : undefined,
    path: typeof cookie.path === "string" ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };

  await record.view.webContents.session.cookies.set({
    ...details,
  });
  return { success: true };
}

async function clearCookies(tabId?: string): Promise<{ success: boolean }> {
  const record = getRecord(tabId);
  const cookies = await record.view.webContents.session.cookies.get({});
  for (const cookie of cookies) {
    if (!cookie.domain) continue;
    const domain = cookie.domain.startsWith(".")
      ? cookie.domain.slice(1)
      : cookie.domain;
    const url = `http${cookie.secure ? "s" : ""}://${domain}${cookie.path}`;
    await record.view.webContents.session.cookies.remove(url, cookie.name);
  }
  return { success: true };
}

function createBrowserController(): BrowserController {
  return {
    listTabs: async () => listTabs(),
    getCurrentTab: async () => getCurrentTab(),
    createTab: async (url?: string, active?: boolean) => createTab(url, active !== false),
    closeTab: async (tabId?: string) => closeTab(tabId),
    switchTab: async (tabId: string) => showBrowserView(tabId),
    navigate: async (url: string, tabId?: string) => navigateTab(tabId, url),
    goBack: async (tabId?: string) => goBack(tabId),
    goForward: async (tabId?: string) => goForward(tabId),
    reload: async (tabId?: string) => reload(tabId),
    stop: async (tabId?: string) => stopLoading(tabId),
    getContent: async (format?: "text" | "html", tabId?: string) =>
      getPageContent(tabId, format || "text"),
    executeJS: async (code: string, tabId?: string) => executeJavaScript(tabId, code),
    click: async (selector: string, tabId?: string) => clickElement(tabId, selector),
    fill: async (selector: string, value: string, tabId?: string) =>
      fillInput(tabId, selector, value),
    waitFor: async (selector: string, timeout?: number, tabId?: string) =>
      waitForSelector(tabId, selector, timeout),
    screenshot: async (tabId?: string) => takeScreenshot(tabId),
    getCookies: async (tabId?: string) => getCookies(tabId),
    setCookie: async (cookie: Record<string, unknown>, tabId?: string) =>
      setCookie(tabId, cookie),
    clearCookies: async (tabId?: string) => clearCookies(tabId),
  };
}

function setupIpcHandlers(
  controller: BrowserController,
  llmConnection: LlmConnectionManager
): void {
  electron.ipcMain.handle("tab:create", (_event, url?: string) =>
    createTab(url, true)
  );
  electron.ipcMain.handle("tab:switch", (_event, tabId: string) =>
    showBrowserView(tabId)
  );
  electron.ipcMain.handle("tab:close", (_event, tabId?: string) =>
    closeTab(tabId)
  );
  electron.ipcMain.handle("tab:update", (_event, tabId: string, url: string) =>
    navigateTab(tabId, url)
  );
  electron.ipcMain.handle("tab:list", () => listTabs());
  electron.ipcMain.handle("tab:get-current", () => getCurrentTab());

  electron.ipcMain.handle("browser:go-back", (_event, tabId?: string) =>
    goBack(tabId)
  );
  electron.ipcMain.handle("browser:go-forward", (_event, tabId?: string) =>
    goForward(tabId)
  );
  electron.ipcMain.handle("browser:reload", (_event, tabId?: string) =>
    reload(tabId)
  );
  electron.ipcMain.handle("browser:stop", (_event, tabId?: string) =>
    stopLoading(tabId)
  );
  electron.ipcMain.handle(
    "browser:get-content",
    (_event, tabId?: string, format?: "text" | "html") =>
      getPageContent(tabId, format || "text")
  );
  electron.ipcMain.handle("browser:execute-js", (_event, tabId: string | undefined, code: string) =>
    executeJavaScript(tabId, code)
  );
  electron.ipcMain.handle("browser:click", (_event, tabId: string | undefined, selector: string) =>
    clickElement(tabId, selector)
  );
  electron.ipcMain.handle(
    "browser:fill",
    (_event, tabId: string | undefined, selector: string, value: string) =>
      fillInput(tabId, selector, value)
  );
  electron.ipcMain.handle("browser:wait-for", (_event, tabId: string | undefined, selector: string, timeout?: number) =>
    waitForSelector(tabId, selector, timeout)
  );
  electron.ipcMain.handle("browser:screenshot", (_event, tabId?: string) =>
    takeScreenshot(tabId)
  );

  // The renderer fetches the engine's loopback base URL + session token from here so api.ts can
  // authenticate every call. Only the trusted renderer (via contextBridge) can reach this.
  electron.ipcMain.handle("jobomate:engine-info", () => ({
    port: ENGINE_PORT,
    token: ENGINE_TOKEN,
  }));

  electron.ipcMain.handle("llmServer:getStatus", () => {
    const server = getLlmServer(controller);
    return {
      running: server.isRunning(),
      port: server.getPort(),
      connections: server.getConnectionCount(),
      uptime: server.getUptime(),
      token: server.getAuthToken(),
      tokenFile: BRIDGE_AUTH_PATH,
    };
  });
  electron.ipcMain.handle("llmServer:getPort", () => getLlmServer(controller).getPort());
  electron.ipcMain.handle("llmServer:start", async (_event, port?: number) => {
    const startedPort = await startLlmServer(controller, port);
    writeBridgeAuthFile(startedPort, getLlmServer(controller).getAuthToken());
    return { port: startedPort };
  });
  electron.ipcMain.handle("llmServer:stop", async () => {
    await stopLlmServer();
    removeBridgeAuthFile();
    return { success: true };
  });

  electron.ipcMain.handle("llmConnection:getConfig", () =>
    llmConnection.getConfig()
  );
  electron.ipcMain.handle("llmConnection:saveConfig", (_event, config) =>
    llmConnection.saveConfig(config)
  );
  electron.ipcMain.handle("llmConnection:test", (_event, config) =>
    llmConnection.testConnection(config)
  );
  electron.ipcMain.handle("llmConnection:providerDefaults", (_event, provider) =>
    llmConnection.providerDefaults(provider)
  );
  electron.ipcMain.handle("llmConnection:startOAuth", (_event, config) =>
    llmConnection.startOAuth(config)
  );
  electron.ipcMain.handle("llmConnection:disconnectOAuth", (_event, provider) =>
    llmConnection.disconnectOAuth(provider)
  );
  electron.ipcMain.handle("assistant:send", (_event, input) =>
    llmConnection.sendPrompt(input)
  );
  electron.ipcMain.handle("assistant:stop", () => llmConnection.stopActiveRun());
  electron.ipcMain.handle("assistant:pause", () => llmConnection.pauseActiveRun());
  electron.ipcMain.handle("assistant:resume", () => llmConnection.resumeActiveRun());
  electron.ipcMain.handle("assistant:setEnabled", (_event, enabled: boolean) =>
    llmConnection.setLlmEnabled(Boolean(enabled))
  );
  electron.ipcMain.handle("assistant:controlState", () => llmConnection.getControlState());

  electron.ipcMain.handle("downloads:list", () =>
    Array.from(downloads.entries()).map(([id, item]) =>
      serializeDownload(id, item)
    )
  );
  electron.ipcMain.handle("downloads:open", (_event, filePath: string) =>
    electron.shell.openPath(filePath)
  );
  electron.ipcMain.handle("downloads:show", (_event, filePath: string) => {
    electron.shell.showItemInFolder(filePath);
    return { success: true };
  });
  electron.ipcMain.handle("downloads:cancel", (_event, id: string) => {
    const item = downloads.get(id);
    if (item && item.getState() === "progressing") item.cancel();
    return { success: Boolean(item) };
  });
  electron.ipcMain.handle("downloads:open-folder", () => {
    electron.shell.openPath(downloadDirectory());
    return { path: downloadDirectory() };
  });

  // The renderer drives the app appearance (light by default, dark only when the
  // user picks it in Settings). Mirror that onto nativeTheme so embedded web
  // content matches and never follows the OS system appearance.
  electron.ipcMain.handle("theme:set-appearance", (_event, appearance: string) => {
    electron.nativeTheme.themeSource = appearance === "dark" ? "dark" : "light";
    return { success: true };
  });

  electron.ipcMain.handle("shell:open-external", (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("Only http and https URLs can be opened externally");
    }
    return electron.shell.openExternal(url);
  });

  // Clear browsing data the way any browser does — cookies/logins, cache, and site data — on the
  // dedicated browsing session only (the app's own settings/history are untouched). Optional
  // `since` (ms epoch) limits cookies/cache to that time range; omit to clear everything.
  electron.ipcMain.handle(
    "privacy:clear-browsing-data",
    async (_event, opts: { cookies?: boolean; cache?: boolean; siteData?: boolean; since?: number }) => {
      const ses = browsingSession();
      try {
        if (opts?.cache) {
          await ses.clearCache();
        }
        type Storage = "cookies" | "cachestorage" | "shadercache" | "localstorage" | "indexdb" | "websql" | "serviceworkers" | "filesystem";
        const storages: Storage[] = [];
        if (opts?.cookies) storages.push("cookies");
        if (opts?.cache) storages.push("cachestorage", "shadercache");
        if (opts?.siteData) storages.push("localstorage", "indexdb", "websql", "serviceworkers", "filesystem", "cachestorage", "shadercache");
        if (storages.length) {
          await ses.clearStorageData({ storages: Array.from(new Set(storages)) });
        }
        if (opts?.cookies) {
          try { await ses.clearAuthCache(); } catch { /* best effort */ }
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    }
  );

  // Native file picker for attaching a CV (PDF/text/Word). Returns the chosen path, or null.
  electron.ipcMain.handle("dialog:open-cv", async () => {
    if (!mainWindow) return null;
    const r = await electron.dialog.showOpenDialog(mainWindow, {
      title: "Attach your CV",
      properties: ["openFile"],
      filters: [
        { name: "CV / Résumé", extensions: ["pdf", "txt", "md", "doc", "docx", "rtf"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  electron.ipcMain.on("window:browser-bounds", (_event, bounds: electron.Rectangle) => {
    setBrowserBounds(bounds);
  });
}

electron.app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return; // a duplicate launch: do nothing (the primary already owns the ports)
  // Embedded web content (the browser BrowserViews) must ALWAYS render in light
  // mode, regardless of the macOS system appearance — forces every web content
  // to report `prefers-color-scheme: light`.
  electron.nativeTheme.themeSource = "light";
  startEngine(ENGINE_TOKEN); // headless Jobomate job-automation backend (localhost:9223), token-gated
  const controller = createBrowserController();
  llmConnectionManager = new LlmConnectionManager(() => controller, {
    // Approval gate for the harness's side-effecting tools (github_commit,
    // github_sync push/pull, PR/issue writes, non-GET github_api). A native
    // confirm dialog keeps the user in the loop before anything mutating runs.
    approve: async (req) => {
      const opts: electron.MessageBoxOptions = {
        type: "question",
        buttons: ["Allow", "Deny"],
        defaultId: 0,
        cancelId: 1,
        title: "Approve action",
        message: req.tool,
        detail: req.summary,
      };
      const { response } = mainWindow
        ? await electron.dialog.showMessageBox(mainWindow, opts)
        : await electron.dialog.showMessageBox(opts);
      return response === 0;
    },
    openSidecar: () => {
      /* no sidecar surface in this shell; harness tools never call it today */
    },
  });
  setupIpcHandlers(controller, llmConnectionManager);
  setupApplicationMenu();
  applyDockIcon();
  setupDownloads();
  electron.app.setAsDefaultProtocolClient("jobomate");
  createMainWindow();

  const firstTab = createBrowserView(DEFAULT_HOME);
  showBrowserView(firstTab.id, false);

  mainWindow?.webContents.once("did-finish-load", () => {
    const snapshot = snapshotTab(firstTab.id);
    if (snapshot) {
      emitTabCreated(snapshot);
      emitTabSwitched(snapshot.id);
    }
  });

  startLlmServer(controller)
    .then((port) => writeBridgeAuthFile(port, getLlmServer(controller).getAuthToken()))
    .catch((error: Error) => {
      console.error("[LLM Server] Failed to start:", error.message);
    });

  electron.globalShortcut.register("CommandOrControl+T", () => {
    mainWindow?.webContents.send("shortcut:new-tab");
  });
  electron.globalShortcut.register("CommandOrControl+W", () => {
    mainWindow?.webContents.send("shortcut:close-tab");
  });
  electron.globalShortcut.register("CommandOrControl+L", () => {
    mainWindow?.webContents.send("shortcut:focus-address-bar");
  });
  electron.globalShortcut.register("CommandOrControl+R", () => {
    if (activeTabId) reload(activeTabId);
  });
  electron.globalShortcut.register("CommandOrControl+Shift+R", () => {
    if (activeTabId) getRecord(activeTabId).view.webContents.reloadIgnoringCache();
  });

  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

electron.app.on("window-all-closed", () => {
  stopLlmServer();
  electron.globalShortcut.unregisterAll();
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});

electron.app.on("will-quit", () => {
  stopLlmServer();
  removeBridgeAuthFile();
  stopEngine();
  electron.globalShortcut.unregisterAll();
});
