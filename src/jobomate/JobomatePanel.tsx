import React, { useCallback, useEffect, useRef, useState } from "react";
import { Send, Bot, UserRound, Briefcase, Building2, FileText, CheckCircle2, Mail, Play, Loader2, Pencil, Trash2, Eye, EyeOff, X, Plus, MessagesSquare, ChevronDown, Paperclip, CalendarClock } from "lucide-react";
import { engine, EngineStatus, JobRow, CompanyRow, DraftRow, ThreadRow } from "./api";

interface Msg { id: string; role: "user" | "assistant" | "system"; content: string; }

type EditState =
  | { kind: "job"; data: JobRow }
  | { kind: "draft"; data: DraftRow }
  | null;

const DRAFT_STATUSES = ["Draft", "Approved", "Rejected", "Paused"];

const uid = () => Math.random().toString(36).slice(2);

export const JobomatePanel: React.FC = () => {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [engineUp, setEngineUp] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"jobs" | "companies" | "drafts">("jobs");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [editing, setEditing] = useState<EditState>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // Chats (threads) + bulk selection
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [showChats, setShowChats] = useState(false);
  const [selThreads, setSelThreads] = useState<Set<string>>(new Set());
  const [selJobs, setSelJobs] = useState<Set<string>>(new Set());
  const [selCompanies, setSelCompanies] = useState<Set<string>>(new Set());
  const [selDrafts, setSelDrafts] = useState<Set<string>>(new Set());
  const [autoSend, setAutoSend] = useState(false);
  const chatsRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  // User-resizable chat ↔ results split (drag the divider between the chat and the Jobs/Drafts list).
  const [resultsH, setResultsH] = useState(() => {
    const s = Number(localStorage.getItem("jbm_results_h"));
    return s >= 90 && s <= 1000 ? s : 230;
  });
  const resultsHRef = useRef(resultsH);
  resultsHRef.current = resultsH;

  // User-resizable message box (drag the divider above the composer to grow/shrink it).
  const [composerH, setComposerH] = useState(() => {
    const s = Number(localStorage.getItem("jbm_composer_h"));
    return s >= 40 && s <= 400 ? s : 52;
  });
  const composerHRef = useRef(composerH);
  composerHRef.current = composerH;

  const startComposerDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = composerHRef.current;
    const onMove = (ev: MouseEvent) => {
      const sec = sectionRef.current;
      const max = sec ? Math.min(400, sec.clientHeight - 220) : 320;
      setComposerH(Math.min(Math.max(startH + (startY - ev.clientY), 40), Math.max(60, max)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem("jbm_composer_h", String(composerHRef.current));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startResultsDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = resultsHRef.current;
    const onMove = (ev: MouseEvent) => {
      const sec = sectionRef.current;
      const max = sec ? sec.clientHeight - 230 : 600;
      setResultsH(Math.min(Math.max(startH + (startY - ev.clientY), 90), Math.max(120, max)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem("jbm_results_h", String(resultsHRef.current));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const refreshStatus = useCallback(async () => {
    try { const s = await engine.status(); setStatus(s); setEngineUp(true); }
    catch { setEngineUp(false); }
  }, []);

  const refreshData = useCallback(async () => {
    try { setJobs(await engine.jobs()); } catch { /* ignore */ }
    try { setCompanies(await engine.companies()); } catch { /* ignore */ }
    try { setDrafts(await engine.drafts()); } catch { /* ignore */ }
  }, []);

  const refreshThreads = useCallback(async () => {
    try { setThreads(await engine.threads()); } catch { /* ignore */ }
  }, []);

  const setMsgsFrom = (msgs: { role: string; content: string }[]) =>
    setMessages((msgs || []).map((m) => ({ id: uid(), role: m.role as Msg["role"], content: m.content })));

  const loadMessages = useCallback(async () => {
    try { const t = await engine.threadMessages(); setMsgsFrom(t.messages); } catch { /* ignore */ }
  }, []);

  const newChat = useCallback(async () => {
    setShowChats(false);
    try { await engine.newThread(); } catch { /* ignore */ }
    setMessages([]); setSelJobs(new Set()); setSelDrafts(new Set());
    await refreshThreads(); await refreshData(); await refreshStatus();
  }, [refreshThreads, refreshData, refreshStatus]);

  const switchChat = useCallback(async (id: string) => {
    setShowChats(false);
    try { const t = await engine.switchThread(id); setMsgsFrom(t.messages); } catch { /* ignore */ }
    setSelJobs(new Set()); setSelDrafts(new Set());
    await refreshThreads(); await refreshData(); await refreshStatus();
  }, [refreshThreads, refreshData, refreshStatus]);

  const removeThreads = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} chat${ids.length > 1 ? "s" : ""}? Their collected jobs and drafts are removed too.`)) return;
    try { await engine.deleteThreads(ids); } catch { /* ignore */ }
    setSelThreads(new Set());
    await refreshThreads(); await loadMessages(); await refreshData(); await refreshStatus();
  }, [refreshThreads, loadMessages, refreshData, refreshStatus]);

  const toggleSel = (set: Set<string>, setFn: (s: Set<string>) => void, id: string) => {
    const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setFn(n);
  };

  const deleteJobsBulk = useCallback(async (all: boolean) => {
    const ids = all ? [] : [...selJobs];
    if (!all && ids.length === 0) return;
    if (!window.confirm(all ? `Delete all ${jobs.length} jobs in this chat?` : `Delete ${ids.length} selected job(s)?`)) return;
    try { await engine.deleteJobs(ids, all); } catch { /* ignore */ }
    setSelJobs(new Set()); await refreshData(); await refreshStatus();
  }, [selJobs, jobs.length, refreshData, refreshStatus]);

  const deleteDraftsBulk = useCallback(async (all: boolean) => {
    const ids = all ? [] : [...selDrafts];
    if (!all && ids.length === 0) return;
    if (!window.confirm(all ? `Delete all ${drafts.length} drafts in this chat?` : `Delete ${ids.length} selected draft(s)?`)) return;
    try { await engine.deleteDrafts(ids, all); } catch { /* ignore */ }
    setSelDrafts(new Set()); await refreshData(); await refreshStatus();
  }, [selDrafts, drafts.length, refreshData, refreshStatus]);

  const deleteCompaniesBulk = useCallback(async (all: boolean) => {
    const ids = all ? [] : [...selCompanies];
    if (!all && ids.length === 0) return;
    if (!window.confirm(all ? `Delete all ${companies.length} companies in this chat?` : `Delete ${ids.length} selected company(ies)?`)) return;
    try { await engine.deleteCompanies(ids, all); } catch { /* ignore */ }
    setSelCompanies(new Set()); await refreshData(); await refreshStatus();
  }, [selCompanies, companies.length, refreshData, refreshStatus]);

  const draftCompanies = useCallback(async () => {
    if (busy) return;
    const ids = [...selCompanies];
    setBusy("Drafting speculative applications…");
    try { const r = await engine.draft("company", ids); say("system", `Drafted ${r.drafted ?? 0} speculative application(s). See the Drafts tab.`); }
    catch (e: any) { say("system", "Draft failed: " + e.message); }
    setSelCompanies(new Set()); await refreshData(); setTab("drafts"); setBusy(null);
  }, [busy, selCompanies, refreshData]);

  const attachCv = useCallback(async () => {
    const picker = window.browserAPI?.dialog?.openCv;
    if (!picker) { say("system", "CV picker unavailable in this build."); return; }
    const path = await picker();
    if (!path) return;
    setBusy("Reading your CV…");
    try {
      const r = await engine.loadCv(path);
      say("system", r?.name ? `CV loaded — profile set to ${r.name}${r.headline ? " (" + r.headline + ")" : ""}.` : "CV loaded.");
    } catch (e: any) { say("system", "Couldn't read that CV: " + e.message); }
    await refreshStatus(); setBusy(null);
  }, [refreshStatus]);

  const scheduleSend = useCallback(async () => {
    if (busy) return;
    setBusy("Scheduling approved applications…");
    try { const r = await engine.schedule(); say("system", `Queued ${r.scheduled ?? 0} of ${r.of ?? 0} approved application(s) to send (rate-limited).`); }
    catch (e: any) { say("system", e.message); }
    await refreshStatus(); setBusy(null);
  }, [busy, refreshStatus]);

  // Poll the engine until it's up, then keep status fresh.
  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 4000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  useEffect(() => { if (engineUp) refreshData(); }, [engineUp, refreshData]);
  useEffect(() => { listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [messages]);

  // Once the engine is up, hydrate the active thread's chat history + the thread list.
  useEffect(() => {
    if (engineUp && !loadedRef.current) { loadedRef.current = true; loadMessages(); refreshThreads(); }
  }, [engineUp, loadMessages, refreshThreads]);

  // Close the Chats dropdown on outside click.
  useEffect(() => {
    if (!showChats) return;
    const onDoc = (e: MouseEvent) => { if (chatsRef.current && !chatsRef.current.contains(e.target as Node)) setShowChats(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showChats]);

  // Auto-send: while on, send any due (queued + scheduled) items every 2 minutes. The engine's
  // rate-limiter still spaces them out; dry-run unless a real email account is connected.
  useEffect(() => {
    if (!autoSend) return;
    const tick = async () => {
      try { const r = await engine.send(); if (r?.sent) say("system", `Auto-sent ${r.sent}${r.dryRun ? " (dry-run)" : ""}.`); } catch { /* ignore */ }
      await refreshStatus();
    };
    const t = setInterval(tick, 120000);
    return () => clearInterval(t);
  }, [autoSend, refreshStatus]);

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
        await refreshData(); setTab("companies"); break;
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

  // ---- manage jobs / drafts (edit, delete, include) ----
  const setField = (key: string, value: string) =>
    setEditing((prev) => (prev ? ({ ...prev, data: { ...prev.data, [key]: value } } as EditState) : prev));

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setBusy("Saving…");
    try {
      if (editing.kind === "job") {
        const j = editing.data;
        await engine.updateJob(j.id, {
          title: j.title, company: j.company, location: j.location, email: j.email || "",
        });
      } else {
        const d = editing.data;
        await engine.updateDraft(d.id, {
          role: d.role, company: d.company, to: d.to, subject: d.subject, body: d.body, status: d.status, coverLetter: d.coverLetter,
        });
      }
      await refreshData();
      setEditing(null);
    } catch (e: any) { say("system", "Save failed: " + e.message); }
    setBusy(null);
  }, [editing, refreshData]);

  const removeJob = useCallback(async (j: JobRow) => {
    if (!window.confirm(`Delete “${j.title}”? This removes it from your collected jobs.`)) return;
    setBusy("Deleting…");
    try { await engine.deleteJob(j.id); await refreshData(); } catch (e: any) { say("system", e.message); }
    setBusy(null);
  }, [refreshData]);

  const removeDraft = useCallback(async (d: DraftRow) => {
    if (!window.confirm(`Delete the draft for ${d.company || d.role}?`)) return;
    setBusy("Deleting…");
    try { await engine.deleteDraft(d.id); await refreshData(); } catch (e: any) { say("system", e.message); }
    setBusy(null);
  }, [refreshData]);

  const toggleInclude = useCallback(async (j: JobRow) => {
    try { await engine.updateJob(j.id, { included: !j.included }); await refreshData(); }
    catch (e: any) { say("system", e.message); }
  }, [refreshData]);

  return (
    <section className="jbm" ref={sectionRef}>
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

      <div className="jbm__chatbar">
        <button className="jbm__chatbarBtn" onClick={newChat} title="Start a new chat"><Plus size={14} /> New Chat</button>
        <button className="jbm__chatbarBtn" onClick={attachCv} disabled={!!busy} title="Attach your CV (PDF / Word / text) so applications are tailored to you">
          <Paperclip size={14} /> {status?.hasCv && status.profileName ? `${status.profileName.split(" ")[0]}’s CV` : "Attach CV"}
        </button>
        <div className="jbm__chatsWrap" ref={chatsRef}>
          <button className="jbm__chatbarBtn" onClick={() => { const open = !showChats; setShowChats(open); if (open) refreshThreads(); }}>
            <MessagesSquare size={14} /> Chats <ChevronDown size={12} />
          </button>
          {showChats && (
            <div className="jbm__chatsMenu">
              <div className="jbm__chatsTools">
                <label className="jbm__chatsAll">
                  <input
                    type="checkbox"
                    checked={threads.length > 0 && selThreads.size === threads.length}
                    onChange={() => setSelThreads(selThreads.size === threads.length ? new Set() : new Set(threads.map((t) => t.id)))}
                  />
                  Select all
                </label>
                {selThreads.size > 0 && (
                  <button className="jbm__chatsDelSel" onClick={() => removeThreads([...selThreads])}><Trash2 size={12} /> Delete ({selThreads.size})</button>
                )}
              </div>
              <div className="jbm__chatsList">
                {threads.length === 0 && <div className="jbm__none">No chats yet.</div>}
                {threads.map((t) => (
                  <div
                    key={t.id}
                    className={`jbm__chatItem ${t.active ? "is-active" : ""}`}
                    onContextMenu={(e) => { e.preventDefault(); removeThreads([t.id]); }}
                  >
                    <input
                      type="checkbox"
                      checked={selThreads.has(t.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSel(selThreads, setSelThreads, t.id)}
                    />
                    <button className="jbm__chatTitle" onClick={() => switchChat(t.id)} title={t.title}>
                      <span className="jbm__chatName">{t.title || "New chat"}</span>
                      <span className="jbm__chatMeta">{t.jobs} jobs · {t.drafts} drafts</span>
                    </button>
                    <button className="jbm__chatDel" title="Delete chat" onClick={() => removeThreads([t.id])}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
              <div className="jbm__chatsHint">Right-click a chat to delete it.</div>
            </div>
          )}
        </div>
      </div>

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
        <button onClick={scheduleSend} disabled={!!busy} title="Queue approved applications to send (rate-limited)"><CalendarClock size={14} /> Schedule{status && status.queued > 0 ? ` (${status.queued})` : ""}</button>
        <button onClick={() => quick("prepare")} disabled={!!busy}><Mail size={14} /> Prepare emails</button>
        <button onClick={() => quick("send")} disabled={!!busy}><Play size={14} /> Send</button>
        <label className="jbm__autosend" title="Automatically send due items every 2 minutes (rate-limited; dry-run unless a real email account is connected)">
          <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} /> Auto-send
        </label>
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

      <div className="jbm__vsplit" onMouseDown={startResultsDrag} title="Drag to resize" />

      <div className="jbm__results" style={{ height: resultsH, maxHeight: "none", flexShrink: 0 }}>
        <div className="jbm__tabs">
          <button className={tab === "jobs" ? "on" : ""} onClick={() => setTab("jobs")}>Jobs ({jobs.length})</button>
          <button className={tab === "companies" ? "on" : ""} onClick={() => setTab("companies")}>Companies ({companies.length})</button>
          <button className={tab === "drafts" ? "on" : ""} onClick={() => setTab("drafts")}>Drafts ({drafts.length})</button>
        </div>

        {tab === "jobs" && jobs.length > 0 && (
          <div className="jbm__resultBar">
            <label><input type="checkbox" checked={selJobs.size === jobs.length}
              onChange={() => setSelJobs(selJobs.size === jobs.length ? new Set() : new Set(jobs.map((j) => j.id)))} /> All</label>
            {selJobs.size > 0 && <button onClick={() => deleteJobsBulk(false)}><Trash2 size={12} /> Delete ({selJobs.size})</button>}
            <button className="jbm__delAll" onClick={() => deleteJobsBulk(true)}>Delete all</button>
          </div>
        )}
        {tab === "companies" && companies.length > 0 && (
          <div className="jbm__resultBar">
            <label><input type="checkbox" checked={selCompanies.size === companies.length}
              onChange={() => setSelCompanies(selCompanies.size === companies.length ? new Set() : new Set(companies.map((c) => c.id)))} /> All</label>
            <button onClick={draftCompanies} disabled={!!busy} title="Draft speculative applications for the selected (or all) companies"><FileText size={12} /> Draft{selCompanies.size > 0 ? ` (${selCompanies.size})` : ""}</button>
            {selCompanies.size > 0 && <button onClick={() => deleteCompaniesBulk(false)}><Trash2 size={12} /> Delete ({selCompanies.size})</button>}
            <button className="jbm__delAll" onClick={() => deleteCompaniesBulk(true)}>Delete all</button>
          </div>
        )}
        {tab === "drafts" && drafts.length > 0 && (
          <div className="jbm__resultBar">
            <label><input type="checkbox" checked={selDrafts.size === drafts.length}
              onChange={() => setSelDrafts(selDrafts.size === drafts.length ? new Set() : new Set(drafts.map((d) => d.id)))} /> All</label>
            {selDrafts.size > 0 && <button onClick={() => deleteDraftsBulk(false)}><Trash2 size={12} /> Delete ({selDrafts.size})</button>}
            <button className="jbm__delAll" onClick={() => deleteDraftsBulk(true)}>Delete all</button>
          </div>
        )}

        <div className="jbm__resultList">
          {tab === "jobs" && jobs.slice(0, 300).map((j) => (
            <div key={j.id} className={`jbm__job ${j.included === false ? "jbm__job--off" : ""} ${selJobs.has(j.id) ? "is-sel" : ""}`}>
              <input type="checkbox" className="jbm__rowCheck" checked={selJobs.has(j.id)} onChange={() => toggleSel(selJobs, setSelJobs, j.id)} />
              <div className="jbm__jobMain">
                <div className="jbm__jobTitle">{j.title}</div>
                <div className="jbm__jobMeta">{[j.company, j.location].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="jbm__rowActions">
                <button title={j.included === false ? "Include in drafting" : "Exclude from drafting"} onClick={() => toggleInclude(j)}>
                  {j.included === false ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button title="Edit job" onClick={() => setEditing({ kind: "job", data: { ...j } })}><Pencil size={14} /></button>
                <button title="Delete job" onClick={() => removeJob(j)}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {tab === "jobs" && jobs.length === 0 && <div className="jbm__none">No postings in this chat yet — hit “Recent jobs”.</div>}
          {tab === "companies" && companies.slice(0, 300).map((c) => (
            <div key={c.id} className={`jbm__job ${selCompanies.has(c.id) ? "is-sel" : ""}`}>
              <input type="checkbox" className="jbm__rowCheck" checked={selCompanies.has(c.id)} onChange={() => toggleSel(selCompanies, setSelCompanies, c.id)} />
              <div className="jbm__jobMain">
                <div className="jbm__jobTitle">{c.name}</div>
                <div className="jbm__jobMeta">{[c.email, c.website, c.location].filter(Boolean).join(" · ") || "no email — needs manual contact"}</div>
              </div>
              <div className="jbm__rowActions">
                <button title="Delete company" onClick={async () => { if (window.confirm(`Delete ${c.name}?`)) { try { await engine.deleteCompanies([c.id]); } catch { /* ignore */ } await refreshData(); await refreshStatus(); } }}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {tab === "companies" && companies.length === 0 && <div className="jbm__none">No companies in this chat yet — hit “Companies”.</div>}
          {tab === "drafts" && drafts.map((d) => (
            <div key={d.id} className={`jbm__job ${selDrafts.has(d.id) ? "is-sel" : ""}`}>
              <input type="checkbox" className="jbm__rowCheck" checked={selDrafts.has(d.id)} onChange={() => toggleSel(selDrafts, setSelDrafts, d.id)} />
              <div className="jbm__jobMain">
                <div className="jbm__jobTitle">{d.role} <span className={`jbm__pill jbm__pill--${d.status.toLowerCase()}`}>{d.status}</span></div>
                <div className="jbm__jobMeta">{d.company}{d.to ? ` · ${d.to}` : ""}</div>
              </div>
              <div className="jbm__rowActions">
                <button title="Edit draft" onClick={() => setEditing({ kind: "draft", data: { ...d } })}><Pencil size={14} /></button>
                <button title="Delete draft" onClick={() => removeDraft(d)}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {tab === "drafts" && drafts.length === 0 && <div className="jbm__none">No drafts in this chat yet — collect jobs, then “Draft”.</div>}
        </div>
      </div>

      <div className="jbm__composerSplit" onMouseDown={startComposerDrag} title="Drag to resize the message box" />

      <div className="jbm__composer">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Message Jobomate…  (e.g. “find recent backend jobs”)"
          style={{ height: composerH }}
        />
        <button className="jbm__sendBtn" onClick={send} disabled={!!busy || !prompt.trim()}><Send size={16} /></button>
      </div>

      {editing && (
        <div className="jbm__modalOverlay" onClick={() => setEditing(null)}>
          <div className="jbm__modal" onClick={(e) => e.stopPropagation()}>
            <div className="jbm__modalHead">
              <span>{editing.kind === "job" ? "Edit job" : "Edit draft"}</span>
              <button className="jbm__modalClose" onClick={() => setEditing(null)} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="jbm__modalBody">
              {editing.kind === "job" ? (
                <>
                  <label>Title<input value={editing.data.title} onChange={(e) => setField("title", e.target.value)} /></label>
                  <label>Company<input value={editing.data.company} onChange={(e) => setField("company", e.target.value)} /></label>
                  <label>Location<input value={editing.data.location} onChange={(e) => setField("location", e.target.value)} /></label>
                  <label>Contact email<input value={editing.data.email || ""} onChange={(e) => setField("email", e.target.value)} /></label>
                </>
              ) : (
                <>
                  <label>Role<input value={editing.data.role} onChange={(e) => setField("role", e.target.value)} /></label>
                  <label>Company<input value={editing.data.company} onChange={(e) => setField("company", e.target.value)} /></label>
                  <label>To<input value={editing.data.to} onChange={(e) => setField("to", e.target.value)} placeholder="recipient@company.com" /></label>
                  <label>Subject<input value={editing.data.subject} onChange={(e) => setField("subject", e.target.value)} /></label>
                  <label>Status
                    <select value={editing.data.status} onChange={(e) => setField("status", e.target.value)}>
                      {DRAFT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label>Email body<textarea rows={7} value={editing.data.body} onChange={(e) => setField("body", e.target.value)} /></label>
                  <label>Cover letter<textarea rows={9} value={editing.data.coverLetter} onChange={(e) => setField("coverLetter", e.target.value)} placeholder="The tailored cover letter the model wrote" /></label>
                </>
              )}
            </div>
            <div className="jbm__modalFoot">
              <button className="jbm__btnGhost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="jbm__btnPrimary" onClick={saveEdit} disabled={!!busy}>Save</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
