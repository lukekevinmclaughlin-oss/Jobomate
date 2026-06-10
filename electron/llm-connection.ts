import { app, safeStorage, shell } from "electron";
import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { BrowserController } from "./llm-server";

export type AppConnectionType =
  | "ApiKey"
  | "LocalServer"
  | "CliPipe"
  | "OAuth"
  | "Terminal"
  | "LocalAI";

export type AppApiProvider =
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

export type AppOAuthProviderType = "GoogleVertex" | "Azure" | "HuggingFace" | "Custom";

export const CONNECTION_TYPES: AppConnectionType[] = [
  "ApiKey",
  "LocalServer",
  "CliPipe",
  "OAuth",
  "Terminal",
  "LocalAI",
];

export const API_PROVIDERS: AppApiProvider[] = [
  "OpenAI",
  "Anthropic",
  "Groq",
  "OpenRouter",
  "DeepSeek",
  "Together",
  "Mistral",
  "XAI",
  "GoogleAI",
  "WorkspaceApi",
  "AzureOpenAI",
  "Perplexity",
  "Fireworks",
  "HuggingFace",
  "Novita",
  "ZAI",
  "PPIO",
  "ApiPie",
  "MoonshotAI",
  "CometAPI",
  "GiteeAI",
  "SambaNova",
  "LocalAIEndpoint",
  "KoboldCpp",
  "TextGenerationWebUI",
  "LiteLLM",
  "NvidiaNim",
  "Foundry",
  "DockerModelRunner",
  "PrivateMode",
  "Lemonade",
  "Custom",
];

export const OAUTH_PROVIDERS: AppOAuthProviderType[] = [
  "GoogleVertex",
  "Azure",
  "HuggingFace",
  "Custom",
];

interface ProviderInfo {
  url: string;
  model: string;
  header: string;
  prefix: string;
  requiresToken: boolean;
  adapter: "openai-compatible" | "anthropic" | "google-ai";
}

export interface LlmConnectionConfig {
  connectionType: AppConnectionType;
  apiProvider: AppApiProvider;
  apiKey: string;
  customEndpoint: string;
  model: string;
  reasoningEffort: "Low" | "Medium" | "High";
  fastMode: boolean;
  systemPrompt: string;
  localServerUrl: string;
  localModelName: string;
  cliCommand: string;
  cliTimeout: number;
  oauthProvider: AppOAuthProviderType;
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
  connected: boolean;
  maxToolRounds: number;
}

export interface LlmConnectionConfigForRenderer extends LlmConnectionConfig {
  hasApiKey: boolean;
  hasOAuthToken: boolean;
  secretMask: string;
}

interface StoredLlmConnectionConfig extends Omit<
  LlmConnectionConfig,
  "apiKey" | "oauthAccessToken" | "oauthRefreshToken"
> {
  apiKey?: string;
  apiKeyEncrypted?: string;
  oauthAccessToken?: string;
  oauthAccessTokenEncrypted?: string;
  oauthRefreshToken?: string;
  oauthRefreshTokenEncrypted?: string;
}

interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
}

interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ParsedLlmResponse {
  content: string;
  toolCalls: ParsedToolCall[];
  raw: unknown;
}

