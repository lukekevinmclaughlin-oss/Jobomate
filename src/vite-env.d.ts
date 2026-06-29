/// <reference types="vite/client" />

declare module "*.webp" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

interface BrowserAPITab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  active: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

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

type LlmConnectionType =
  | "ApiKey"
  | "LocalServer"
  | "CliPipe"
  | "OAuth"
  | "Terminal"
  | "LocalAI";

type LlmApiProvider =
  | "OpenAI"
  | "Anthropic"
  | "Groq"
  | "OpenRouter"
  | "DeepSeek"
  | "Together"
  | "Mistral"
  | "XAI"
  | "GoogleAI"
  | "WorkspaceApi"
  | "AzureOpenAI"
  | "Perplexity"
  | "Fireworks"
  | "HuggingFace"
  | "Novita"
  | "ZAI"
  | "PPIO"
  | "ApiPie"
  | "MoonshotAI"
  | "CometAPI"
  | "GiteeAI"
  | "SambaNova"
  | "LocalAIEndpoint"
  | "KoboldCpp"
  | "TextGenerationWebUI"
  | "LiteLLM"
  | "NvidiaNim"
  | "Foundry"
  | "DockerModelRunner"
  | "PrivateMode"
  | "Lemonade"
  | "Custom";

type LlmOAuthProvider = "GoogleVertex" | "Azure" | "HuggingFace" | "Custom";

/** A model entry returned by API-key autodetection. */
interface DetectedModel {
  id: string;
  label?: string;
  ownedBy?: string;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  contextWindow?: number;
  tier?: "fast" | "balanced" | "flagship";
}

interface LocalRuntimeResult {
  runtime: string;
  baseUrl: string;
  chatUrl: string;
  models: DetectedModel[];
  ok: boolean;
}

/** Aggregate capabilities for the recommended model. */
interface ModelCapabilities {
  supportsReasoning: boolean;
  reasoningKind: "effort" | "extended" | "none";
  supportsTools: boolean;
  supportsVision: boolean;
  defaultReasoningEffort?: "Low" | "Medium" | "High";
}

/** Result of probing an API key against candidate providers. */
interface ApiKeyProbeResult {
  ok: boolean;
  provider?: LlmApiProvider;
  endpoint: string;
  modelsEndpoint?: string;
  models: DetectedModel[];
  recommendedModel?: string;
  capabilities?: ModelCapabilities;
  message: string;
}

interface BundledServerStatus {
  available: boolean;
  running: boolean;
  baseUrl?: string;
  modelPath?: string;
  binaryPath?: string;
  reason?: string;
}

interface LlmConnectionConfig {
  connectionType: LlmConnectionType;
  apiProvider: LlmApiProvider;
  apiKey: string;
  customEndpoint: string;
  model: string;
  reasoningEffort: "Low" | "Medium" | "High" | "Extra" | "Max" | "ExtraMax";
  fastMode: boolean;
  systemPrompt: string;
  localServerUrl: string;
  localModelName: string;
  cliCommand: string;
  cliTimeout: number;
  oauthProvider: LlmOAuthProvider;
  oauthClientId: string;
  oauthAuthUrl: string;
  oauthTokenUrl: string;
  oauthScope: string;
  oauthAccessToken: string;
  oauthRefreshToken: string;
  oauthExpiresAt: string;
  terminalCommand: string;
  terminalCaptureOutput: boolean;
  localAIRuntime: string;
  localAIRuntimeStorageDir: string;
  localAIRuntimePath: string;
  localAIModelPath: string;
  localAIModelName: string;
  localAIContextSize: number;
  enableLlmStreaming: boolean;
  requireToolUse: boolean;
  hasApiKey: boolean;
  hasOAuthToken: boolean;
  secretMask: string;
}

interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AssistantAttachmentInput {
  path: string;
  name?: string;
  size?: number;
}

