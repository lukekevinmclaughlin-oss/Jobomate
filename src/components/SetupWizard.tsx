// Guided, plug-and-play setup wizard for every LLM connection type.
// Each type (API Key, Local Server, CLI Pipe, OAuth, Terminal, Local AI) gets
// its own minimal step flow that ends with a live connection test. Designed so
// a non-technical user can reach a working connection without editing JSON or
// knowing provider endpoints/model ids.

import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Cpu,
  FlaskConical,
  FolderOpen,
  KeyRound,
  Loader2,
  PlugZap,
  Server,
  Sparkles,
  TerminalSquare,
  Wand2,
  X,
  XCircle,
} from "lucide-react";
import { AutoStep } from "./wizard/AutoStep";

export interface SetupWizardProps {
  initialType?: LlmConnectionType;
  onClose: () => void;
  onConnected: (config: LlmConnectionConfig) => void;
}

const TYPES: Array<{
  value: LlmConnectionType;
  label: string;
  blurb: string;
  Icon: React.ComponentType<{ size?: number | string }>;
}> = [
  { value: "ApiKey", label: "API Key", blurb: "OpenAI, Anthropic, Z.ai, Groq, and 25+ more. Paste a key and we detect the rest.", Icon: KeyRound },
  { value: "LocalServer", label: "Local Server", blurb: "An OpenAI-compatible server you already run (Ollama, LM Studio, llama.cpp).", Icon: Server },
  { value: "CliPipe", label: "CLI Pipe", blurb: "Pipe prompts to a local CLI (e.g. ollama run llama3).", Icon: TerminalSquare },
  { value: "OAuth", label: "OAuth", blurb: "Sign in with a provider that supports OAuth (Vertex, Azure, Hugging Face).", Icon: PlugZap },
  { value: "Terminal", label: "Terminal", blurb: "Run a shell command per turn and feed its output to the agent.", Icon: TerminalSquare },
  { value: "LocalAI", label: "Local AI", blurb: "Bundled llama.cpp: pick a GGUF model and we serve it for you.", Icon: Cpu },
];

const REASONING_OPTIONS: Array<{
  value: LlmConnectionConfig["reasoningEffort"];
  label: string;
}> = [
  { value: "Low", label: "Low · fastest" },
  { value: "Medium", label: "Medium · balanced" },
  { value: "High", label: "High · deep" },
  { value: "Extra", label: "Extra · deeper" },
  { value: "Max", label: "Max · deepest" },
  { value: "ExtraMax", label: "Extra Max · maximum" },
];

