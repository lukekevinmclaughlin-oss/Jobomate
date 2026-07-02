import React, { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { useHistoryStore } from "../stores/historyStore";
import { useDownloadStore } from "../stores/downloadStore";
import { SetupWizard } from "./SetupWizard";
import {
  CheckCircle2,
  Cpu,
  Globe,
  Link,
  PlugZap,
  RotateCcw,
  Save,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  X,
  XCircle,
} from "lucide-react";

interface SettingsPanelProps {
  onClose: () => void;
}

const connectionTypes: Array<{ value: LlmConnectionType; label: string }> = [
  { value: "ApiKey", label: "API Key" },
  { value: "LocalServer", label: "Local Server" },
  { value: "CliPipe", label: "CLI Pipe" },
  { value: "OAuth", label: "OAuth" },
  { value: "Terminal", label: "Terminal" },
  { value: "LocalAI", label: "Local AI" },
];

// Z.AI serves its GLM Coding Plan from a different base path than the standard
// PAYG API. This is a USER-CONTROLLED opt-in (toggle below) — never a default.
const ZAI_CODING_ENDPOINT = "https://api.z.ai/api/coding/paas/v4/chat/completions";

const apiProviders: LlmApiProvider[] = [
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

const oauthProviders: LlmOAuthProvider[] = [
  "GoogleVertex",
  "Azure",
  "HuggingFace",
  "Custom",
];

const CATEGORIES = [
  { id: "connection", label: "LLM Connection", Icon: Cpu },
  { id: "browser", label: "Browser", Icon: Globe },
  { id: "privacy", label: "Privacy & data", Icon: Shield },
  { id: "bridge", label: "Bridge Server", Icon: Server },
];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ onClose }) => {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const clearHistory = useHistoryStore((s) => s.clearHistory);
  const clearDownloads = useDownloadStore((s) => s.clearCompleted);
  const [settingsTab, setSettingsTab] = useState(0);
  const [localSettings, setLocalSettings] = useState({ ...settings });
  const [llmConfig, setLlmConfig] = useState<LlmConnectionConfig | null>(null);
  const [status, setStatus] = useState("Settings ready.");
  const [statusKind, setStatusKind] = useState<"idle" | "ok" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // "Clear browsing data" — what to wipe + progress.
  const [clearOpts, setClearOpts] = useState({ history: true, cookies: true, cache: true, siteData: false, downloads: true });
  const [clearing, setClearing] = useState(false);
  const [clearMsg, setClearMsg] = useState("");

  const handleClearData = async () => {
    setClearing(true);
    setClearMsg("");
    try {
      if (clearOpts.history) clearHistory();
      if (clearOpts.downloads) clearDownloads();
      if (clearOpts.cookies || clearOpts.cache || clearOpts.siteData) {
        const r = await window.browserAPI?.privacy?.clearBrowsingData({
          cookies: clearOpts.cookies,
          cache: clearOpts.cache,
          siteData: clearOpts.siteData,
        });
        if (r && !r.ok) {
          setClearMsg("Couldn't clear site data: " + (r.error || "error"));
          setClearing(false);
          return;
        }
      }
      setClearMsg("Browsing data cleared.");
    } catch (e) {
      setClearMsg("Error: " + (e as Error).message);
    }
    setClearing(false);
  };

  const activeType = llmConfig?.connectionType || "LocalServer";
  const secretPlaceholder = useMemo(() => {
    if (!llmConfig?.hasApiKey) return "API token";
    return `${llmConfig.secretMask} saved`;
  }, [llmConfig?.hasApiKey, llmConfig?.secretMask]);

  useEffect(() => {
    const api = window.browserAPI;
    if (!api?.llmConnection) return;
    let cancelled = false;
    api.llmConnection
      .getConfig()
      .then((config) => {
        if (!cancelled) setLlmConfig(config);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setStatus(error.message);
          setStatusKind("error");
        }
      });
    const dispose = api.onOAuthUpdated?.((payload) => {
      setStatus(payload.message);
      setStatusKind(payload.error ? "error" : "ok");
      api.llmConnection.getConfig().then(setLlmConfig).catch(() => undefined);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const updateBrowserSetting = (key: string, value: unknown) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateLlmConfig = <K extends keyof LlmConnectionConfig>(
    key: K,
    value: LlmConnectionConfig[K]
  ) => {
    setLlmConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleProviderChange = async (provider: LlmApiProvider) => {
    updateLlmConfig("apiProvider", provider);
    setModelOptions([]); // provider changed → previous model list no longer applies
    const defaults = await window.browserAPI?.llmConnection.providerDefaults(provider);
    setLlmConfig((prev) =>
      prev
        ? {
            ...prev,
            apiProvider: provider,
            model: defaults?.model || prev.model,
            customEndpoint: provider === "Custom" ? prev.customEndpoint : "",
          }
        : prev
    );
  };

  // Load the connection's available models into the dropdown (uses the saved key
  // server-side). Saves the current form first so the just-typed key/endpoint is
  // used. Never surfaces a raw error — connectionModels returns a friendly one.
  const loadModels = async () => {
    if (!llmConfig || !window.browserAPI?.llmConnection) return;
    setLoadingModels(true);
    setStatus("Loading models…");
    setStatusKind("idle");
    try {
      const saved = await window.browserAPI.llmConnection.saveConfig(llmConfig);
      setLlmConfig(saved);
      const res = await window.browserAPI.llmConnection.connectionModels(saved);
      setModelOptions(res.models || []);
      if (res.models && res.models.length > 0 && !res.models.includes(saved.model)) {
        updateLlmConfig("model", res.models[0]);
      }
      setStatus(res.message || (res.ok ? "Models loaded." : "Couldn't load models."));
      setStatusKind(res.ok ? "ok" : "error");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
    } finally {
      setLoadingModels(false);
    }
  };

  // Auto-detect provider/endpoint/model from the typed API key — the same probe
  // the setup wizard uses, so the settings form is never worse than the wizard.
  const detectFromKey = async () => {
    if (!llmConfig || !window.browserAPI?.llmConnection) return;
    const key = (llmConfig.apiKey || "").trim();
    if (!key) {
      setStatus("Type or paste the API key first, then Detect.");
      setStatusKind("error");
      return;
    }
    setBusy(true);
    setStatus("Detecting provider and models from the key…");
    setStatusKind("idle");
    try {
      const res = await window.browserAPI.llmConnection.probeApiKey({ apiKey: key });
      if (res?.ok && res.provider) {
        setLlmConfig((prev) =>
          prev
            ? {
                ...prev,
                connectionType: "ApiKey",
                apiProvider: res.provider as LlmApiProvider,
                model: res.recommendedModel || prev.model,
                customEndpoint: "",
              }
            : prev
        );
        setModelOptions((res.models || []).map((m: { id: string }) => m.id));
        setStatus(res.message || `Detected ${res.provider}.`);
        setStatusKind("ok");
      } else {
        setStatus(res?.message || "Couldn't detect a provider from this key.");
        setStatusKind("error");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
    } finally {
      setBusy(false);
    }
  };

  // Scan localhost for running LLM runtimes (Ollama, LM Studio, llama.cpp, vLLM,
  // Jan, …) and fill the Local Server form with the first hit.
  const scanLocalServers = async () => {
    if (!window.browserAPI?.llmConnection) return;
    setBusy(true);
    setStatus("Scanning localhost for running model servers…");
    setStatusKind("idle");
    try {
      const found = (await window.browserAPI.llmConnection.discoverLocal()) || [];
      if (found.length === 0) {
        setStatus("No local model server found. Start Ollama / LM Studio / llama.cpp (or any OpenAI-compatible server) and scan again.");
        setStatusKind("error");
      } else {
        const first = found[0];
        setLlmConfig((prev) =>
          prev
            ? {
                ...prev,
                connectionType: "LocalServer",
                localServerUrl: first.chatUrl,
                localModelName: first.models[0]?.id || prev.localModelName || "local-model",
              }
            : prev
        );
        setModelOptions(first.models.map((m) => m.id));
        const others = found.length > 1 ? ` (+${found.length - 1} more runtime(s) found — Load models after changing the URL)` : "";
        setStatus(`Found ${first.runtime} at ${first.baseUrl} with ${first.models.length} model(s)${others}. Click Connect to finish.`);
        setStatusKind("ok");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
    } finally {
      setBusy(false);
    }
  };

  // A model chooser: a dropdown of the connection's available models + a "Load
  // models" button. Falls back to a text input until models are loaded (or for a
  // provider that doesn't expose a model list). `fieldKey` targets the config
  // field to write (API/OAuth = "model", Local = "localModelName").
  const renderModelField = (fieldKey: "model" | "localModelName", label = "Model") => {
    if (!llmConfig) return null;
    const current = (llmConfig[fieldKey] as string) || "";
    const options = Array.from(
      new Set([current, ...modelOptions].map((s) => (s || "").trim()).filter(Boolean)),
    );
    const write = (value: string) =>
      setLlmConfig((prev) => (prev ? { ...prev, [fieldKey]: value } : prev));
    return (
      <label className="settings-field">
        <span>{label}</span>
        <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
          {modelOptions.length > 0 ? (
            <select style={{ flex: 1 }} value={current} onChange={(e) => write(e.target.value)}>
              {options.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              style={{ flex: 1 }}
              value={current}
              placeholder="Click “Load models”, or type a model id"
              onChange={(e) => write(e.target.value)}
            />
          )}
          <button
            type="button"
            onClick={() => void loadModels()}
            disabled={loadingModels}
            style={{ whiteSpace: "nowrap", padding: "0 10px", cursor: loadingModels ? "default" : "pointer" }}
          >
            {loadingModels ? "Loading…" : "↻ Load models"}
          </button>
        </div>
      </label>
    );
  };

  const handleSave = async () => {
    updateSettings(localSettings);
    if (!llmConfig || !window.browserAPI?.llmConnection) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const saved = await window.browserAPI.llmConnection.saveConfig(llmConfig);
      setLlmConfig(saved);
      setStatus("Settings saved.");
      setStatusKind("ok");
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    if (!llmConfig || !window.browserAPI?.llmConnection) return;
    setBusy(true);
    setStatus("Testing connection...");
    setStatusKind("idle");
    try {
      const result = await window.browserAPI.llmConnection.test(llmConfig);
      setStatus(result.message);
      setStatusKind(result.ok ? "ok" : "error");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
    } finally {
      setBusy(false);
    }
  };

  const handleOAuth = async () => {
    if (!llmConfig || !window.browserAPI?.llmConnection) return;
    setBusy(true);
    try {
      const result = await window.browserAPI.llmConnection.startOAuth(llmConfig);
      setStatus(`OAuth started for ${result.provider}.`);
      setStatusKind("ok");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
    } finally {
      setBusy(false);
    }
  };

  const handleReset = () => {
    resetSettings();
    setLocalSettings({ ...settings });
  };

  return (
    <div className="settings-panel academy-settings">
      <aside className="academy-settings__nav">
        <div className="academy-settings__title">Settings</div>
        {CATEGORIES.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className={"academy-settings__cat" + (settingsTab === i ? " academy-settings__cat--active" : "")}
            onClick={() => setSettingsTab(i)}
          >
            <c.Icon size={18} strokeWidth={1.75} />
            <span>{c.label}</span>
          </button>
        ))}
      </aside>

      <div className="academy-settings__main">
        <button className="settings-panel__close" onClick={onClose} aria-label="Close settings">
          <X size={18} />
        </button>

        <div className="academy-settings__content">
          {settingsTab === 0 && (
            <section className="settings-section settings-section--connection">
          <div className="settings-section__heading">
            <PlugZap size={16} />
            <h3>LLM Connection</h3>
            <button
              type="button"
              className="settings-wizard-trigger"
              onClick={() => setWizardOpen(true)}
              title="Guided setup"
            >
              ✨ Setup Wizard
            </button>
          </div>

          <div className="settings-segmented">
            {connectionTypes.map((type) => (
              <button
                key={type.value}
                className={`settings-segmented__item ${
                  activeType === type.value ? "settings-segmented__item--active" : ""
                }`}
                onClick={() => updateLlmConfig("connectionType", type.value)}
              >
                {type.label}
              </button>
            ))}
          </div>

          {!llmConfig && <p className="settings-status">Loading connection settings...</p>}

          {llmConfig && activeType === "ApiKey" && (
            <div className="settings-grid">
              <label className="settings-field">
                <span>Provider</span>
                <select
                  value={llmConfig.apiProvider}
                  onChange={(event) => handleProviderChange(event.target.value as LlmApiProvider)}
                >
                  {apiProviders.map((provider) => (
                    <option key={provider} value={provider}>{provider}</option>
                  ))}
                </select>
              </label>
              {renderModelField("model")}
              <label className="settings-field settings-field--wide">
                <span>API Token</span>
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <input
                    type="password"
                    style={{ flex: 1 }}
                    value={llmConfig.apiKey}
                    placeholder={secretPlaceholder}
                    onChange={(event) => updateLlmConfig("apiKey", event.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => void detectFromKey()}
                    disabled={busy || !llmConfig.apiKey.trim()}
                    title="Auto-detect the provider, endpoint and models from this key"
                    style={{ whiteSpace: "nowrap", padding: "0 10px", cursor: busy ? "default" : "pointer" }}
                  >
                    🪄 Detect
                  </button>
                </div>
              </label>
              {llmConfig.apiProvider === "ZAI" && (
                <label className="settings-field settings-field--wide" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                  <input
                    type="checkbox"
                    style={{ marginTop: 3 }}
                    checked={llmConfig.customEndpoint.includes("/coding/")}
                    onChange={(event) =>
                      updateLlmConfig("customEndpoint", event.target.checked ? ZAI_CODING_ENDPOINT : "")
                    }
                  />
                  <span style={{ fontSize: 12.5 }}>
                    <strong>GLM Coding Plan</strong> — turn on only if your Z.AI key is a GLM Coding
                    Plan subscription (it uses a different endpoint). Leave off for a standard Z.AI key.
                  </span>
                </label>
              )}
              <div className="settings-field settings-field--wide">
                <button
                  type="button"
                  className="settings-advanced-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#6b7280", textAlign: "left" }}
                >
                  {showAdvanced ? "▾" : "▸"} Advanced (optional)
                </button>
              </div>
              {showAdvanced && (
                <label className="settings-field settings-field--wide">
                  <span>Custom Endpoint</span>
                  <input
                    type="text"
                    value={llmConfig.customEndpoint}
                    placeholder="Leave blank — the provider default API URL is used"
                    onChange={(event) => updateLlmConfig("customEndpoint", event.target.value)}
                  />
                  <small style={{ color: "#6b7280", marginTop: 4 }}>
                    Optional. Leave blank for a standard provider. Only set this for a
                    self-hosted or proxy server — it must be an API base URL (e.g.
                    https://api.z.ai/api/paas/v4), not a website address.
                  </small>
                </label>
              )}
            </div>
          )}

          {llmConfig && activeType === "LocalServer" && (
            <div className="settings-grid">
              <div className="settings-field settings-field--wide">
                <button
                  type="button"
                  onClick={() => void scanLocalServers()}
                  disabled={busy}
                  style={{ alignSelf: "flex-start", padding: "6px 12px", cursor: busy ? "default" : "pointer" }}
                >
                  {busy ? "Scanning…" : "🔍 Scan for local servers"}
                </button>
                <small style={{ color: "#6b7280", marginTop: 4 }}>
                  Finds Ollama, LM Studio, llama.cpp, vLLM, Jan, GPT4All, KoboldCpp and any other
                  OpenAI-compatible server running on this machine, and fills in the URL and model.
                </small>
              </div>
              <label className="settings-field settings-field--wide">
                <span>Local Server URL</span>
                <input
                  type="text"
                  value={llmConfig.localServerUrl}
                  onChange={(event) => updateLlmConfig("localServerUrl", event.target.value)}
                />
              </label>
              {renderModelField("localModelName", "Local Model")}
            </div>
          )}

          {llmConfig && activeType === "CliPipe" && (
            <div className="settings-grid">
              <label className="settings-field settings-field--wide">
                <span>CLI Command Template</span>
                <textarea
                  value={llmConfig.cliCommand}
                  onChange={(event) => updateLlmConfig("cliCommand", event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Timeout Seconds</span>
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={llmConfig.cliTimeout}
                  onChange={(event) => updateLlmConfig("cliTimeout", Number(event.target.value))}
                />
              </label>
            </div>
          )}

          {llmConfig && activeType === "OAuth" && (
            <div className="settings-grid">
              <label className="settings-field">
                <span>OAuth Provider</span>
                <select
                  value={llmConfig.oauthProvider}
                  onChange={(event) => updateLlmConfig("oauthProvider", event.target.value as LlmOAuthProvider)}
                >
                  {oauthProviders.map((provider) => (
                    <option key={provider} value={provider}>{provider}</option>
                  ))}
                </select>
              </label>
              {renderModelField("model")}
              <label className="settings-field settings-field--wide">
                <span>Client ID</span>
                <input
                  type="text"
                  value={llmConfig.oauthClientId}
                  onChange={(event) => updateLlmConfig("oauthClientId", event.target.value)}
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>API Endpoint</span>
                <input
                  type="text"
                  value={llmConfig.customEndpoint}
                  onChange={(event) => updateLlmConfig("customEndpoint", event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Auth URL</span>
                <input
                  type="text"
                  value={llmConfig.oauthAuthUrl}
                  placeholder="Provider default"
                  onChange={(event) => updateLlmConfig("oauthAuthUrl", event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Token URL</span>
                <input
                  type="text"
                  value={llmConfig.oauthTokenUrl}
                  placeholder="Provider default"
                  onChange={(event) => updateLlmConfig("oauthTokenUrl", event.target.value)}
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>Scope</span>
                <input
                  type="text"
                  value={llmConfig.oauthScope}
                  placeholder="Provider default"
                  onChange={(event) => updateLlmConfig("oauthScope", event.target.value)}
                />
              </label>
              <div className="settings-field settings-field--inline">
                <span>Token</span>
                <span className={`settings-token ${llmConfig.hasOAuthToken ? "settings-token--ok" : ""}`}>
                  {llmConfig.hasOAuthToken ? "Connected" : "Not connected"}
                </span>
              </div>
            </div>
          )}

          {llmConfig && activeType === "Terminal" && (
            <div className="settings-grid">
              <label className="settings-field settings-field--wide">
                <span>Terminal Command Template</span>
                <textarea
                  value={llmConfig.terminalCommand}
                  onChange={(event) => updateLlmConfig("terminalCommand", event.target.value)}
                />
              </label>
              <label className="settings-field settings-field--inline">
                <span>Capture Output</span>
                <input
                  type="checkbox"
                  checked={llmConfig.terminalCaptureOutput}
                  onChange={(event) => updateLlmConfig("terminalCaptureOutput", event.target.checked)}
                />
              </label>
              <label className="settings-field">
                <span>Timeout Seconds</span>
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={llmConfig.cliTimeout}
                  onChange={(event) => updateLlmConfig("cliTimeout", Number(event.target.value))}
                />
              </label>
            </div>
          )}

          {llmConfig && activeType === "LocalAI" && (
            <div className="settings-grid">
              <label className="settings-field settings-field--wide">
                <span>Local AI Runtime</span>
                <select
                  value={llmConfig.localAIRuntime}
                  onChange={(event) => updateLlmConfig("localAIRuntime", event.target.value)}
                >
                  {["Auto", "Bundled Ollama", "Ollama", "LM Studio", "llama.cpp server", "Custom"].map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label className="settings-field settings-field--wide">
                <span>Local AI Endpoint</span>
                <input
                  type="text"
                  value={llmConfig.localServerUrl}
                  onChange={(event) => updateLlmConfig("localServerUrl", event.target.value)}
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>GGUF Model Path</span>
                <input
                  type="text"
                  value={llmConfig.localAIModelPath}
                  onChange={(event) => updateLlmConfig("localAIModelPath", event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Served Model</span>
                <input
                  type="text"
                  value={llmConfig.localAIModelName}
                  onChange={(event) => updateLlmConfig("localAIModelName", event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Context Size</span>
                <input
                  type="number"
                  value={llmConfig.localAIContextSize}
                  onChange={(event) => updateLlmConfig("localAIContextSize", Number(event.target.value))}
                />
              </label>
            </div>
          )}

          {llmConfig && (
            <div className="settings-grid settings-grid--toggles">
              <label className="settings-field settings-field--inline">
                <span>Fast Mode</span>
                <input
                  type="checkbox"
                  checked={llmConfig.fastMode}
                  onChange={(event) => updateLlmConfig("fastMode", event.target.checked)}
                />
              </label>
              <label className="settings-field">
                <span>Reasoning</span>
                <select
                  value={llmConfig.reasoningEffort}
                  onChange={(event) => updateLlmConfig("reasoningEffort", event.target.value as "Low" | "Medium" | "High")}
                >
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                </select>
              </label>
              <label className="settings-field settings-field--inline">
                <span>Require First Tool</span>
                <input
                  type="checkbox"
                  checked={llmConfig.requireToolUse}
                  onChange={(event) => updateLlmConfig("requireToolUse", event.target.checked)}
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>System Prompt</span>
                <textarea
                  value={llmConfig.systemPrompt}
                  placeholder="Optional. Give the model a role or standing instructions, e.g. 'You are a senior recruiter. Be concise and explain your reasoning.'"
                  onChange={(event) => updateLlmConfig("systemPrompt", event.target.value)}
                />
              </label>
            </div>
          )}

          <div className={`settings-status settings-status--${statusKind}`}>
            {statusKind === "ok" && <CheckCircle2 size={14} />}
            {statusKind === "error" && <XCircle size={14} />}
            <span>{status}</span>
          </div>

          <div className="settings-action-row">
            <button className="settings-panel__btn-secondary" onClick={handleTest} disabled={busy || !llmConfig}>
              <Server size={14} />
              Test
            </button>
            {activeType === "OAuth" && (
              <button className="settings-panel__btn-secondary" onClick={handleOAuth} disabled={busy || !llmConfig}>
                <Link size={14} />
                Connect OAuth
              </button>
            )}
          </div>
            </section>
          )}

          {wizardOpen && (
            <SetupWizard
              initialType={llmConfig?.connectionType}
              onClose={() => setWizardOpen(false)}
              onConnected={(config) => {
                setLlmConfig(config);
                setStatus("Connected via setup wizard.");
                setStatusKind("ok");
                setWizardOpen(false);
              }}
            />
          )}

          {settingsTab === 1 && (
            <section className="settings-section">
          <div className="settings-section__heading">
            <Settings size={16} />
            <h3>Browser</h3>
          </div>
          <div className="settings-grid">
            <label className="settings-field settings-field--wide">
              <span>Homepage</span>
              <input
                type="text"
                value={localSettings.homepage}
                onChange={(event) => updateBrowserSetting("homepage", event.target.value)}
              />
            </label>
            <label className="settings-field">
              <span>Search Engine</span>
              <select
                value={localSettings.searchEngine}
                onChange={(event) => updateBrowserSetting("searchEngine", event.target.value)}
              >
                <option value="google">Google</option>
                <option value="bing">Bing</option>
                <option value="duckduckgo">DuckDuckGo</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Theme</span>
              <select
                value={localSettings.theme}
                onChange={(event) => updateBrowserSetting("theme", event.target.value)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label className="settings-field settings-field--inline">
              <span>Show Bookmark Bar</span>
              <input
                type="checkbox"
                checked={localSettings.showBookmarkBar}
                onChange={(event) => updateBrowserSetting("showBookmarkBar", event.target.checked)}
              />
            </label>
            <label className="settings-field settings-field--inline">
              <span>Clear Data on Exit</span>
              <input
                type="checkbox"
                checked={localSettings.clearDataOnExit}
                onChange={(event) => updateBrowserSetting("clearDataOnExit", event.target.checked)}
              />
            </label>
          </div>
            </section>
          )}

          {settingsTab === 2 && (
            <section className="settings-section">
          <div className="settings-section__heading">
            <ShieldCheck size={16} />
            <h3>Privacy &amp; data</h3>
          </div>
          <p className="settings-status">
            Clear what the browser stores as you browse. Your Jobomate settings, collected jobs and drafts are kept.
          </p>
          <div className="settings-grid">
            <label className="settings-field settings-field--inline">
              <span>Browsing history</span>
              <input type="checkbox" checked={clearOpts.history}
                onChange={(e) => setClearOpts((o) => ({ ...o, history: e.target.checked }))} />
            </label>
            <label className="settings-field settings-field--inline">
              <span>Cookies &amp; logins</span>
              <input type="checkbox" checked={clearOpts.cookies}
                onChange={(e) => setClearOpts((o) => ({ ...o, cookies: e.target.checked }))} />
            </label>
            <label className="settings-field settings-field--inline">
              <span>Cached files</span>
              <input type="checkbox" checked={clearOpts.cache}
                onChange={(e) => setClearOpts((o) => ({ ...o, cache: e.target.checked }))} />
            </label>
            <label className="settings-field settings-field--inline">
              <span>Site data (local storage)</span>
              <input type="checkbox" checked={clearOpts.siteData}
                onChange={(e) => setClearOpts((o) => ({ ...o, siteData: e.target.checked }))} />
            </label>
            <label className="settings-field settings-field--inline">
              <span>Download history</span>
              <input type="checkbox" checked={clearOpts.downloads}
                onChange={(e) => setClearOpts((o) => ({ ...o, downloads: e.target.checked }))} />
            </label>
            <button className="settings-panel__btn-reset" onClick={handleClearData} disabled={clearing}>
              <Trash2 size={14} />
              {clearing ? "Clearing…" : "Clear browsing data"}
            </button>
            {clearMsg && <p className="settings-status">{clearMsg}</p>}
          </div>
            </section>
          )}

          {settingsTab === 3 && (
            <section className="settings-section">
          <div className="settings-section__heading">
            <TerminalSquare size={16} />
            <h3>Bridge Server</h3>
          </div>
          <div className="settings-grid">
            <label className="settings-field settings-field--inline">
              <span>Enable Control Server</span>
              <input
                type="checkbox"
                checked={localSettings.enableLLMServer}
                onChange={(event) => updateBrowserSetting("enableLLMServer", event.target.checked)}
              />
            </label>
            <label className="settings-field">
              <span>Port</span>
              <input
                type="number"
                value={localSettings.llmServerPort}
                onChange={(event) => updateBrowserSetting("llmServerPort", parseInt(event.target.value, 10))}
                min={1024}
                max={65535}
              />
            </label>
            <label className="settings-field settings-field--inline">
              <span>Auto-start on Launch</span>
              <input
                type="checkbox"
                checked={localSettings.llmServerAutoStart}
                onChange={(event) => updateBrowserSetting("llmServerAutoStart", event.target.checked)}
              />
            </label>
          </div>
            </section>
          )}
        </div>

        <div className="settings-panel__footer">
          <button className="settings-panel__btn-reset" onClick={handleReset} disabled={busy}>
            <RotateCcw size={14} />
            Reset Browser
          </button>
          <button className="settings-panel__btn-save" onClick={handleSave} disabled={busy}>
            <Save size={14} />
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
