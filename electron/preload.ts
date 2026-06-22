import { contextBridge, ipcRenderer, webUtils } from "electron";

type ListenerDisposer = () => void;

function onChannel<T>(
  channel: string,
  callback: (payload: T) => void
): ListenerDisposer {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => {
    callback(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("browserAPI", {
  platform: process.platform,
  tabs: {
    create: (url?: string) => ipcRenderer.invoke("tab:create", url),
    close: (id?: string) => ipcRenderer.invoke("tab:close", id),
    switch: (id: string) => ipcRenderer.invoke("tab:switch", id),
    update: (id: string, url: string) => ipcRenderer.invoke("tab:update", id, url),
    list: () => ipcRenderer.invoke("tab:list"),
    getCurrent: () => ipcRenderer.invoke("tab:get-current"),
  },
  navigation: {
    goBack: (id?: string) => ipcRenderer.invoke("browser:go-back", id),
    goForward: (id?: string) => ipcRenderer.invoke("browser:go-forward", id),
    reload: (id?: string) => ipcRenderer.invoke("browser:reload", id),
    stop: (id?: string) => ipcRenderer.invoke("browser:stop", id),
  },
  content: {
    getHTML: (id?: string) =>
      ipcRenderer.invoke("browser:get-content", id, "html"),
    getText: (id?: string) =>
      ipcRenderer.invoke("browser:get-content", id, "text"),
    getTitle: (id?: string) =>
      ipcRenderer.invoke("browser:execute-js", id, "document.title"),
    getURL: (id?: string) =>
      ipcRenderer.invoke("browser:execute-js", id, "location.href"),
  },
  execute: {
    script: (code: string, id?: string) =>
      ipcRenderer.invoke("browser:execute-js", id, code),
  },
  screenshot: {
    capture: (id?: string) => ipcRenderer.invoke("browser:screenshot", id),
  },
  downloads: {
    list: () => ipcRenderer.invoke("downloads:list"),
    open: (filePath: string) => ipcRenderer.invoke("downloads:open", filePath),
    showInFolder: (filePath: string) =>
      ipcRenderer.invoke("downloads:show", filePath),
    cancel: (id: string) => ipcRenderer.invoke("downloads:cancel", id),
    openFolder: () => ipcRenderer.invoke("downloads:open-folder"),
  },
  llmServer: {
    getStatus: () => ipcRenderer.invoke("llmServer:getStatus"),
    getPort: () => ipcRenderer.invoke("llmServer:getPort"),
    start: (port?: number) => ipcRenderer.invoke("llmServer:start", port),
    stop: () => ipcRenderer.invoke("llmServer:stop"),
  },
  llmConnection: {
    getConfig: () => ipcRenderer.invoke("llmConnection:getConfig"),
    saveConfig: (config: unknown) =>
      ipcRenderer.invoke("llmConnection:saveConfig", config),
    test: (config?: unknown) => ipcRenderer.invoke("llmConnection:test", config),
    providerDefaults: (provider: string) =>
      ipcRenderer.invoke("llmConnection:providerDefaults", provider),
    startOAuth: (config?: unknown) =>
      ipcRenderer.invoke("llmConnection:startOAuth", config),
    disconnectOAuth: (provider?: string) =>
      ipcRenderer.invoke("llmConnection:disconnectOAuth", provider),
  },
  assistant: {
    send: (input: unknown) => ipcRenderer.invoke("assistant:send", input),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  },
  privacy: {
    clearBrowsingData: (opts: { cookies?: boolean; cache?: boolean; siteData?: boolean; since?: number }) =>
      ipcRenderer.invoke("privacy:clear-browsing-data", opts),
  },
  dialog: {
    openCv: (): Promise<string | null> => ipcRenderer.invoke("dialog:open-cv"),
  },
  // Resolve a dropped File object to its absolute filesystem path. Electron 32+ removed File.path,
  // so the renderer must go through webUtils.getPathForFile (only available in the preload context).
  files: {
    pathFor: (file: File): string => webUtils.getPathForFile(file),
  },
  // Loopback engine base URL + per-session auth token, so the React client can authenticate calls.
  engine: {
    info: (): Promise<{ port: number; token: string }> =>
      ipcRenderer.invoke("jobomate:engine-info"),
  },
  theme: {
    setAppearance: (appearance: "light" | "dark") =>
      ipcRenderer.invoke("theme:set-appearance", appearance),
  },
  window: {
    setBrowserBounds: (bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ipcRenderer.send("window:browser-bounds", bounds),
  },
  onTabCreated: <T>(callback: (tab: T) => void) =>
    onChannel<T>("tab:created", callback),
  onTabClosed: <T>(callback: (payload: T) => void) =>
    onChannel<T>("tab:closed", callback),
  onTabSwitched: <T>(callback: (tab: T) => void) =>
    onChannel<T>("tab:switched", callback),
  onTabUpdated: <T>(callback: (tab: T) => void) =>
    onChannel<T>("tab:updated", callback),
  onShortcut: (callback: (shortcut: string) => void) => {
    const channels = [
      "shortcut:new-tab",
      "shortcut:close-tab",
      "shortcut:focus-address-bar",
      "shortcut:toggle-settings",
      "shortcut:toggle-sidebar",
    ];
    const disposers = channels.map((channel) =>
      onChannel<void>(channel, () => callback(channel))
    );
    return () => disposers.forEach((dispose) => dispose());
  },
  onOAuthUpdated: <T>(callback: (payload: T) => void) =>
    onChannel<T>("llmConnection:oauth-updated", callback),
  onDownloadStarted: <T>(callback: (payload: T) => void) =>
    onChannel<T>("download:started", callback),
  onDownloadUpdated: <T>(callback: (payload: T) => void) =>
    onChannel<T>("download:updated", callback),
});