export const SetupWizard: React.FC<SetupWizardProps> = ({ initialType, onClose, onConnected }) => {
  const [config, setConfig] = useState<LlmConnectionConfig | null>(null);
  const [chosenType, setChosenType] = useState<LlmConnectionType | null>(initialType ?? null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectedModels, setDetectedModels] = useState<DetectedModel[]>([]);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({ kind: "idle", text: "" });

  // Load current config on open so the wizard edits real state.
  useEffect(() => {
    window.browserAPI?.llmConnection.getConfig().then((c) => {
      setConfig(c);
      if (initialType) updateField("connectionType", initialType);
    }).catch(() => undefined);
  }, []);

  const updateField = <K extends keyof LlmConnectionConfig>(key: K, value: LlmConnectionConfig[K]) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  // ── API Key autodetect (shared helper) ─────────────────────────────────────
  const autodetect = async () => {
    if (!config?.apiKey) {
      setStatus({ kind: "error", text: "Paste your API key first." });
      return;
    }
    setDetecting(true);
    setStatus({ kind: "idle", text: "Detecting provider and models…" });
    try {
      const res = await window.browserAPI?.llmConnection.probeApiKey({
        apiKey: config.apiKey,
        provider: config.apiProvider === "Custom" ? undefined : config.apiProvider,
        endpoint: config.customEndpoint || undefined,
      });
      setDetectedModels(res?.models || []);
      if (res?.ok && res.provider) {
        updateField("apiProvider", res.provider as LlmApiProvider);
        if (res.recommendedModel) updateField("model", res.recommendedModel);
        if (res.endpoint && res.endpoint !== config.customEndpoint) updateField("customEndpoint", res.endpoint);
        if (res.capabilities?.defaultReasoningEffort) updateField("reasoningEffort", res.capabilities.defaultReasoningEffort);
        setStatus({ kind: "ok", text: res.message });
      } else {
        setStatus({ kind: "error", text: res?.message || "Couldn't detect this key." });
      }
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDetecting(false);
    }
  };

  // ── Final step: save + connect (runs a live test) ──────────────────────────
  const finish = () => connectWith({});

  // Merge a patch into config, persist + run the live connection test. Used by
  // the manual "Test & connect" footer and the AutoStep one-click flows.
  const connectWith = async (patch: Partial<LlmConnectionConfig>) => {
    if (!config) return;
    const merged = { ...config, ...patch };
    setConfig(merged);
    setBusy(true);
    setStatus({ kind: "idle", text: "Testing the connection…" });
    try {
      const result = await window.browserAPI?.llmConnection.connect(merged);
      if (result?.ok) {
        setStatus({ kind: "ok", text: `Connected. ${result.message}` });
        setTimeout(() => onConnected(result.config), 600);
      } else {
        setStatus({ kind: "error", text: result?.message || "Connection test failed." });
      }
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return (
      <div className="wizard-overlay">
        <div className="wizard-modal"><Loader2 className="spin" size={20} /></div>
      </div>
    );
  }

  return (
    <div className="wizard-overlay" onClick={onClose}>
      <div className="wizard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wizard-modal__header">
          {(chosenType || advanced) && (
            <button
              className="wizard-back"
              onClick={() => {
                if (chosenType) setChosenType(null);
                else setAdvanced(false);
                setStatus({ kind: "idle", text: "" });
              }}
              title="Back"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <Sparkles size={16} />
          <h2>{chosenType ? `${TYPES.find((t) => t.value === chosenType)?.label} setup` : "Set up your LLM"}</h2>
          <button className="wizard-close" onClick={onClose} title="Close"><X size={16} /></button>
        </div>

        {!chosenType && !advanced && (
          <AutoStep
            config={config}
            busy={busy}
            status={status}
            connectWith={connectWith}
            onAdvanced={() => { setAdvanced(true); setStatus({ kind: "idle", text: "" }); }}
          />
        )}

        {!chosenType && advanced && (
          <div className="wizard-body">
            <p className="wizard-intro">Pick how you want to connect. We'll guide you the rest of the way.</p>
            <div className="wizard-type-grid">
              {TYPES.map((t) => (
                <button key={t.value} className="wizard-type-card" onClick={() => { setChosenType(t.value); updateField("connectionType", t.value); }}>
                  <t.Icon size={20} />
                  <strong>{t.label}</strong>
                  <span>{t.blurb}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {chosenType === "ApiKey" && (
          <ApiKeySteps
            config={config}
            detectedModels={detectedModels}
            detecting={detecting}
            status={status}
            updateField={updateField}
            onAutodetect={autodetect}
          />
        )}
        {chosenType === "LocalServer" && <LocalServerSteps config={config} updateField={updateField} />}
        {chosenType === "CliPipe" && <CliSteps config={config} updateField={updateField} mode="cli" />}
        {chosenType === "Terminal" && <CliSteps config={config} updateField={updateField} mode="terminal" />}
        {chosenType === "OAuth" && <OAuthSteps config={config} updateField={updateField} />}
        {chosenType === "LocalAI" && <LocalAISteps config={config} updateField={updateField} />}

        {chosenType && (
          <div className="wizard-modal__footer">
            {status.text && (
              <div className={`wizard-status wizard-status--${status.kind}`}>
                {status.kind === "ok" && <CheckCircle2 size={14} />}
                {status.kind === "error" && <XCircle size={14} />}
                <span>{status.text}</span>
              </div>
            )}
            <button className="wizard-finish" onClick={finish} disabled={busy}>
              {busy ? <Loader2 size={15} className="spin" /> : <PlugZap size={15} />}
              Test &amp; connect
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Shared field primitives ──────────────────────────────────────────────────
const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="wizard-field">
    <span>{label}</span>
    {children}
    {hint && <small className="wizard-field__hint">{hint}</small>}
  </label>
);

// ── API Key steps ────────────────────────────────────────────────────────────
const ApiKeySteps: React.FC<{
  config: LlmConnectionConfig;
  detectedModels: DetectedModel[];
  detecting: boolean;
  status: { kind: "idle" | "ok" | "error"; text: string };
  updateField: <K extends keyof LlmConnectionConfig>(key: K, value: LlmConnectionConfig[K]) => void;
  onAutodetect: () => void;
}> = ({ config, detectedModels, detecting, updateField, onAutodetect }) => {
  const providers: LlmApiProvider[] = [
    "OpenAI", "Anthropic", "Groq", "OpenRouter", "DeepSeek", "Together", "Mistral",
    "XAI", "GoogleAI", "AzureOpenAI", "Perplexity", "Fireworks", "HuggingFace", "Novita",
    "ZAI", "PPIO", "ApiPie", "MoonshotAI", "CometAPI", "GiteeAI", "SambaNova", "Custom",
  ];
  return (
    <div className="wizard-body">
      <p className="wizard-intro">Paste your API key and click <strong>Auto-detect</strong> — we'll figure out the provider, endpoint, and available models for you.</p>
      <Field label="API key">
        <div className="wizard-row">
          <input type="password" value={config.apiKey} onChange={(e) => updateField("apiKey", e.target.value)} placeholder="sk-… or your provider key" />
          <button className="wizard-detect" onClick={onAutodetect} disabled={detecting || !config.apiKey}>
            {detecting ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
            {detecting ? "Detecting…" : "Auto-detect"}
          </button>
        </div>
      </Field>
      <Field label="Provider" hint="Auto-filled by detection, but you can override.">
        <select value={config.apiProvider} onChange={(e) => updateField("apiProvider", e.target.value as LlmApiProvider)}>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>
      <Field label="Model" hint={detectedModels.length > 0 ? `${detectedModels.length} models detected — pick one.` : "Detected automatically, or type a model id."}>
        {detectedModels.length > 0 ? (
          <select value={config.model} onChange={(e) => updateField("model", e.target.value)}>
            {detectedModels
              .slice()
              .sort((a, b) => (a.tier === "flagship" ? -1 : b.tier === "flagship" ? 1 : 0) || a.id.localeCompare(b.id))
              .map((m) => <option key={m.id} value={m.id}>{m.id}{m.tier ? ` (${m.tier})` : ""}</option>)}
          </select>
        ) : (
          <input type="text" value={config.model} onChange={(e) => updateField("model", e.target.value)} placeholder="e.g. gpt-4o, glm-5.2, claude-opus-4" />
        )}
      </Field>
      <Field label="Reasoning effort" hint="Higher = more thorough, slower. Only used by reasoning-capable models.">
        <select value={config.reasoningEffort} onChange={(e) => updateField("reasoningEffort", e.target.value as LlmConnectionConfig["reasoningEffort"])}>
          {REASONING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="Custom endpoint" hint="Leave blank unless detection tells you otherwise (e.g. a Zhipu/China endpoint).">
        <input type="text" value={config.customEndpoint} onChange={(e) => updateField("customEndpoint", e.target.value)} placeholder="Provider default" />
      </Field>
    </div>
  );
};

// ── Local Server steps (Ollama / LM Studio / llama.cpp) ──────────────────────
const LocalServerSteps: React.FC<{
  config: LlmConnectionConfig;
  updateField: <K extends keyof LlmConnectionConfig>(key: K, value: LlmConnectionConfig[K]) => void;
}> = ({ config, updateField }) => {
  const presets = [
    { label: "Ollama (default)", url: "http://localhost:11434/v1/chat/completions", model: "llama3" },
    { label: "LM Studio", url: "http://localhost:1234/v1/chat/completions", model: "local-model" },
    { label: "llama.cpp server", url: "http://localhost:8080/v1/chat/completions", model: "local-model" },
  ];
  const [detected, setDetected] = useState<LocalRuntimeResult[]>([]);
  const [models, setModels] = useState<DetectedModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    window.browserAPI?.llmConnection?.discoverLocal().then(setDetected).catch(() => setDetected([]));
  }, []);

  const loadModels = async () => {
    if (!config.localServerUrl) return;
    setLoadingModels(true);
    try {
      const r = await window.browserAPI?.llmConnection?.listModels({ url: config.localServerUrl });
      setModels(r?.models || []);
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <div className="wizard-body">
      <p className="wizard-intro">Point Jobomate at an OpenAI-compatible server you already run.</p>
      {detected.length > 0 && (
        <Field label="Detected on this machine" hint="Tap to use a running runtime.">
          <div className="wizard-presets">
            {detected.map((rt) => (
              <button
                key={rt.runtime}
                type="button"
                className="wizard-preset wizard-preset--ok"
                onClick={() => {
                  updateField("localServerUrl", rt.chatUrl);
                  updateField("localModelName", rt.models[0]?.id || "local-model");
                  setModels(rt.models);
                }}
              >
                {rt.runtime}
                {rt.models.length ? ` (${rt.models.length})` : ""}
              </button>
            ))}
          </div>
        </Field>
      )}
      <Field label="Quick pick">
        <div className="wizard-presets">
          {presets.map((p) => (
            <button key={p.label} type="button" className="wizard-preset"
              onClick={() => { updateField("localServerUrl", p.url); updateField("localModelName", p.model); }}>
              {p.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Server URL" hint="The /v1/chat/completions (or /v1) endpoint.">
        <div className="wizard-row">
          <input type="text" value={config.localServerUrl} onChange={(e) => updateField("localServerUrl", e.target.value)} />
          <button className="wizard-detect" onClick={loadModels} disabled={loadingModels || !config.localServerUrl}>
            {loadingModels ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} List models
          </button>
        </div>
      </Field>
      <Field label="Model name" hint={models.length > 0 ? `${models.length} model(s) found — pick one.` : "As the server reports it (e.g. llama3, qwen2.5)."}>
        {models.length > 0 ? (
          <select value={config.localModelName} onChange={(e) => updateField("localModelName", e.target.value)}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        ) : (
          <input type="text" value={config.localModelName} onChange={(e) => updateField("localModelName", e.target.value)} />
        )}
      </Field>
    </div>
  );
};

// ── CLI / Terminal steps ─────────────────────────────────────────────────────
const CliSteps: React.FC<{
  config: LlmConnectionConfig;
  updateField: <K extends keyof LlmConnectionConfig>(key: K, value: LlmConnectionConfig[K]) => void;
  mode: "cli" | "terminal";
}> = ({ config, updateField, mode }) => {
  const isCli = mode === "cli";
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState<{ ok: boolean; text: string } | null>(null);
  const runTest = async () => {
    const command = isCli ? config.cliCommand : config.terminalCommand;
    if (!command?.trim()) {
      setTestOut({ ok: false, text: "Enter a command first." });
      return;
    }
    setTesting(true);
    setTestOut(null);
    try {
      const r = await window.browserAPI?.llmConnection?.testCli({ command, timeout: config.cliTimeout });
      setTestOut({ ok: Boolean(r?.ok), text: r?.ok ? r.output || "(ran, no output)" : r?.message || "Command failed." });
    } finally {
      setTesting(false);
    }
  };
  const presets = isCli
    ? [
        'ollama run llama3 "{prompt}"',
        'llama-cli -m /path/to/model.gguf -p "{prompt}"',
      ]
    : [
        "echo '{prompt}' | your-script.sh",
      ];
  return (
    <div className="wizard-body">
      <p className="wizard-intro">
        {isCli
          ? "Each turn runs your command with {prompt} replaced by the user's message. The stdout becomes the reply."
          : "Each turn runs a shell command. Its stdout is shown to the agent as the turn's result."}
      </p>
      <Field label="Command template" hint="Use {prompt} where the user's text should go.">
        <textarea value={isCli ? config.cliCommand : config.terminalCommand}
          onChange={(e) => updateField(isCli ? "cliCommand" : "terminalCommand", e.target.value)}
          placeholder={presets[0]} />
      </Field>
      {isCli && (
        <Field label="Timeout (seconds)">
          <input type="number" min={1} max={600} value={config.cliTimeout}
            onChange={(e) => updateField("cliTimeout", Number(e.target.value))} />
        </Field>
      )}
      <Field label="Examples">
        <div className="wizard-presets">
          {presets.map((p) => (
            <button key={p} type="button" className="wizard-preset"
              onClick={() => updateField(isCli ? "cliCommand" : "terminalCommand", p)}>{p}</button>
          ))}
        </div>
      </Field>
      <Field label="Try it first" hint="Runs your command once with a sample prompt.">
        <button className="wizard-detect" onClick={runTest} disabled={testing}>
          {testing ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} Test command
        </button>
      </Field>
      {testOut && (
        <pre className={`wizard-test-output${testOut.ok ? "" : " wizard-test-output--error"}`}>{testOut.text}</pre>
      )}
    </div>
  );
};

// ── OAuth steps ──────────────────────────────────────────────────────────────
const OAuthSteps: React.FC<{
  config: LlmConnectionConfig;
  updateField: <K extends keyof LlmConnectionConfig>(key: K, value: LlmConnectionConfig[K]) => void;
}> = ({ config, updateField }) => {
  const OAUTH_PRESETS: Record<string, { provider: LlmOAuthProvider; authUrl: string; tokenUrl: string; scope: string; model: string }> = {
    "Google Vertex": { provider: "GoogleVertex", authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/cloud-platform", model: "gemini-2.5-pro" },
    Azure: { provider: "Azure", authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token", scope: "https://cognitiveservices.azure.com/.default", model: "gpt-4o" },
    "Hugging Face": { provider: "HuggingFace", authUrl: "https://huggingface.co/oauth/authorize", tokenUrl: "https://huggingface.co/oauth/token", scope: "openid profile inference-api", model: "" },
  };
  const applyPreset = (p: (typeof OAUTH_PRESETS)[string]) => {
    updateField("oauthProvider", p.provider);
    updateField("oauthAuthUrl", p.authUrl);
    updateField("oauthTokenUrl", p.tokenUrl);
    updateField("oauthScope", p.scope);
    if (p.model) updateField("model", p.model);
  };
  return (
  <div className="wizard-body">
    <p className="wizard-intro">Pick a provider to auto-fill its OAuth URLs, add your Client ID, then use <strong>Test &amp; connect</strong> to sign in.</p>
    <Field label="Quick fill" hint="Fills the auth/token/scope URLs for you.">
      <div className="wizard-presets">
        {Object.entries(OAUTH_PRESETS).map(([label, p]) => (
          <button key={label} type="button" className="wizard-preset" onClick={() => applyPreset(p)}>{label}</button>
        ))}
      </div>
    </Field>
    <Field label="Provider">
      <select value={config.oauthProvider} onChange={(e) => updateField("oauthProvider", e.target.value as LlmOAuthProvider)}>
        <option value="GoogleVertex">Google Vertex AI</option>
        <option value="Azure">Azure OpenAI</option>
        <option value="HuggingFace">Hugging Face</option>
        <option value="Custom">Custom</option>
      </select>
    </Field>
    <Field label="OAuth Client ID" hint="From your provider's developer console.">
      <input type="text" value={config.oauthClientId} onChange={(e) => updateField("oauthClientId", e.target.value)} />
    </Field>
    <Field label="Model">
      <input type="text" value={config.model} onChange={(e) => updateField("model", e.target.value)} placeholder="e.g. gemini-2.5-pro" />
    </Field>
    <Field label="Endpoint" hint="The OpenAI-compatible chat completions URL your provider token works against.">
      <input type="text" value={config.customEndpoint} onChange={(e) => updateField("customEndpoint", e.target.value)} placeholder="https://…/v1/chat/completions" />
    </Field>
    <p className="wizard-note">After clicking <strong>Test &amp; connect</strong>, a browser window opens to complete sign-in.</p>
  </div>
  );
};

// ── Local AI (bundled llama.cpp) steps ───────────────────────────────────────
const LocalAISteps: React.FC<{
  config: LlmConnectionConfig;
  updateField: <K extends keyof LlmConnectionConfig>(key: K, value: LlmConnectionConfig[K]) => void;
}> = ({ config, updateField }) => {
  const [bundled, setBundled] = useState<BundledServerStatus | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [models, setModels] = useState<DetectedModel[]>([]);
  useEffect(() => {
    window.browserAPI?.localServer?.status().then(setBundled).catch(() => setBundled(null));
  }, []);
  const browse = async () => {
    const r = await window.browserAPI?.dialog?.openFile();
    if (r && !r.canceled && r.path) {
      updateField("localAIModelPath", r.path);
      if (!config.localAIModelName) {
        updateField("localAIModelName", r.path.split("/").pop()?.replace(/\.gguf$/i, "") || "");
      }
    }
  };
  const start = async () => {
    setStartBusy(true);
    try {
      const s = await window.browserAPI?.localServer?.start({
        contextSize: config.localAIContextSize,
        modelPath: config.localAIModelPath || undefined,
      });
      if (s) {
        setBundled(s);
        if (s.running && s.baseUrl) {
          updateField("localServerUrl", `${s.baseUrl}/v1/chat/completions`);
          const r = await window.browserAPI?.llmConnection
            ?.listModels({ url: `${s.baseUrl}/v1/chat/completions` })
            .catch(() => null);
          if (r?.models?.length) {
            setModels(r.models);
            if (!config.localAIModelName) updateField("localAIModelName", r.models[0].id);
          }
        }
      }
    } finally {
      setStartBusy(false);
    }
  };
  return (
    <div className="wizard-body">
      <p className="wizard-intro">Run a model fully on-device. Jobomate spawns a bundled <code>llama-server</code> from a GGUF file.</p>
      <Field label="GGUF model path" hint="Pick a .gguf file (download one from Hugging Face if you don't have one).">
        <div className="wizard-row">
          <input type="text" value={config.localAIModelPath} onChange={(e) => updateField("localAIModelPath", e.target.value)} placeholder="/Users/you/Models/llama-3-8b.gguf" />
          <button className="wizard-detect" onClick={browse}><FolderOpen size={14} /> Browse</button>
        </div>
      </Field>
      <Field label="Served model name" hint={models.length > 0 ? `${models.length} model(s) served — pick one.` : "Any label; defaults to the file name."}>
        {models.length > 0 ? (
          <select value={config.localAIModelName} onChange={(e) => updateField("localAIModelName", e.target.value)}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        ) : (
          <input type="text" value={config.localAIModelName} onChange={(e) => updateField("localAIModelName", e.target.value)} />
        )}
      </Field>
      <Field label="Context size">
        <input type="number" min={512} step={512} value={config.localAIContextSize}
          onChange={(e) => updateField("localAIContextSize", Number(e.target.value))} />
      </Field>
      <div className="wizard-bundled">
        {bundled?.running ? (
          <span className="wizard-bundled__ok"><CheckCircle2 size={14} /> Local server running at {bundled.baseUrl}</span>
        ) : bundled?.available ? (
          <button className="wizard-finish" onClick={start} disabled={startBusy}>
            {startBusy ? <Loader2 size={14} className="spin" /> : <Server size={14} />} Start local server
          </button>
        ) : (
          <span className="wizard-bundled__note">No bundled runtime found. You can still point Local Server at one you run yourself.</span>
        )}
      </div>
    </div>
  );
};