export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantToolRun {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AssistantResponse {
  content: string;
  toolRuns: AssistantToolRun[];
  connection: {
    type: AppConnectionType;
    provider: string;
    model: string;
  };
}

export interface OAuthStartResult {
  status: "started";
  provider: AppOAuthProviderType;
  authUrl: string;
  redirectUri: string;
}

interface PendingOAuthFlow {
  state: string;
  verifier: string;
  tokenUrl: string;
  clientId: string;
  provider: AppOAuthProviderType;
  startedAt: number;
}

const SECRET_MASK = "........";
const OAUTH_REDIRECT_URI = "jobomate://oauth/callback";
const CONNECTION_CONFIG_FILE = "llm-connection.json";

const DEFAULT_CONFIG: LlmConnectionConfig = {
  connectionType: "LocalServer",
  apiProvider: "OpenAI",
  apiKey: "",
  customEndpoint: "",
  model: "gpt-4o",
  reasoningEffort: "Medium",
  fastMode: false,
  systemPrompt: "",
  localServerUrl: "http://localhost:11434/v1/chat/completions",
  localModelName: "llama3",
  cliCommand: "ollama run llama3 \"{prompt}\"",
  cliTimeout: 120,
  oauthProvider: "GoogleVertex",
  oauthClientId: "",
  oauthAuthUrl: "",
  oauthTokenUrl: "",
  oauthScope: "",
  oauthAccessToken: "",
  oauthRefreshToken: "",
  oauthExpiresAt: "",
  terminalCommand: "",
  terminalCaptureOutput: true,
  localAIRuntime: "Auto",
  localAIRuntimeStorageDir: "",
  localAIRuntimePath: "",
  localAIModelPath: "",
  localAIModelName: "",
  localAIContextSize: 4096,
  enableLlmStreaming: true,
  requireToolUse: false,
  connected: false,
  maxToolRounds: 0,
};

const PROVIDER_INFO: Record<AppApiProvider, ProviderInfo> = {
  OpenAI: {
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  Anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-20250514",
    header: "x-api-key",
    prefix: "",
    requiresToken: true,
    adapter: "anthropic",
  },
  Groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  OpenRouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-4o",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  DeepSeek: {
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-v4-flash",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  Together: {
    url: "https://api.together.xyz/v1/chat/completions",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  Mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-large-latest",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  XAI: {
    url: "https://api.x.ai/v1/chat/completions",
    model: "grok-2",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  GoogleAI: {
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    model: "gemini-2.0-flash",
    header: "x-goog-api-key",
    prefix: "",
    requiresToken: true,
    adapter: "google-ai",
  },
  WorkspaceApi: {
    url: "http://127.0.0.1:3001/api/v1/openai/chat/completions",
    model: "my-workspace",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
  AzureOpenAI: {
    url: "",
    model: "gpt-4o",
    header: "api-key",
    prefix: "",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  Perplexity: {
    url: "https://api.perplexity.ai/chat/completions",
    model: "sonar-pro",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  Fireworks: {
    url: "https://api.fireworks.ai/inference/v1/chat/completions",
    model: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  HuggingFace: {
    url: "https://router.huggingface.co/v1/chat/completions",
    model: "meta-llama/Llama-3.1-8B-Instruct",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  Novita: {
    url: "https://api.novita.ai/v3/openai/chat/completions",
    model: "deepseek/deepseek-r1",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  ZAI: {
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    model: "glm-4.5",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  PPIO: {
    url: "https://api.ppinfra.com/v3/openai/chat/completions",
    model: "qwen/qwen2.5-32b-instruct",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  ApiPie: {
    url: "https://apipie.ai/v1/chat/completions",
    model: "gpt-4o-mini",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  MoonshotAI: {
    url: "https://api.moonshot.ai/v1/chat/completions",
    model: "moonshot-v1-32k",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  CometAPI: {
    url: "https://api.cometapi.com/v1/chat/completions",
    model: "gpt-5-mini",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  GiteeAI: {
    url: "https://ai.gitee.com/v1/chat/completions",
    model: "Qwen3-32B",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  SambaNova: {
    url: "https://api.sambanova.ai/v1/chat/completions",
    model: "Meta-Llama-3.3-70B-Instruct",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  LocalAIEndpoint: {
    url: "http://localhost:8080/v1/chat/completions",
    model: "local-model",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
  KoboldCpp: {
    url: "http://localhost:5001/v1/chat/completions",
    model: "koboldcpp",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
  TextGenerationWebUI: {
    url: "http://localhost:5000/v1/chat/completions",
    model: "text-generation-webui",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
  LiteLLM: {
    url: "http://localhost:4000/v1/chat/completions",
    model: "gpt-4o-mini",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
  NvidiaNim: {
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    model: "meta/llama-3.1-70b-instruct",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  Foundry: {
    url: "http://localhost:5273/v1/chat/completions",
    model: "local-model",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
  DockerModelRunner: {
    url: "http://localhost:12434/v1/chat/completions",
    model: "local-model",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
  PrivateMode: {
    url: "",
    model: "local-model",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
  Lemonade: {
    url: "http://localhost:8000/v1/chat/completions",
    model: "local-model",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: true,
    adapter: "openai-compatible",
  },
  Custom: {
    url: "",
    model: "",
    header: "Authorization",
    prefix: "Bearer ",
    requiresToken: false,
    adapter: "openai-compatible",
  },
};

export class LlmConnectionManager {
  private pendingOAuth: Map<string, PendingOAuthFlow> = new Map();

  constructor(private getController: () => BrowserController) {}

  providerDefaults(provider: AppApiProvider): ProviderInfo {
    return PROVIDER_INFO[provider] || PROVIDER_INFO.OpenAI;
  }

  async getConfig(): Promise<LlmConnectionConfigForRenderer> {
    return this.forRenderer(await this.loadConfig());
  }

  async saveConfig(input: Partial<LlmConnectionConfig>): Promise<LlmConnectionConfigForRenderer> {
    const current = await this.loadConfig();
    const merged = this.mergeConfig(current, input);
    await this.writeConfig(merged);
    return this.forRenderer(merged);
  }

  // Activate a connection type: persist the chosen settings, verify them with a
  // live test, and mark the connection as connected only if the test passes.
  async connect(
    input?: Partial<LlmConnectionConfig>
  ): Promise<{ ok: boolean; message: string; config: LlmConnectionConfigForRenderer }> {
    const current = await this.loadConfig();
    const merged = this.mergeConfig(current, { ...input, connected: true });
    await this.writeConfig(merged);
    const test = await this.testConnection();
    if (!test.ok) {
      merged.connected = false;
      await this.writeConfig(merged);
    }
    return { ok: test.ok, message: test.message, config: this.forRenderer(merged) };
  }

  // Deactivate the active (or given) connection type and forget its stored secret.
  async disconnect(type?: AppConnectionType): Promise<LlmConnectionConfigForRenderer> {
    const config = await this.loadConfig();
    const target = type || config.connectionType;
    config.connected = false;
    if (target === "ApiKey") {
      config.apiKey = "";
    }
    if (target === "OAuth") {
      config.oauthAccessToken = "";
      config.oauthRefreshToken = "";
      config.oauthExpiresAt = "";
    }
    await this.writeConfig(config);
    return this.forRenderer(config);
  }

  async testConnection(input?: Partial<LlmConnectionConfig>): Promise<{ ok: boolean; message: string }> {
    const current = await this.loadConfig();
    const config = input ? this.mergeConfig(current, input) : current;
    try {
      const result = await this.sendMessagesForConfig(
        config,
        [{ role: "user", content: "Connection test only. Reply with the exact words: Connection test OK" }],
        [],
        { connectionTest: true, maxTokens: 64 }
      );
      const content = result.content.trim() || "Connection test OK";
      return { ok: true, message: content };
    } catch (error) {
      return { ok: false, message: this.errorMessage(error) };
    }
  }

  async startOAuth(input?: Partial<LlmConnectionConfig>): Promise<OAuthStartResult> {
    const current = await this.loadConfig();
    const config = input ? this.mergeConfig(current, input) : current;
    const defaults = oauthProviderDefaults(config.oauthProvider);
    const authUrl = config.oauthAuthUrl.trim() || defaults.authUrl;
    const tokenUrl = config.oauthTokenUrl.trim() || defaults.tokenUrl;
    const scope = config.oauthScope.trim() || defaults.scope;
    if (!config.oauthClientId.trim()) {
      throw new Error("OAuth client ID is required.");
    }
    if (!authUrl || !tokenUrl) {
      throw new Error("OAuth authorization and token URLs are required.");
    }

    const verifier = generatePkceVerifier();
    const challenge = generatePkceChallenge(verifier);
    const state = crypto.randomUUID();
    this.pendingOAuth.set(state, {
      state,
      verifier,
      tokenUrl,
      clientId: config.oauthClientId.trim(),
      provider: config.oauthProvider,
      startedAt: Date.now(),
    });

    const url = buildOAuthAuthorizationUrl(
      authUrl,
      config.oauthClientId.trim(),
      scope,
      challenge,
      state
    );
    await shell.openExternal(url);
    await this.writeConfig(config);
    return {
      status: "started",
      provider: config.oauthProvider,
      authUrl: url,
      redirectUri: OAUTH_REDIRECT_URI,
    };
  }

  async disconnectOAuth(provider?: AppOAuthProviderType): Promise<LlmConnectionConfigForRenderer> {
    const config = await this.loadConfig();
    if (!provider || provider === config.oauthProvider) {
      config.oauthAccessToken = "";
      config.oauthRefreshToken = "";
      config.oauthExpiresAt = "";
      if (config.connectionType === "OAuth") config.connected = false;
      await this.writeConfig(config);
    }
    return this.forRenderer(config);
  }

  async handleOAuthCallback(callbackUrl: string): Promise<string> {
    const parsed = new URL(callbackUrl);
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (!code || !state) {
      throw new Error("OAuth callback is missing code or state.");
    }
    const flow = this.pendingOAuth.get(state);
    if (!flow) {
      throw new Error("OAuth callback state was not recognized.");
    }
    if (Date.now() - flow.startedAt > 10 * 60 * 1000) {
      this.pendingOAuth.delete(state);
      throw new Error("OAuth callback expired.");
    }

    const token = await exchangeOAuthCode(code, flow.tokenUrl, flow.clientId, flow.verifier);
    const config = await this.loadConfig();
    config.oauthProvider = flow.provider;
    config.oauthAccessToken = token.accessToken;
    config.oauthRefreshToken = token.refreshToken || config.oauthRefreshToken;
    config.oauthExpiresAt = token.expiresAt;
    config.connectionType = "OAuth";
    config.connected = true;
    await this.writeConfig(config);
    this.pendingOAuth.delete(state);
    return "OAuth connected. Token stored securely.";
  }

  async sendPrompt(input: {
    prompt: string;
    history?: AssistantChatMessage[];
  }): Promise<AssistantResponse> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Prompt is required.");

    const config = await this.loadConfig();
    const messages: LlmMessage[] = [
      { role: "system", content: this.systemPrompt(config) },
      ...this.historyMessages(input.history || []),
      { role: "user", content: prompt },
    ];
    const tools = browserToolDefinitions();
    const toolRuns: AssistantToolRun[] = [];
    // maxToolRounds: 0 (or unset) = unlimited, so the model can carry out long,
    // multi-step browser tasks. A no-progress guard below still prevents runaway
    // loops even when unlimited.
    const maxRounds = config.maxToolRounds > 0 ? config.maxToolRounds : Infinity;
    const STALL_LIMIT = 8;
    let lastSignature = "";
    let stalledRounds = 0;

    for (let round = 0; round < maxRounds; round += 1) {
      const response = await this.sendMessagesForConfig(config, messages, tools, {
        maxTokens: 2048,
        requireToolUse: config.requireToolUse && round === 0,
      });

      if (response.toolCalls.length === 0) {
        return {
          content: response.content.trim() || "Done.",
          toolRuns,
          connection: this.connectionSummary(config),
        };
      }

      // Guard against infinite no-progress loops (the model repeating the exact
      // same tool call): bail out to the wrap-up if it stalls.
      const signature = JSON.stringify(
        response.toolCalls.map((call) => [call.name, call.arguments])
      );
      if (signature === lastSignature) {
        stalledRounds += 1;
        if (stalledRounds >= STALL_LIMIT) break;
      } else {
        lastSignature = signature;
        stalledRounds = 0;
      }

      const assistantSummary = response.content.trim() || "Calling browser tools.";
      messages.push({ role: "assistant", content: assistantSummary });

      for (const call of response.toolCalls) {
        const result = await this.dispatchBrowserTool(call.name, call.arguments);
        toolRuns.push({ name: call.name, arguments: call.arguments, result });

        if (call.name === "done") {
          const message = stringArg(call.arguments, "message") || response.content || "Done.";
          return {
            content: message,
            toolRuns,
            connection: this.connectionSummary(config),
          };
        }

        if (call.name === "ask_user") {
          const question = stringArg(call.arguments, "question") || "I need more information.";
          return {
            content: question,
            toolRuns,
            connection: this.connectionSummary(config),
          };
        }

        messages.push({
          role: "user",
          content:
            `Tool result for ${call.name}:\n` +
            trimForModel(JSON.stringify(result, null, 2), 12000),
        });
      }
    }

    // Hit the tool-round budget: ask for a final answer with no further tools so
    // the user gets a real response from what was gathered, not a dead end.
    try {
      const wrap = await this.sendMessagesForConfig(
        config,
        [
          ...messages,
          {
            role: "user",
            content:
              "You've reached the tool-use limit for this turn. Do not call any more tools. " +
              "Give your best final answer to the user from what you've gathered, and note briefly if anything is left to finish.",
          },
        ],
        [],
        { maxTokens: 1024 }
      );
      return {
        content:
          wrap.content.trim() ||
          "I gathered some results but ran out of browser tool steps for this turn — ask me to continue.",
        toolRuns,
        connection: this.connectionSummary(config),
      };
    } catch {
      return {
        content:
          "I ran out of browser tool steps for this turn. Ask me to continue and I'll pick up where I left off.",
        toolRuns,
        connection: this.connectionSummary(config),
      };
    }
  }

  private async sendMessagesForConfig(
    config: LlmConnectionConfig,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    options: {
      connectionTest?: boolean;
      maxTokens?: number;
      requireToolUse?: boolean;
    } = {}
  ): Promise<ParsedLlmResponse> {
    switch (config.connectionType) {
      case "ApiKey":
        return this.sendApi(config, messages, tools, options);
      case "OAuth":
        return this.sendOAuth(config, messages, tools, options);
      case "LocalServer":
        return this.sendOpenAiCompatible(
          chatCompletionsEndpoint(config.localServerUrl),
          resolvedModel(config),
          null,
          messages,
          tools,
          options
        );
      case "CliPipe":
        return this.sendCli(config.cliCommand, latestUserPrompt(messages), config.cliTimeout);
      case "Terminal":
        return this.sendCli(config.terminalCommand, latestUserPrompt(messages), config.cliTimeout);
      case "LocalAI":
        if (!config.localServerUrl.trim()) {
          throw new Error("Local AI requires a local OpenAI-compatible endpoint in LM_Browser.");
        }
        return this.sendOpenAiCompatible(
          chatCompletionsEndpoint(config.localServerUrl),
          resolvedModel(config),
          null,
          normalizeForUniversalTemplate(messages),
          tools,
          options
        );
      default:
        throw new Error("Unsupported connection type.");
    }
  }

  private async sendApi(
    config: LlmConnectionConfig,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    options: { connectionTest?: boolean; maxTokens?: number; requireToolUse?: boolean }
  ): Promise<ParsedLlmResponse> {
    const info = this.providerDefaults(config.apiProvider);
    const endpoint = config.customEndpoint.trim() || info.url;
    if (!endpoint) throw new Error("API endpoint is required.");
    const apiKey = resolveApiKey(config.apiProvider, config.apiKey);
    if (info.requiresToken && !apiKey) throw new Error("API token is required.");

    if (info.adapter === "anthropic") {
      return this.sendAnthropic(endpoint, apiKey, config, messages, tools, options);
    }

    if (info.adapter === "google-ai") {
      const modelEndpoint = config.customEndpoint.trim()
        ? endpoint
        : `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel(config)}:generateContent`;
      return this.sendGoogle(modelEndpoint, apiKey, config, messages, tools, options);
    }

    const auth = apiKey && info.header ? { header: info.header, value: info.prefix + apiKey } : null;
    return this.sendOpenAiCompatible(endpoint, resolvedModel(config), auth, messages, tools, options);
  }

  private async sendOAuth(
    config: LlmConnectionConfig,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    options: { connectionTest?: boolean; maxTokens?: number; requireToolUse?: boolean }
  ): Promise<ParsedLlmResponse> {
    if (!config.oauthAccessToken.trim()) {
      throw new Error("OAuth token is missing. Connect OAuth in Settings first.");
    }
    if (!config.customEndpoint.trim()) {
      throw new Error("OAuth custom endpoint is required.");
    }
    return this.sendOpenAiCompatible(
      config.customEndpoint.trim(),
      resolvedModel(config),
      { header: "Authorization", value: "Bearer " + config.oauthAccessToken.trim() },
      messages,
      tools,
      options
    );
  }

  private async sendOpenAiCompatible(
    endpoint: string,
    model: string,
    auth: { header: string; value: string } | null,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    options: { connectionTest?: boolean; maxTokens?: number; requireToolUse?: boolean }
  ): Promise<ParsedLlmResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth?.header && auth.value) headers[auth.header] = auth.value;
    const payload: Record<string, unknown> = {
      model,
      messages: buildOpenAiMessages(messages),
      max_tokens: options.maxTokens || (options.connectionTest ? 64 : 4096),
      stream: false,
    };
    if (!options.connectionTest) payload.temperature = 0;
    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = options.connectionTest || options.requireToolUse ? "required" : "auto";
    }

    let { ok, status, body } = await postJson(endpoint, headers, payload);

    // "Thinking"/reasoning models (e.g. DeepSeek thinking, some o-series) reject
    // a forced or even explicit tool_choice. Degrade gracefully while keeping the
    // tools available: required -> auto -> omit the field entirely.
    if (
      !ok &&
      isToolChoiceLimitation(status, body) &&
      payload.tool_choice &&
      payload.tool_choice !== "auto"
    ) {
      payload.tool_choice = "auto";
      ({ ok, status, body } = await postJson(endpoint, headers, payload));
    }
    if (!ok && isToolChoiceLimitation(status, body) && "tool_choice" in payload) {
      delete payload.tool_choice;
      ({ ok, status, body } = await postJson(endpoint, headers, payload));
    }

    // Model can't do tool/function calling or the universal chat template at all:
    // drop tools and fold roles into a single user turn.
    if (!ok && isToolOrTemplateLimitation(status, body) && tools.length > 0) {
      const retryPayload = {
        ...payload,
        messages: buildOpenAiMessages(normalizeForUniversalTemplate(messages)),
        tools: undefined,
        tool_choice: undefined,
      };
      ({ ok, status, body } = await postJson(endpoint, headers, retryPayload));
    }

    if (!ok) throw new Error(`HTTP ${status}: ${trimForDisplay(body, 600)}`);
    return parseOpenAiResponse(body);
  }

  private async sendAnthropic(
    endpoint: string,
    key: string,
    config: LlmConnectionConfig,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    options: { connectionTest?: boolean; maxTokens?: number; requireToolUse?: boolean }
  ): Promise<ParsedLlmResponse> {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const nonSystem = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
    const anthropicTools = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    const payload: Record<string, unknown> = {
      model: resolvedModel(config),
      max_tokens: options.maxTokens || (options.connectionTest ? 64 : 4096),
      system,
      messages: nonSystem,
      stream: false,
    };
    if (anthropicTools.length > 0) {
      payload.tools = anthropicTools;
      payload.tool_choice = { type: options.connectionTest || options.requireToolUse ? "any" : "auto" };
    }

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
    let { ok, status, body } = await postJson(endpoint, headers, payload);

    // Extended-thinking models reject a forced tool_choice; fall back to auto, then omit.
    if (
      !ok &&
      isToolChoiceLimitation(status, body) &&
      payload.tool_choice &&
      (payload.tool_choice as { type?: string }).type !== "auto"
    ) {
      payload.tool_choice = { type: "auto" };
      ({ ok, status, body } = await postJson(endpoint, headers, payload));
    }
    if (!ok && isToolChoiceLimitation(status, body) && "tool_choice" in payload) {
      delete payload.tool_choice;
      ({ ok, status, body } = await postJson(endpoint, headers, payload));
    }

    if (!ok) throw new Error(`HTTP ${status}: ${trimForDisplay(body, 600)}`);
    return parseAnthropicResponse(body);
  }

  private async sendGoogle(
    endpoint: string,
    key: string,
    config: LlmConnectionConfig,
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    options: { connectionTest?: boolean; maxTokens?: number; requireToolUse?: boolean }
  ): Promise<ParsedLlmResponse> {
    const url = appendQuery(endpoint.replace("{model}", resolvedModel(config)), "key", key);
    const functionDeclarations = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
    const payload: Record<string, unknown> = {
      contents: buildGoogleContents(messages),
      generationConfig: {
        maxOutputTokens: options.maxTokens || (options.connectionTest ? 64 : 4096),
        temperature: options.connectionTest ? undefined : 0,
      },
    };
    if (functionDeclarations.length > 0) {
      payload.tools = [{ functionDeclarations }];
    }

    const response = await postJson(url, { "Content-Type": "application/json" }, payload);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${trimForDisplay(response.body, 600)}`);
    return parseGoogleResponse(response.body);
  }

  private async sendCli(template: string, prompt: string, timeoutSeconds: number): Promise<ParsedLlmResponse> {
    if (!template.trim()) throw new Error("Command template is empty.");
    const command = template.includes("{prompt}")
      ? template.replaceAll("{prompt}", quoteForShell(prompt))
      : template;
    const output = await runShell(command, template.includes("{prompt}") ? undefined : prompt, timeoutSeconds);
    const content = stripTerminalControlCodes(output).trim();
    const toolCalls = parseJsonToolCalls(content);
    return {
      content,
      toolCalls,
      raw: content,
    };
  }

  private async dispatchBrowserTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const controller = this.getController();
    const tabId = stringArg(args, "tabId") || stringArg(args, "tab_id") || undefined;
    switch (name) {
      case "browser":
        return this.dispatchBrowserJsonCommand(args, tabId);
      case "browser_navigate":
        return controller.navigate(requiredString(args, "url"), tabId);
      case "browser_snapshot": {
        const tab = await controller.getCurrentTab();
        const content = await controller.getContent("text", tabId);
        return { tab, content };
      }
      case "browser_tabs":
        return this.dispatchBrowserTabs(args);
      case "browser_click":
        return controller.click(selectorArg(args), tabId);
      case "browser_fill":
        return controller.fill(selectorArg(args), stringArg(args, "text") || stringArg(args, "value") || "", tabId);
      case "browser_type":
        return controller.executeJS(
          browserTypeScript(selectorArg(args, false), stringArg(args, "text") || ""),
          tabId
        );
      case "browser_scroll":
        return controller.executeJS(
          `window.scrollBy(${numberArg(args, "deltaX", 0)}, ${numberArg(args, "deltaY", 600)}); ({ success: true, scrollX: window.scrollX, scrollY: window.scrollY })`,
          tabId
        );
      case "browser_select_option":
        return controller.executeJS(selectOptionScript(selectorArg(args), stringArg(args, "value") || ""), tabId);
      case "browser_take_screenshot": {
        const shot = await controller.screenshot(tabId);
        return {
          format: shot.format,
          dataUrl: shot.dataUrl,
          bytes: Math.round((shot.dataUrl.length * 3) / 4),
        };
      }
      case "browser_press_key":
        return controller.executeJS(pressKeyScript(requiredString(args, "key"), selectorArg(args, false)), tabId);
      case "browser_highlight":
        return controller.executeJS(highlightScript(selectorArg(args)), tabId);
      case "browser_cdp":
        return controller.executeJS(requiredString(args, "js"), tabId);
      case "browser_get_text":
        return controller.getContent("text", tabId);
      case "browser_get_html":
        return controller.getContent("html", tabId);
      case "browser_reload":
        return controller.reload(tabId);
      case "browser_back":
        return controller.goBack(tabId);
      case "browser_forward":
        return controller.goForward(tabId);
      case "done":
        return { success: true, message: stringArg(args, "message") || "Done." };
      case "ask_user":
        return { needsUser: true, question: stringArg(args, "question") || "" };
      default:
        throw new Error(`Unknown browser tool: ${name}`);
    }
  }

  private async dispatchBrowserJsonCommand(args: Record<string, unknown>, tabId?: string): Promise<unknown> {
    const input = typeof args.input === "string" ? args.input : JSON.stringify(args);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input) as Record<string, unknown>;
    } catch {
      parsed = { op: "eval", js: input };
    }
    const op = String(parsed.op || parsed.action || "").toLowerCase();
    const mapped = opToToolName(op);
    return this.dispatchBrowserTool(mapped, { ...parsed, tabId });
  }

  private async dispatchBrowserTabs(args: Record<string, unknown>): Promise<unknown> {
    const controller = this.getController();
    // "op" accepted as an alias for "action" — the generic `browser` JSON router and
    // external docs use op:new_tab/switch_tab/..., and models carry that habit here.
    const action = (stringArg(args, "action") || stringArg(args, "op") || "list")
      .toLowerCase()
      .replace(/^(new_tab|create)$/, "new")
      .replace(/^switch_tab$/, "switch")
      .replace(/^close_tab$/, "close");
    if (action === "new" || action === "new_tab") {
      return controller.createTab(stringArg(args, "url") || undefined, true);
    }
    if (action === "switch") {
      const tabId = requiredString(args, "tabId");
      return controller.switchTab(tabId);
    }
    if (action === "close") {
      return controller.closeTab(stringArg(args, "tabId") || undefined);
    }
    return { tabs: await controller.listTabs() };
  }

  private systemPrompt(config: LlmConnectionConfig): string {
    const custom = config.systemPrompt.trim();
    const toolNames = browserToolDefinitions().map((tool) => tool.function.name).join(", ");
    const bridgePrompt =
      "You are connected to LM_Browser. Use the browser bridge tools to operate the visible browser on the user's command. " +
      "Use browser_navigate for in-app navigation, browser_snapshot or browser_get_text to inspect the page, " +
      "browser_click/browser_fill/browser_type/browser_press_key/browser_scroll to act, and done when the task is complete. " +
      "Work efficiently: prefer the fewest tool calls and don't re-inspect the page unless something changed. " +
      "To search the web, navigate directly to the results URL (e.g. https://www.google.com/search?q=YOUR+QUERY) instead of typing into a search box. " +
      "If the user's request is ambiguous or missing a key detail, call ask_user to ask ONE concise clarifying question instead of guessing. " +
      "Never claim a browser action succeeded unless a tool result confirms it. Available tools: " +
      toolNames +
      ".";
    return custom ? `${custom}\n\n${bridgePrompt}` : bridgePrompt;
  }

  private historyMessages(history: AssistantChatMessage[]): LlmMessage[] {
    return history.slice(-12).map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }

  private connectionSummary(config: LlmConnectionConfig): AssistantResponse["connection"] {
    return {
      type: config.connectionType,
      provider:
        config.connectionType === "ApiKey"
          ? config.apiProvider
          : config.connectionType === "OAuth"
            ? config.oauthProvider
            : config.connectionType,
      model: resolvedModel(config),
    };
  }

  private async loadConfig(): Promise<LlmConnectionConfig> {
    try {
      const raw = await fs.readFile(this.configPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredLlmConnectionConfig>;
      return this.hydrateConfig(parsed);
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private hydrateConfig(stored: Partial<StoredLlmConnectionConfig>): LlmConnectionConfig {
    const config = { ...DEFAULT_CONFIG, ...stored } as LlmConnectionConfig;
    config.apiKey = decryptSecret(stored.apiKeyEncrypted) || stored.apiKey || "";
    config.oauthAccessToken =
      decryptSecret(stored.oauthAccessTokenEncrypted) || stored.oauthAccessToken || "";
    config.oauthRefreshToken =
      decryptSecret(stored.oauthRefreshTokenEncrypted) || stored.oauthRefreshToken || "";
    config.connectionType = validConnectionType(config.connectionType);
    config.apiProvider = validApiProvider(config.apiProvider);
    config.oauthProvider = validOAuthProvider(config.oauthProvider);
    config.cliTimeout = clampNumber(config.cliTimeout, 1, 600, DEFAULT_CONFIG.cliTimeout);
    config.localAIContextSize = clampNumber(config.localAIContextSize, 512, 1_000_000, DEFAULT_CONFIG.localAIContextSize);
    config.maxToolRounds = clampNumber(config.maxToolRounds, 0, 1000, DEFAULT_CONFIG.maxToolRounds);
    return config;
  }

  private mergeConfig(
    current: LlmConnectionConfig,
    input: Partial<LlmConnectionConfig>
  ): LlmConnectionConfig {
    const next = { ...current, ...input };
    if (input.apiKey === "" || input.apiKey === SECRET_MASK) next.apiKey = current.apiKey;
    if (input.oauthAccessToken === "" || input.oauthAccessToken === SECRET_MASK) {
      next.oauthAccessToken = current.oauthAccessToken;
    }
    if (input.oauthRefreshToken === "" || input.oauthRefreshToken === SECRET_MASK) {
      next.oauthRefreshToken = current.oauthRefreshToken;
    }
    next.connectionType = validConnectionType(next.connectionType);
    next.apiProvider = validApiProvider(next.apiProvider);
    next.oauthProvider = validOAuthProvider(next.oauthProvider);
    next.cliTimeout = clampNumber(next.cliTimeout, 1, 600, DEFAULT_CONFIG.cliTimeout);
    next.localAIContextSize = clampNumber(next.localAIContextSize, 512, 1_000_000, DEFAULT_CONFIG.localAIContextSize);
    next.maxToolRounds = clampNumber(next.maxToolRounds, 0, 1000, DEFAULT_CONFIG.maxToolRounds);

    const defaults = this.providerDefaults(next.apiProvider);
    if (input.apiProvider && !input.model && next.connectionType === "ApiKey") {
      next.model = defaults.model;
    }
    return next;
  }

  private async writeConfig(config: LlmConnectionConfig): Promise<void> {
    const stored: StoredLlmConnectionConfig = {
      ...config,
      apiKey: undefined,
      apiKeyEncrypted: encryptSecret(config.apiKey),
      oauthAccessToken: undefined,
      oauthAccessTokenEncrypted: encryptSecret(config.oauthAccessToken),
      oauthRefreshToken: undefined,
      oauthRefreshTokenEncrypted: encryptSecret(config.oauthRefreshToken),
    };
    if (!stored.apiKeyEncrypted && config.apiKey) stored.apiKey = config.apiKey;
    if (!stored.oauthAccessTokenEncrypted && config.oauthAccessToken) stored.oauthAccessToken = config.oauthAccessToken;
    if (!stored.oauthRefreshTokenEncrypted && config.oauthRefreshToken) stored.oauthRefreshToken = config.oauthRefreshToken;
    const configPath = this.configPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(stored, null, 2), "utf8");
  }

  private forRenderer(config: LlmConnectionConfig): LlmConnectionConfigForRenderer {
    return {
      ...config,
      apiKey: "",
      oauthAccessToken: "",
      oauthRefreshToken: "",
      hasApiKey: Boolean(config.apiKey.trim()),
      hasOAuthToken: Boolean(config.oauthAccessToken.trim()),
      secretMask: SECRET_MASK,
    };
  }

  private configPath(): string {
    return path.join(app.getPath("userData"), CONNECTION_CONFIG_FILE);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export function browserToolDefinitions(): LlmToolDefinition[] {
  return [
    tool("browser", "Run a browser command JSON object/string with an op such as navigate, click, fill, snapshot, tabs, eval.", {
      input: stringProp("JSON command string, e.g. {\"op\":\"navigate\",\"url\":\"https://example.com\"}."),
      session_id: stringProp("Optional session id for compatibility."),
    }),
    tool("browser_navigate", "Navigate the active LM_Browser tab to a URL.", {
      url: requiredStringProp("Destination URL"),
      tabId: stringProp("Optional tab id"),
    }, ["url"]),
    tool("browser_snapshot", "Capture the active tab URL/title and page text.", {
      tabId: stringProp("Optional tab id"),
    }),
    tool("browser_tabs", "List, create, switch, or close LM_Browser tabs.", {
      action: stringProp("list, new, switch, or close"),
      url: stringProp("URL for action=new"),
      tabId: stringProp("Tab id for switch/close"),
    }),
    tool("browser_click", "Click a page element by CSS selector.", {
      selector: requiredStringProp("CSS selector"),
      tabId: stringProp("Optional tab id"),
    }, ["selector"]),
    tool("browser_fill", "Fill an input by CSS selector.", {
      selector: requiredStringProp("CSS selector"),
      text: requiredStringProp("Text value"),
      tabId: stringProp("Optional tab id"),
    }, ["selector", "text"]),
    tool("browser_type", "Type text into an element or the focused page target.", {
      selector: stringProp("Optional CSS selector"),
      text: requiredStringProp("Text to type"),
      tabId: stringProp("Optional tab id"),
    }, ["text"]),
    tool("browser_scroll", "Scroll the page.", {
      deltaX: numberProp("Horizontal scroll amount"),
      deltaY: numberProp("Vertical scroll amount"),
      tabId: stringProp("Optional tab id"),
    }),
    tool("browser_select_option", "Select an option in a select element by CSS selector.", {
      selector: requiredStringProp("CSS selector"),
      value: requiredStringProp("Option value"),
      tabId: stringProp("Optional tab id"),
    }, ["selector", "value"]),
    tool("browser_take_screenshot", "Capture a PNG screenshot of the active tab.", {
      tabId: stringProp("Optional tab id"),
    }),
    tool("browser_press_key", "Press a key in the page context.", {
      key: requiredStringProp("Key name"),
      selector: stringProp("Optional CSS selector to focus first"),
      tabId: stringProp("Optional tab id"),
    }, ["key"]),
    tool("browser_highlight", "Highlight a page element by CSS selector.", {
      selector: requiredStringProp("CSS selector"),
      tabId: stringProp("Optional tab id"),
    }, ["selector"]),
    tool("browser_cdp", "Run JavaScript in the active browser page.", {
      js: requiredStringProp("JavaScript expression or function body"),
      tabId: stringProp("Optional tab id"),
    }, ["js"]),
    tool("browser_get_text", "Read visible text from the active tab.", {
      tabId: stringProp("Optional tab id"),
    }),
    tool("browser_get_html", "Read full HTML from the active tab.", {
      tabId: stringProp("Optional tab id"),
    }),
    tool("browser_reload", "Reload the active tab.", {
      tabId: stringProp("Optional tab id"),
    }),
    tool("browser_back", "Navigate back in the active tab history.", {
      tabId: stringProp("Optional tab id"),
    }),
    tool("browser_forward", "Navigate forward in the active tab history.", {
      tabId: stringProp("Optional tab id"),
    }),
    tool("done", "Signal that the browser task is complete.", {
      message: requiredStringProp("Final message for the user"),
    }, ["message"]),
    tool("ask_user", "Ask the user a clarification question.", {
      question: requiredStringProp("Question for the user"),
    }, ["question"]),
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): LlmToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

function stringProp(description: string): Record<string, string> {
  return { type: "string", description };
}

function requiredStringProp(description: string): Record<string, string> {
  return stringProp(description);
}

function numberProp(description: string): Record<string, string> {
  return { type: "number", description };
}

function resolvedModel(config: LlmConnectionConfig): string {
  if (config.connectionType === "ApiKey" || config.connectionType === "OAuth") {
    return config.model.trim() || PROVIDER_INFO[config.apiProvider].model || "gpt-4o";
  }
  if (config.connectionType === "LocalServer") {
    return config.localModelName.trim() || "llama3";
  }
  if (config.connectionType === "LocalAI") {
    return config.localAIModelName.trim() || path.basename(config.localAIModelPath || "") || "local-model";
  }
  return "cli";
}

function resolveApiKey(provider: AppApiProvider, inlineKey: string): string {
  if (isUsableSecret(inlineKey)) return inlineKey.trim();
  for (const envName of apiKeyEnvironmentNames(provider)) {
    const value = process.env[envName];
    if (isUsableSecret(value)) return value!.trim();
  }
  return "";
}

function apiKeyEnvironmentNames(provider: AppApiProvider): string[] {
  switch (provider) {
    case "OpenAI": return ["OPENAI_API_KEY"];
    case "Anthropic": return ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"];
    case "Groq": return ["GROQ_API_KEY"];
    case "OpenRouter": return ["OPENROUTER_API_KEY"];
    case "DeepSeek": return ["DEEPSEEK_API_KEY"];
    case "Together": return ["TOGETHER_API_KEY"];
    case "Mistral": return ["MISTRAL_API_KEY"];
    case "XAI": return ["XAI_API_KEY", "GROK_API_KEY"];
    case "GoogleAI": return ["GOOGLE_API_KEY", "GEMINI_API_KEY"];
    case "AzureOpenAI": return ["AZURE_OPENAI_API_KEY"];
    case "Perplexity": return ["PERPLEXITY_API_KEY"];
    case "Fireworks": return ["FIREWORKS_API_KEY"];
    case "HuggingFace": return ["HUGGINGFACE_API_KEY", "HF_TOKEN"];
    case "Novita": return ["NOVITA_API_KEY"];
    case "ZAI": return ["ZAI_API_KEY"];
    case "PPIO": return ["PPIO_API_KEY"];
    case "ApiPie": return ["APIPIE_API_KEY"];
    case "MoonshotAI": return ["MOONSHOT_API_KEY", "MOONSHOTAI_API_KEY"];
    case "CometAPI": return ["COMETAPI_API_KEY", "COMET_API_KEY"];
    case "GiteeAI": return ["GITEEAI_API_KEY", "GITEE_API_KEY"];
    case "SambaNova": return ["SAMBANOVA_API_KEY"];
    case "NvidiaNim": return ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"];
    case "Lemonade": return ["LEMONADE_API_KEY"];
    default: return [];
  }
}

function isUsableSecret(value?: string): boolean {
  if (!value || !value.trim()) return false;
  return !/^[.*\u2022]+$/.test(value.trim());
}

function chatCompletionsEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Local server URL is required.");
  if (/\/chat\/completions$/i.test(trimmed) || trimmed.toLowerCase().includes("/chat/completions")) {
    return trimmed;
  }
  if (/\/v1\/?$/i.test(trimmed)) return trimmed.replace(/\/$/, "") + "/chat/completions";
  return trimmed.replace(/\/$/, "") + "/v1/chat/completions";
}

function buildOpenAiMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    const output: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };
    if (message.name) output.name = message.name;
    if (message.tool_call_id) output.tool_call_id = message.tool_call_id;
    if (message.tool_calls) output.tool_calls = message.tool_calls;
    return output;
  });
}

function buildGoogleContents(messages: LlmMessage[]): Array<Record<string, unknown>> {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const rest = messages.filter((message) => message.role !== "system");
  const contents: Array<Record<string, unknown>> = [];
  if (system) {
    contents.push({ role: "user", parts: [{ text: system }] });
  }
  for (const message of rest) {
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    });
  }
  return contents;
}

function normalizeForUniversalTemplate(messages: LlmMessage[]): LlmMessage[] {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const rest = messages.filter((message) => message.role !== "system").map((message) => ({ ...message }));
  if (system) {
    const firstUser = rest.find((message) => message.role === "user");
    if (firstUser) firstUser.content = system + (firstUser.content ? "\n\n" + firstUser.content : "");
    else rest.unshift({ role: "user", content: system });
  }
  const output: LlmMessage[] = [];
  for (const message of rest) {
    const last = output[output.length - 1];
    if (last && last.role === message.role) {
      last.content = [last.content, message.content].filter(Boolean).join("\n\n");
    } else {
      output.push(message);
    }
  }
  return output;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(removeUndefined(payload)),
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, removeUndefined(item)])
    );
  }
  return value;
}

function parseOpenAiResponse(body: string): ParsedLlmResponse {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  const first = choices[0] as { message?: Record<string, unknown> } | undefined;
  const message = first?.message || {};
  const content = contentToText(message.content);
  const nativeToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = nativeToolCalls.map((item, index) => {
    const call = item as Record<string, unknown>;
    const fn = (call.function || {}) as Record<string, unknown>;
    return {
      id: String(call.id || `call_${index}`),
      name: String(fn.name || ""),
      arguments: parseArguments(String(fn.arguments || "{}")),
    };
  }).filter((call) => call.name);
  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : parseJsonToolCalls(content),
    raw,
  };
}

function parseAnthropicResponse(body: string): ParsedLlmResponse {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const text: string[] = [];
  const toolCalls: ParsedToolCall[] = [];
  blocks.forEach((block, index) => {
    const item = block as Record<string, unknown>;
    if (item.type === "text") text.push(String(item.text || ""));
    if (item.type === "tool_use") {
      toolCalls.push({
        id: String(item.id || `call_${index}`),
        name: String(item.name || ""),
        arguments: objectArg(item.input),
      });
    }
  });
  const content = text.join("");
  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : parseJsonToolCalls(content),
    raw,
  };
}

function parseGoogleResponse(body: string): ParsedLlmResponse {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  const first = candidates[0] as { content?: { parts?: unknown[] } } | undefined;
  const parts = Array.isArray(first?.content?.parts) ? first!.content!.parts! : [];
  const text: string[] = [];
  const toolCalls: ParsedToolCall[] = [];
  parts.forEach((part, index) => {
    const item = part as Record<string, unknown>;
    if (typeof item.text === "string") text.push(item.text);
    if (item.functionCall && typeof item.functionCall === "object") {
      const call = item.functionCall as Record<string, unknown>;
      toolCalls.push({
        id: `call_${index}`,
        name: String(call.name || ""),
        arguments: objectArg(call.args),
      });
    }
  });
  const content = text.join("");
  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : parseJsonToolCalls(content),
    raw,
  };
}

function parseJsonToolCalls(content: string): ParsedToolCall[] {
  const normalized = content.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  if (!normalized.startsWith("{") && !normalized.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(normalized);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .map((item, index) => {
        const obj = objectArg(item);
        const name = stringArg(obj, "action") || stringArg(obj, "tool") || stringArg(obj, "name");
        if (!name) return null;
        const args = { ...obj };
        delete args.action;
        delete args.tool;
        delete args.name;
        return { id: `json_${index}`, name, arguments: args };
      })
      .filter((item): item is ParsedToolCall => Boolean(item));
  } catch {
    return [];
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) {
        return String((item as { text?: unknown }).text || "");
      }
      return "";
    }).join("");
  }
  return "";
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    return objectArg(JSON.parse(value || "{}"));
  } catch {
    return {};
  }
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function latestUserPrompt(messages: LlmMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].content;
  }
  return "";
}

function selectorArg(args: Record<string, unknown>, required = true): string {
  const selector = stringArg(args, "selector") || stringArg(args, "ref");
  if (!selector && required) throw new Error("selector is required.");
  return selector || "";
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function opToToolName(op: string): string {
  switch (op) {
    case "navigate":
    case "goto":
    case "open":
      return "browser_navigate";
    case "snapshot":
    case "observe":
    case "read":
      return "browser_snapshot";
    case "tabs":
    case "list_tabs":
    case "new_tab":
    case "switch_tab":
      return "browser_tabs";
    case "click":
      return "browser_click";
    case "fill":
      return "browser_fill";
    case "type":
      return "browser_type";
    case "scroll":
      return "browser_scroll";
    case "select_option":
      return "browser_select_option";
    case "screenshot":
      return "browser_take_screenshot";
    case "press":
    case "press_key":
      return "browser_press_key";
    case "highlight":
      return "browser_highlight";
    case "eval":
    case "cdp":
      return "browser_cdp";
    case "get_html":
      return "browser_get_html";
    case "get_text":
      return "browser_get_text";
    case "reload":
      return "browser_reload";
    case "back":
      return "browser_back";
    case "forward":
      return "browser_forward";
    default:
      return op;
  }
}

function browserTypeScript(selector: string, text: string): string {
  const selectorJson = JSON.stringify(selector);
  const textJson = JSON.stringify(text);
  return `
    (() => {
      const selector = ${selectorJson};
      const text = ${textJson};
      const el = selector ? document.querySelector(selector) : document.activeElement;
      if (!el) return { success: false, found: false };
      el.focus();
      if ('value' in el) {
        el.value = String(el.value || '') + text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = String(el.textContent || '') + text;
      }
      return { success: true, found: true, tagName: el.tagName };
    })()
  `;
}

function selectOptionScript(selector: string, value: string): string {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { success: false, found: false };
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, found: true, value: el.value };
    })()
  `;
}

function pressKeyScript(key: string, selector: string): string {
  return `
    (() => {
      const selector = ${JSON.stringify(selector)};
      const target = selector ? document.querySelector(selector) : (document.activeElement || document.body);
      if (!target) return { success: false, found: false };
      target.focus?.();
      const key = ${JSON.stringify(key)};
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      return { success: true, key };
    })()
  `;
}

function highlightScript(selector: string): string {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { success: false, found: false };
      el.dataset.lmBrowserPreviousOutline = el.style.outline || '';
      el.style.outline = '3px solid #1a73e8';
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return { success: true, found: true };
    })()
  `;
}

function trimForModel(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + `\n[truncated ${value.length - max} chars]`;
}

function trimForDisplay(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + "...";
}

function isToolChoiceLimitation(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const lower = body.toLowerCase();
  return lower.includes("tool_choice")
    || lower.includes("tool choice")
    || (lower.includes("thinking mode") && lower.includes("tool"))
    || (lower.includes("reasoning") && lower.includes("tool_choice"));
}

function isToolOrTemplateLimitation(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const lower = body.toLowerCase();
  if (lower.includes("response_format")) return false;
  return lower.includes("does not support tools")
    || lower.includes("tools are not supported")
    || lower.includes("tool calling is not supported")
    || lower.includes("function calling is not supported")
    || lower.includes("unable to generate parser")
    || lower.includes("roles must alternate")
    || lower.includes("conversation roles")
    || lower.includes("system role")
    || lower.includes("only user and assistant roles")
    || lower.includes("jinja");
}

function runShell(command: string, stdin: string | undefined, timeoutSeconds: number): Promise<string> {
  const timeout = clampNumber(timeoutSeconds, 1, 600, 120) * 1000;
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn("/bin/zsh", ["-lc", command], {
      cwd: app.getPath("home"),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutSeconds}s.`));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = [stdout, stderr ? `stderr:\n${stderr}` : ""].filter(Boolean).join("\n");
      if (code && code !== 0) reject(new Error(output || `Command exited with ${code}.`));
      else resolve(output);
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function quoteForShell(value: string): string {
  const sanitized = value.replace(/\r/g, " ").replace(/\n/g, " ");
  return "'" + sanitized.replace(/'/g, "'\"'\"'") + "'";
}

function stripTerminalControlCodes(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "");
}

function encryptSecret(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.encryptString(value).toString("base64");
  } catch {
    return undefined;
  }
}

function decryptSecret(value?: string): string {
  if (!value) return "";
  try {
    if (!safeStorage.isEncryptionAvailable()) return "";
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function validConnectionType(value: unknown): AppConnectionType {
  return CONNECTION_TYPES.includes(value as AppConnectionType)
    ? (value as AppConnectionType)
    : DEFAULT_CONFIG.connectionType;
}

function validApiProvider(value: unknown): AppApiProvider {
  return API_PROVIDERS.includes(value as AppApiProvider)
    ? (value as AppApiProvider)
    : DEFAULT_CONFIG.apiProvider;
}

function validOAuthProvider(value: unknown): AppOAuthProviderType {
  return OAUTH_PROVIDERS.includes(value as AppOAuthProviderType)
    ? (value as AppOAuthProviderType)
    : DEFAULT_CONFIG.oauthProvider;
}

function oauthProviderDefaults(provider: AppOAuthProviderType): {
  authUrl: string;
  tokenUrl: string;
  scope: string;
} {
  switch (provider) {
    case "GoogleVertex":
      return {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/cloud-platform",
      };
    case "Azure":
      return {
        authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scope: "https://cognitiveservices.azure.com/.default",
      };
    case "HuggingFace":
      return {
        authUrl: "https://huggingface.co/oauth/authorize",
        tokenUrl: "https://huggingface.co/oauth/token",
        scope: "openid profile email",
      };
    default:
      return { authUrl: "", tokenUrl: "", scope: "" };
  }
}

function buildOAuthAuthorizationUrl(
  authUrl: string,
  clientId: string,
  scope: string,
  codeChallenge: string,
  state: string
): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: "code",
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return authUrl + (authUrl.includes("?") ? "&" : "?") + query.toString();
}

function generatePkceVerifier(): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.randomBytes(64);
  return Array.from(bytes, (byte) => charset[byte % charset.length]).join("");
}

function generatePkceChallenge(verifier: string): string {
  return crypto.createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function exchangeOAuthCode(
  code: string,
  tokenUrl: string,
  clientId: string,
  verifier: string
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: verifier,
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed: HTTP ${response.status}: ${trimForDisplay(text, 400)}`);
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!accessToken) throw new Error("Token response missing access_token.");
  const refreshToken = typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined;
  const expiresIn = Number(parsed.expires_in || 3600);
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
  };
}

function appendQuery(url: string, key: string, value: string): string {
  if (!value) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}
