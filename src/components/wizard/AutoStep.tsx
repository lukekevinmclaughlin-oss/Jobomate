// "Auto" landing step of the setup wizard: on open it probes for running local
// runtimes + a bundled on-device model and offers a one-click recommended
// setup, plus a paste-a-key box that auto-detects the provider. Everything funnels
// into connectWith() (which runs a live test). Advanced reveals the 6 raw types.

import React, { useEffect, useState } from "react";
import { CheckCircle2, Cpu, KeyRound, Loader2, Server, Sparkles, Wand2, XCircle } from "lucide-react";

interface AutoStepProps {
  config: LlmConnectionConfig;
  busy: boolean;
  status: { kind: "idle" | "ok" | "error"; text: string };
  connectWith: (patch: Partial<LlmConnectionConfig>) => void;
  onAdvanced: () => void;
}

export const AutoStep: React.FC<AutoStepProps> = ({ config, busy, status, connectWith, onAdvanced }) => {
  const [scanning, setScanning] = useState(true);
  const [runtimes, setRuntimes] = useState<LocalRuntimeResult[]>([]);
  const [bundled, setBundled] = useState<BundledServerStatus | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState("");
  const [startingBundled, setStartingBundled] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setScanning(true);
      const [b, r] = await Promise.all([
        window.browserAPI?.localServer?.status().catch(() => null) ?? Promise.resolve(null),
        window.browserAPI?.llmConnection?.discoverLocal().catch(() => []) ?? Promise.resolve([]),
      ]);
      if (!alive) return;
      setBundled(b);
      setRuntimes(r || []);
      setScanning(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const useRuntime = (rt: LocalRuntimeResult) => {
    connectWith({
      connectionType: "LocalServer",
      localServerUrl: rt.chatUrl,
      localModelName: rt.models[0]?.id || "local-model",
    });
  };

  const startBundledAndUse = async () => {
    setStartingBundled(true);
    try {
      const s = await window.browserAPI?.localServer?.start({ contextSize: config.localAIContextSize || 4096 });
      if (s?.running && s.baseUrl) {
        connectWith({
          connectionType: "LocalServer",
          localServerUrl: `${s.baseUrl}/v1/chat/completions`,
          localModelName: config.localAIModelName || "local-model",
        });
      } else {
        setProbeMsg(s?.reason || "Could not start the bundled model.");
      }
    } finally {
      setStartingBundled(false);
    }
  };

  const detectAndConnect = async () => {
    const key = keyVal.trim();
    if (!key) {
      setProbeMsg("Paste an API key first.");
      return;
    }
    setProbing(true);
    setProbeMsg("Detecting provider and models…");
    try {
      const res = await window.browserAPI?.llmConnection?.probeApiKey({ apiKey: key });
      if (res?.ok && res.provider) {
        setProbeMsg(`Detected ${res.provider} — connecting…`);
        connectWith({
          connectionType: "ApiKey",
          apiKey: key,
          apiProvider: res.provider as LlmApiProvider,
          model: res.recommendedModel || config.model,
          customEndpoint: res.endpoint || config.customEndpoint,
          reasoningEffort: res.capabilities?.defaultReasoningEffort || config.reasoningEffort,
        });
      } else {
        setProbeMsg(res?.message || "Couldn't detect this key — try Advanced.");
      }
    } catch (e) {
      setProbeMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="wizard-body">
      <p className="wizard-intro">
        <Sparkles size={14} /> We'll set this up for you. {scanning ? "Looking for a model…" : "Pick the recommended option, or paste a key."}
      </p>

      {scanning && (
        <div className="wizard-scan">
          <Loader2 size={16} className="spin" /> Scanning for local AI runtimes…
        </div>
      )}

      {/* Detected running runtimes */}
      {!scanning &&
        runtimes.map((rt) => (
          <div className="auto-card auto-card--recommended" key={rt.runtime}>
            <div className="auto-card__icon"><Server size={18} /></div>
            <div className="auto-card__body">
              <strong>Local model ready — {rt.runtime}</strong>
              <span>
                {rt.models.length > 0
                  ? `${rt.models[0].id}${rt.models.length > 1 ? ` +${rt.models.length - 1} more` : ""}`
                  : "running on this machine"}
              </span>
            </div>
            <button className="wizard-finish" onClick={() => useRuntime(rt)} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />} Use this
            </button>
          </div>
        ))}

      {/* Bundled on-device model when nothing is already running */}
      {!scanning && runtimes.length === 0 && bundled?.available && (
        <div className="auto-card auto-card--recommended">
          <div className="auto-card__icon"><Cpu size={18} /></div>
          <div className="auto-card__body">
            <strong>Bundled on-device model</strong>
            <span>Runs fully offline. We'll start it and connect.</span>
          </div>
          <button className="wizard-finish" onClick={startBundledAndUse} disabled={busy || startingBundled}>
            {startingBundled ? <Loader2 size={14} className="spin" /> : <Cpu size={14} />} Start &amp; use
          </button>
        </div>
      )}

      {/* Paste-a-key (always available) */}
      <div className="auto-card">
        <div className="auto-card__icon"><KeyRound size={18} /></div>
        <div className="auto-card__body auto-card__body--full">
          <strong>Use a cloud model</strong>
          <span>Paste an API key — we detect the provider, endpoint and models automatically.</span>
          <div className="wizard-row">
            <input
              type="password"
              value={keyVal}
              onChange={(e) => setKeyVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") detectAndConnect();
              }}
              placeholder="sk-…, gsk_…, AIza…, or any provider key"
            />
            <button className="wizard-detect" onClick={detectAndConnect} disabled={probing || busy || !keyVal.trim()}>
              {probing ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
              {probing ? "Detecting…" : "Detect & connect"}
            </button>
          </div>
          {probeMsg && <small className="wizard-field__hint">{probeMsg}</small>}
        </div>
      </div>

      {(status.text || busy) && (
        <div className={`wizard-status wizard-status--${status.kind}`}>
          {status.kind === "ok" && <CheckCircle2 size={14} />}
          {status.kind === "error" && <XCircle size={14} />}
          {busy && status.kind === "idle" && <Loader2 size={14} className="spin" />}
          <span>{status.text}</span>
        </div>
      )}

      <button className="auto-advanced" onClick={onAdvanced}>
        Advanced / more options →
      </button>
    </div>
  );
};
