import React, { useCallback, useEffect, useRef, useState } from "react";
import { Send, Bot, UserRound, Briefcase, Building2, FileText, CheckCircle2, Mail, Play, Loader2 } from "lucide-react";
import { engine, EngineStatus, JobRow, DraftRow } from "./api";

interface Msg { id: string; role: "user" | "assistant" | "system"; content: string; }

const uid = () => Math.random().toString(36).slice(2);

export const JobomatePanel: React.FC = () => {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [engineUp, setEngineUp] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"jobs" | "drafts">("jobs");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    try { const s = await engine.status(); setStatus(s); setEngineUp(true); }
    catch { setEngineUp(false); }
  }, []);

  const refreshData = useCallback(async () => {
    try { setJobs(await engine.jobs()); } catch { /* ignore */ }
    try { setDrafts(await engine.drafts()); } catch { /* ignore */ }
  }, []);

  // Poll the engine until it's up, then keep status fresh.
  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 4000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  useEffect(() => { if (engineUp) refreshData(); }, [engineUp, refreshData]);
  useEffect(() => { listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [messages]);

  const say = (role: Msg["role"], content: string) => setMessages((m) => [...m, { id: uid(), role, content }]);

  const runAction = useCallback(async (action: string) => {
    switch (action) {
      case "research":
        setBusy("Researching jobs in the browser…");
        try { const r = await engine.research("jobs"); say("system", `Collected ${r.jobs ?? 0} job postings.`); } catch (e: any) { say("system", "Research failed: " + e.message); }
        await refreshData(); setTab("jobs"); break;
      case "companies":
        setBusy("Researching companies in the browser…");
        try { const r = await engine.research("companies"); say("system", `Collected ${r.companies ?? 0} companies.`); } catch (e: any) { say("system", "Research failed: " + e.message); }
        await refreshData(); break;
      case "list":
        await refreshData(); setTab("jobs"); say("system", `${jobs.length} postings collected — see the Jobs tab below.`); break;
      case "draft":
        setBusy("Drafting tailored applications…");
        try { const r = await engine.draft("job"); say("system", `Drafted ${r.drafted ?? 0} applications. Review them in the Drafts tab.`); } catch (e: any) { say("system", "Draft failed: " + e.message); }
        await refreshData(); setTab("drafts"); break;
      case "approve":
        setBusy("Approving drafts…");
        try { const r = await engine.approve(); say("system", `Approved ${r.approved ?? 0} drafts.`); } catch (e: any) { say("system", e.message); }
        await refreshData(); break;
      case "prepare":
        setBusy("Opening Gmail — sign in if asked, then I'll create drafts…");
        try { await engine.prepareEmails(); const r = await engine.createDrafts(); say("system", r.error ? `Couldn't create drafts: ${r.error}` : `Created ${r.created ?? 0} Gmail drafts.`); } catch (e: any) { say("system", e.message); }
        break;
      case "send":
        setBusy("Sending due items…");
        try { const r = await engine.send(); say("system", `${r.sent ?? 0} sent${r.dryRun ? " (dry-run)" : ""}. ${r.message ?? ""}`); } catch (e: any) { say("system", e.message); }
        await refreshStatus(); break;
      case "settings":
        say("system", "Open Settings (top-right gear) to connect a model or email account."); break;
    }
    setBusy(null);
    await refreshStatus();
  }, [jobs.length, refreshData, refreshStatus]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt("");
    say("user", text);
    setBusy("Thinking…");
    try {
      const r = await engine.chat(text);
      if (r.text) say("assistant", r.text);
      setBusy(null);
      for (const a of r.actions || []) await runAction(a);
    } catch (e: any) {
      say("system", "Engine error: " + e.message);
      setBusy(null);
    }
  }, [prompt, busy, runAction]);

  const quick = async (action: string) => { if (!busy) await runAction(action); };

  return (
    <section className="jbm">
      <header className="jbm__head">
        <div className="jbm__brand"><Bot size={16} /> <span>Jobomate</span></div>
        <div className="jbm__status">
          {!engineUp ? <span className="jbm__dot jbm__dot--off" /> : <span className={`jbm__dot ${status?.connected ? "jbm__dot--on" : "jbm__dot--warn"}`} />}
          <span className="jbm__statusText">
            {!engineUp ? "Starting engine…" : status?.connected ? status?.model || "connected" : "Connect a model (Settings)"}
          </span>
          {status?.dryRun && <span className="jbm__badge">dry-run</span>}
        </div>
      </header>

      {status?.needsUser && (
        <div className="jbm__needsUser">
          <span>Action needed in the browser: {status.needsUser}</span>
          <button onClick={async () => { await engine.resumeBrowser(); await refreshStatus(); }}>Resume — I've handled it</button>
        </div>
      )}

      <div className="jbm__actions">
        <button onClick={() => quick("research")} disabled={!!busy}><Briefcase size={14} /> Recent jobs</button>
        <button onClick={() => quick("companies")} disabled={!!busy}><Building2 size={14} /> Companies</button>
        <button onClick={() => quick("draft")} disabled={!!busy}><FileText size={14} /> Draft</button>
        <button onClick={() => quick("approve")} disabled={!!busy}><CheckCircle2 size={14} /> Approve</button>
        <button onClick={() => quick("prepare")} disabled={!!busy}><Mail size={14} /> Prepare emails</button>
        <button onClick={() => quick("send")} disabled={!!busy}><Play size={14} /> Send</button>
      </div>

      <div ref={listRef} className="jbm__messages">
        {messages.length === 0 && (
          <div className="jbm__empty">
            <p><strong>{status?.profileName ? `Hi ${status.profileName.split(" ")[0]} —` : "Welcome —"}</strong> I run your job hunt in this browser.</p>
            <p>Ask me anything, or use the buttons above: collect jobs → draft tailored applications → put them in your Gmail.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`jbm__msg jbm__msg--${m.role}`}>
            <div className="jbm__msgIcon">{m.role === "user" ? <UserRound size={14} /> : <Bot size={14} />}</div>
            <div className="jbm__msgBody">{m.content}</div>
          </div>
        ))}
        {busy && <div className="jbm__busy"><Loader2 size={14} className="jbm__spin" /> {busy}</div>}
      </div>

      <div className="jbm__results">
        <div className="jbm__tabs">
          <button className={tab === "jobs" ? "on" : ""} onClick={() => setTab("jobs")}>Jobs ({jobs.length})</button>
          <button className={tab === "drafts" ? "on" : ""} onClick={() => setTab("drafts")}>Drafts ({drafts.length})</button>
        </div>
        <div className="jbm__resultList">
          {tab === "jobs" && jobs.slice(0, 40).map((j) => (
            <div key={j.id} className="jbm__job">
              <div className="jbm__jobTitle">{j.title}</div>
              <div className="jbm__jobMeta">{[j.company, j.location].filter(Boolean).join(" · ")}</div>
            </div>
          ))}
          {tab === "jobs" && jobs.length === 0 && <div className="jbm__none">No postings yet — hit “Recent jobs”.</div>}
          {tab === "drafts" && drafts.map((d) => (
            <div key={d.id} className="jbm__job">
              <div className="jbm__jobTitle">{d.role} <span className={`jbm__pill jbm__pill--${d.status.toLowerCase()}`}>{d.status}</span></div>
              <div className="jbm__jobMeta">{d.company}{d.to ? ` · ${d.to}` : ""}</div>
            </div>
          ))}
          {tab === "drafts" && drafts.length === 0 && <div className="jbm__none">No drafts yet — collect jobs, then “Draft”.</div>}
        </div>
      </div>

      <div className="jbm__composer">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Message Jobomate…  (e.g. “find recent backend jobs”)"
          rows={2}
        />
        <button className="jbm__sendBtn" onClick={send} disabled={!!busy || !prompt.trim()}><Send size={16} /></button>
      </div>
    </section>
  );
};