interface AssistantToolRun {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

interface AssistantResponse {
  content: string;
  reasoning?: string;
  toolRuns: AssistantToolRun[];
  connection: {
    type: LlmConnectionType;
    provider: string;
    model: string;
  };
}

interface BrowserAPI {
  platform: string;
  tabs: {
    create: (url?: string) => Promise<BrowserAPITab>;
    close: (
      id?: string
    ) => Promise<{
      success: boolean;
      closedTabId: string;
      newActiveTabId: string | null;
    }>;
    switch: (id: string) => Promise<BrowserAPITab>;
    update: (id: string, url: string) => Promise<BrowserAPITab>;
    list: () => Promise<BrowserAPITab[]>;
    getCurrent: () => Promise<BrowserAPITab | null>;
  };
  navigation: {
    goBack: (id?: string) => Promise<{ success: boolean }>;
    goForward: (id?: string) => Promise<{ success: boolean }>;
    reload: (id?: string) => Promise<{ success: boolean }>;
    stop: (id?: string) => Promise<{ success: boolean }>;
  };
  content: {
    getHTML: (id?: string) => Promise<{ html: string; url: string; title: string }>;
    getText: (id?: string) => Promise<{ text: string; url: string; title: string }>;
    getTitle: (id?: string) => Promise<{ result: string }>;
    getURL: (id?: string) => Promise<{ result: string }>;
  };
  execute: {
    script: (code: string, id?: string) => Promise<{ result: unknown }>;
  };
  screenshot: {
    capture: (id?: string) => Promise<{ dataUrl: string; screenshot: string }>;
  };
  downloads: {
    list: () => Promise<DownloadSnapshot[]>;
    open: (filePath: string) => Promise<string>;
    showInFolder: (filePath: string) => Promise<{ success: boolean }>;
    cancel: (id: string) => Promise<{ success: boolean }>;
    openFolder: () => Promise<{ path: string }>;
  };
  llmServer: {
    getStatus: () => Promise<{
      running: boolean;
      port: number;
      connections: number;
      uptime: number;
    }>;
    getPort: () => Promise<number>;
    start: (port?: number) => Promise<{ port: number }>;
    stop: () => Promise<{ success: boolean }>;
  };
  llmConnection: {
    getConfig: () => Promise<LlmConnectionConfig>;
    saveConfig: (
      config: Partial<LlmConnectionConfig>
    ) => Promise<LlmConnectionConfig>;
    connect: (
      config?: Partial<LlmConnectionConfig>
    ) => Promise<{ ok: boolean; message: string; config: LlmConnectionConfig }>;
    disconnect: (type?: LlmConnectionType) => Promise<LlmConnectionConfig>;
    test: (
      config?: Partial<LlmConnectionConfig>
    ) => Promise<{ ok: boolean; message: string }>;
    probeApiKey: (input: {
      apiKey: string;
      provider?: LlmApiProvider;
      endpoint?: string;
    }) => Promise<ApiKeyProbeResult>;
    discoverLocal: () => Promise<LocalRuntimeResult[]>;
    listModels: (input: {
      url: string;
      apiKey?: string;
    }) => Promise<{ ok: boolean; models: DetectedModel[]; message: string }>;
    testCli: (input: {
      command: string;
      timeout?: number;
    }) => Promise<{ ok: boolean; output: string; message: string }>;
    providerDefaults: (
      provider: LlmApiProvider
    ) => Promise<{
      url: string;
      model: string;
      header: string;
      prefix: string;
      requiresToken: boolean;
      adapter: string;
    }>;
    startOAuth: (
      config?: Partial<LlmConnectionConfig>
    ) => Promise<{
      status: "started";
      provider: LlmOAuthProvider;
      authUrl: string;
      redirectUri: string;
    }>;
    disconnectOAuth: (provider?: LlmOAuthProvider) => Promise<LlmConnectionConfig>;
  };
  assistant: {
    send: (input: {
      prompt: string;
      history?: AssistantChatMessage[];
      attachments?: AssistantAttachmentInput[];
    }) => Promise<AssistantResponse>;
    stop: () => Promise<{ stopped: boolean }>;
    pause: () => Promise<{ paused: boolean }>;
    resume: () => Promise<{ paused: boolean }>;
    setEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
    controlState: () => Promise<{ enabled: boolean; running: boolean; paused: boolean }>;
    onStream: (callback: (payload: { delta: string }) => void) => () => void;
    onReasoning: (callback: (payload: { delta: string }) => void) => () => void;
    onToolRun: (callback: (run: unknown) => void) => () => void;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  privacy: {
    clearBrowsingData: (opts: {
      cookies?: boolean;
      cache?: boolean;
      siteData?: boolean;
      since?: number;
    }) => Promise<{ ok: boolean; error?: string }>;
  };
  dialog: {
    openCv: () => Promise<string | null>;
    openFolder: () => Promise<{ canceled: boolean; path: string | null }>;
    openFile: () => Promise<{ canceled: boolean; path: string | null }>;
  };
  /** Bundled local llama-server. Optional: Jobomate ships no bundled runtime,
   *  so the setup wizard calls this via optional chaining. */
  localServer?: {
    status: () => Promise<BundledServerStatus>;
    start: (opts?: {
      port?: number;
      contextSize?: number;
      modelPath?: string;
    }) => Promise<BundledServerStatus>;
    stop: () => Promise<BundledServerStatus>;
  };
  files: {
    pathFor: (file: File) => string;
  };
  engine: {
    info: () => Promise<{ port: number; token: string }>;
  };
  theme: {
    setAppearance: (appearance: "light" | "dark") => Promise<{ success: boolean }>;
  };
  window: {
    setBrowserBounds: (bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => void;
  };
  onTabCreated: (callback: (tab: BrowserAPITab) => void) => () => void;
  onTabClosed: (
    callback: (payload: {
      tabId: string;
      newActiveTabId: string | null;
    }) => void
  ) => () => void;
  onTabSwitched: (callback: (tab: BrowserAPITab) => void) => () => void;
  onTabUpdated: (callback: (tab: BrowserAPITab) => void) => () => void;
  onShortcut: (callback: (shortcut: string) => void) => () => void;
  onOAuthUpdated: (
    callback: (payload: { message: string; error?: boolean }) => void
  ) => () => void;
  onDownloadStarted: (callback: (item: DownloadSnapshot) => void) => () => void;
  onDownloadUpdated: (callback: (item: DownloadSnapshot) => void) => () => void;
}

interface Window {
  browserAPI?: BrowserAPI;
}
