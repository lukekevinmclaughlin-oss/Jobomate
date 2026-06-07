import React, { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { useHistoryStore } from "../stores/historyStore";
import { useDownloadStore } from "../stores/downloadStore";
import logoWebp from "../assets/logo.webp";
import logoPng from "../assets/logo.png";
import {
  CheckCircle2,
  KeyRound,
  Link,
  PlugZap,
  RotateCcw,
  Save,
  Server,
  Settings,
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

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ onClose }) => {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const clearHistory = useHistoryStore((s) => s.clearHistory);
  const clearDownloads = useDownloadStore((s) => s.clearCompleted);
  const [localSettings, setLocalSettings] = useState({ ...settings });
  const [llmConfig, setLlmConfig] = useState<LlmConnectionConfig | null>(null);
  const [status, setStatus] = useState("Settings ready.");
  const [statusKind, setStatusKind] = useState<"idle" | "ok" | "error">("idle");
  const [busy, setBusy] = useState(false);

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
    <div className="settings-panel">
      <div className="settings-panel__header">
        <div className="settings-panel__brand">
          <picture>
            <source srcSet={logoWebp} type="image/webp" />
            <img src={logoPng} alt="Jobomate logo" width="28" height="28" />
          </picture>
          <h2 className="settings-panel__title">Jobomate Settings</h2>
        </div>
        <button className="settings-panel__close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="settings-panel__content">
        <section className="settings-section settings-section--connection">
          <div className="settings-section__heading">
            <PlugZap size={16} />
            <h3>LLM Connection</h3>
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
              <label className="settings-field">
                <span>Model</span>
                <input
                  type="text"
                  value={llmConfig.model}
                  onChange={(event) => updateLlmConfig("model", event.target.value)}
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>API Token</span>
                <input
                  type="password"
                  value={llmConfig.apiKey}
                  placeholder={secretPlaceholder}
                  onChange={(event) => updateLlmConfig("apiKey", event.target.value)}
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>Custom Endpoint</span>
                <input
                  type="text"
                  value={llmConfig.customEndpoint}
                  placeholder="Provider default"
                  onChange={(event) => updateLlmConfig("customEndpoint", event.target.value)}
                />
              </label>
            </div>
          )}

          {llmConfig && activeType === "LocalServer" && (
            <div className="settings-grid">
              <label className="settings-field settings-field--wide">
                <span>Local Server URL</span>
                <input
                  type="text"
                  value={llmConfig.localServerUrl}
                  onChange={(event) => updateLlmConfig("localServerUrl", event.target.value)}
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>Local Model</span>
                <input
                  type="text"
                  value={llmConfig.localModelName}
                  onChange={(event) => updateLlmConfig("localModelName", event.target.value)}
                />
              </label>
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
              <label className="settings-field">
                <span>Model</span>
                <input
                  type="text"
                  value={llmConfig.model}
                  onChange={(event) => updateLlmConfig("model", event.target.value)}
                />
              </label>
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
                <option value="system">System</option>
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
  );
};
