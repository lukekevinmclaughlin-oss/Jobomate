import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Send,
  Bot,
  UserRound,
  Briefcase,
  Building2,
  FileText,
  CheckCircle2,
  Mail,
  Play,
  Loader2,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  X,
  Plus,
  MessagesSquare,
  ChevronDown,
  Paperclip,
  CalendarClock,
  TrendingUp,
  DollarSign,
  FileDown,
  Users,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import {
  engine,
  EngineStatus,
  JobRow,
  CompanyRow,
  DraftRow,
  ThreadRow,
  AttachmentRow,
} from "./api";
import type { TrackerRow, CostsData } from "../types";

interface Msg {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

type EditState =
  | { kind: "job"; data: JobRow }
  | { kind: "draft"; data: DraftRow }
  | null;

const DRAFT_STATUSES = ["Draft", "Approved", "Rejected", "Paused"];
type WorkflowStage = "discover" | "evaluate" | "draft" | "approve" | "send" | "track";
type SelectedWorkItem =
  | { kind: "job"; id: string }
  | { kind: "company"; id: string }
  | { kind: "draft"; id: string }
  | { kind: "tracker"; id: string };

export interface JobomatePanelCommand {
  target: "workspace" | "pipeline" | "tracker" | "attach";
  id: number;
}

const uid = () => Math.random().toString(36).slice(2);

export const JobomatePanel: React.FC<{
  command?: JobomatePanelCommand | null;
  // The application-type focus is owned by the app shell (the big sidebar toggle) so it can live on
  // the main UI; the panel reads it and reports changes back through onDraftKindChange.
  draftKind?: "job" | "speculative";
  onDraftKindChange?: (kind: "job" | "speculative") => void;
}> = ({ command, draftKind = "job", onDraftKindChange }) => {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [engineUp, setEngineUp] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"jobs" | "companies" | "drafts" | "tracker">(
    "jobs",
  );
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>("discover");
  const [selectedWorkItem, setSelectedWorkItem] =
    useState<SelectedWorkItem | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Which application type the drafts workflow is focused on. Filters the Drafts list AND scopes the
  // "Draft" action so the model works on one type at a time (job postings ⇄ speculative/unsolicited).
  // draftKind comes from props (the app-shell sidebar owns it). Keep the name `setDraftKind` so the
  // existing in-panel toggles keep working; it just forwards to the shared setter.
  const setDraftKind = useCallback(
    (kind: "job" | "speculative") => onDraftKindChange?.(kind),
    [onDraftKindChange],
  );
  const [tracker, setTracker] = useState<TrackerRow[]>([]);
  const [costs, setCosts] = useState<CostsData | null>(null);
  const [showCosts, setShowCosts] = useState(false);
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
  const handledCommandRef = useRef<number | null>(null);

  // User-resizable chat ↔ results split (drag the divider between the chat and the Jobs/Drafts list).
  const [resultsH, setResultsH] = useState(() => {
    const s = Number(localStorage.getItem("jbm_results_h"));
    return s >= 90 && s <= 1000 ? s : 190;
  });
  const resultsHRef = useRef(resultsH);
  resultsHRef.current = resultsH;

  // User-resizable message box (drag the divider above the composer to grow/shrink it).
  const [composerH, setComposerH] = useState(() => {
    const s = Number(localStorage.getItem("jbm_composer_h"));
    return s >= 40 && s <= 400 ? s : 42;
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
      setComposerH(
        Math.min(
          Math.max(startH + (startY - ev.clientY), 40),
          Math.max(60, max),
        ),
      );
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
      setResultsH(
        Math.min(
          Math.max(startH + (startY - ev.clientY), 90),
          Math.max(120, max),
        ),
      );
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
    try {
      const s = await engine.status();
      setStatus(s);
      setEngineUp(true);
    } catch {
      setEngineUp(false);
    }
  }, []);

  const refreshData = useCallback(async () => {
    try {
      setJobs(await engine.jobs());
    } catch {
      /* ignore */
    }
    try {
      setCompanies(await engine.companies());
    } catch {
      /* ignore */
    }
    try {
      setDrafts(await engine.drafts());
    } catch {
      /* ignore */
    }
    try {
      setTracker(await engine.tracker());
    } catch {
      /* ignore */
    }
    try {
      setAttachments(await engine.attachments());
    } catch {
      /* ignore */
    }
  }, []);

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await engine.threads());
    } catch {
      /* ignore */
    }
  }, []);

  const setMsgsFrom = (msgs: { role: string; content: string }[]) =>
    setMessages(
      (msgs || []).map((m) => ({
        id: uid(),
        role: m.role as Msg["role"],
        content: m.content,
      })),
    );

  const loadMessages = useCallback(async () => {
    try {
      const t = await engine.threadMessages();
      setMsgsFrom(t?.messages ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const newChat = useCallback(async () => {
    setShowChats(false);
    try {
      await engine.newThread();
    } catch {
      /* ignore */
    }
    setMessages([]);
    setSelJobs(new Set());
    setSelDrafts(new Set());
    await refreshThreads();
    await refreshData();
    await refreshStatus();
  }, [refreshThreads, refreshData, refreshStatus]);

  const switchChat = useCallback(
    async (id: string) => {
      setShowChats(false);
      try {
        const t = await engine.switchThread(id);
        setMsgsFrom(t?.messages ?? []);
      } catch {
        /* ignore */
      }
      setSelJobs(new Set());
      setSelDrafts(new Set());
      await refreshThreads();
      await refreshData();
      await refreshStatus();
    },
    [refreshThreads, refreshData, refreshStatus],
  );

  const removeThreads = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      if (
        !window.confirm(
          `Delete ${ids.length} chat${ids.length > 1 ? "s" : ""}? Their collected jobs and drafts are removed too.`,
        )
      )
        return;
      try {
        await engine.deleteThreads(ids);
      } catch {
        /* ignore */
      }
      setSelThreads(new Set());
      await refreshThreads();
      await loadMessages();
      await refreshData();
      await refreshStatus();
    },
    [refreshThreads, loadMessages, refreshData, refreshStatus],
  );

  const toggleSel = (
    set: Set<string>,
    setFn: (s: Set<string>) => void,
    id: string,
  ) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setFn(n);
  };

  const deleteJobsBulk = useCallback(
    async (all: boolean) => {
      const ids = all ? [] : [...selJobs];
      if (!all && ids.length === 0) return;
      if (
        !window.confirm(
          all
            ? `Delete all ${jobs.length} jobs in this chat?`
            : `Delete ${ids.length} selected job(s)?`,
        )
      )
        return;
      try {
        await engine.deleteJobs(ids, all);
      } catch {
        /* ignore */
      }
      setSelJobs(new Set());
      await refreshData();
      await refreshStatus();
    },
    [selJobs, jobs.length, refreshData, refreshStatus],
  );

  const deleteDraftsBulk = useCallback(
    async (all: boolean) => {
      // "all" is scoped to the currently-shown application type, so toggling Speculative and hitting
      // "Delete all" never wipes the job-posting drafts (and vice versa).
      const ids = all
        ? drafts.filter((d) => d.kind === draftKind).map((d) => d.id)
        : [...selDrafts];
      if (ids.length === 0) return;
      const typeLabel =
        draftKind === "speculative" ? "speculative" : "job-posting";
      if (
        !window.confirm(
          all
            ? `Delete all ${ids.length} ${typeLabel} draft(s) shown?`
            : `Delete ${ids.length} selected draft(s)?`,
        )
      )
        return;
      try {
        await engine.deleteDrafts(ids, false);
      } catch {
        /* ignore */
      }
      setSelDrafts(new Set());
      await refreshData();
      await refreshStatus();
    },
    [selDrafts, drafts, draftKind, refreshData, refreshStatus],
  );

  const deleteCompaniesBulk = useCallback(
    async (all: boolean) => {
      const ids = all ? [] : [...selCompanies];
      if (!all && ids.length === 0) return;
      if (
        !window.confirm(
          all
            ? `Delete all ${companies.length} companies in this chat?`
            : `Delete ${ids.length} selected company(ies)?`,
        )
      )
        return;
      try {
        await engine.deleteCompanies(ids, all);
      } catch {
        /* ignore */
      }
      setSelCompanies(new Set());
      await refreshData();
      await refreshStatus();
    },
    [selCompanies, companies.length, refreshData, refreshStatus],
  );

  const draftCompanies = useCallback(async () => {
    if (busy) return;
    const ids = [...selCompanies];
    setBusy("Drafting speculative applications…");
    try {
      const r = await engine.draft("company", ids);
      say(
        "system",
        `Drafted ${r.drafted ?? 0} speculative application(s). See the Drafts tab.`,
      );
    } catch (e: any) {
      say("system", "Draft failed: " + e.message);
    }
    setSelCompanies(new Set());
    await refreshData();
    setTab("drafts");
    setBusy(null);
  }, [busy, selCompanies, refreshData]);

  const attachCv = useCallback(async () => {
    const picker = window.browserAPI?.dialog?.openCv;
    if (!picker) {
      say("system", "CV picker unavailable in this build.");
      return;
    }
    const path = await picker();
    if (!path) return;
    setBusy("Reading your CV…");
    try {
      const r = await engine.loadCv(path);
      say(
        "system",
        r?.name
          ? `CV loaded — profile set to ${r.name}${r.headline ? " (" + r.headline + ")" : ""}.`
          : "CV loaded.",
      );
    } catch (e: any) {
      say("system", "Couldn't read that CV: " + e.message);
    }
    await refreshStatus();
    setBusy(null);
  }, [refreshStatus]);

  // Drop any file(s) into the composer: resolve each to a path, ingest its text into this chat's
  // context so the connected model can read and apply it. Binary files (images, archives) attach but
  // report as unreadable since the text model can't see them.
  const attachDroppedFiles = useCallback(
    async (files: File[]) => {
      const pathFor = window.browserAPI?.files?.pathFor;
      if (!pathFor) {
        say("system", "Drag-and-drop attachments aren't available in this build.");
        return;
      }
      setBusy("Reading dropped file(s)…");
      for (const f of files) {
        let path = "";
        try {
          path = pathFor(f);
        } catch {
          /* ignore */
        }
        if (!path) {
          say("system", `Couldn't read “${f.name}”.`);
          continue;
        }
        try {
          const r = await engine.attach(path);
          if (!r || r.error) {
            say("system", `Couldn't attach “${f.name}”${r?.error ? ": " + r.error : ""}.`);
          } else if (r.readable) {
            say(
              "system",
              `Attached “${r.name}” (${r.chars?.toLocaleString()} chars${r.truncated ? ", truncated" : ""}) — I'll use it as context.`,
            );
          } else {
            say(
              "system",
              `Attached “${r.name}”, but I couldn't read it as text (it looks binary, e.g. an image or archive). The current model reads text only.`,
            );
          }
        } catch (e: any) {
          say("system", `Couldn't attach “${f.name}”: ${e.message}`);
        }
      }
      await engine.attachments().then(setAttachments).catch(() => {});
      await refreshStatus();
      setBusy(null);
    },
    [refreshStatus],
  );

  const removeAttachment = useCallback(async (id: string) => {
    try {
      await engine.deleteAttachment(id);
    } catch {
      /* ignore */
    }
    await engine.attachments().then(setAttachments).catch(() => {});
    await refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!command) return;
    if (handledCommandRef.current === command.id) return;
    handledCommandRef.current = command.id;
    switch (command.target) {
      case "workspace":
        setShowChats(true);
        break;
      case "pipeline":
        setWorkflowStage("discover");
        setTab(drafts.length > 0 ? "drafts" : "jobs");
        break;
      case "tracker":
        setWorkflowStage("track");
        setTab("tracker");
        break;
      case "attach":
        attachCv();
        break;
    }
  }, [attachCv, command, drafts.length]);

  const scheduleSend = useCallback(async () => {
    if (busy) return;
    setBusy("Scheduling approved applications…");
    try {
      const r = await engine.schedule();
      say(
        "system",
        `Queued ${r.scheduled ?? 0} of ${r.of ?? 0} approved application(s) to send (rate-limited).`,
      );
    } catch (e: any) {
      say("system", e.message);
    }
    await refreshStatus();
    setBusy(null);
  }, [busy, refreshStatus]);

  // Poll the engine until it's up, then keep status fresh.
  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 4000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  useEffect(() => {
    if (engineUp) refreshData();
  }, [engineUp, refreshData]);
  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [messages]);

  // Once the engine is up, hydrate the active thread's chat history + the thread list.
  useEffect(() => {
    if (engineUp && !loadedRef.current) {
      loadedRef.current = true;
      loadMessages();
      refreshThreads();
    }
  }, [engineUp, loadMessages, refreshThreads]);

  // Close the Chats dropdown on outside click.
  useEffect(() => {
    if (!showChats) return;
    const onDoc = (e: MouseEvent) => {
      if (chatsRef.current && !chatsRef.current.contains(e.target as Node))
        setShowChats(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showChats]);

  // Auto-send: while on, send any due (queued + scheduled) items every 2 minutes. The engine's
  // rate-limiter still spaces them out; dry-run unless a real email account is connected.
  useEffect(() => {
    if (!autoSend) return;
    const tick = async () => {
      try {
        const r = await engine.send();
        if (r?.sent)
          say("system", `Auto-sent ${r.sent}${r.dryRun ? " (dry-run)" : ""}.`);
      } catch {
        /* ignore */
      }
      await refreshStatus();
      await refreshData(); // keep the application tracker live while auto-sending
    };
    const t = setInterval(tick, 120000);
    return () => clearInterval(t);
  }, [autoSend, refreshStatus, refreshData]);

  const say = (role: Msg["role"], content: string) =>
    setMessages((m) => [...m, { id: uid(), role, content }]);

  const runAction = useCallback(
    async (action: string) => {
      const isRecruiter = status?.mode === "Recruiter";
      switch (action) {
        case "research": {
          // Job-seeker search mode follows the application-type toggle:
          // "Apply to job postings" searches advertised jobs; "Speculative"
          // searches companies to approach unsolicited. Recruiter mode always
          // sources candidates.
          const speculative = !isRecruiter && draftKind === "speculative";
          setBusy(
            isRecruiter
              ? "Sourcing candidates in the browser…"
              : speculative
                ? "Finding companies to approach speculatively…"
                : "Researching jobs in the browser…",
          );
          try {
            const r = await engine.research(speculative ? "companies" : "jobs");
            say(
              "system",
              !r
                ? "Research couldn't reach the engine — check the model connection in Settings."
                : speculative
                  ? `Collected ${r.companies ?? 0} compan${(r.companies ?? 0) === 1 ? "y" : "ies"} to approach speculatively.`
                  : isRecruiter
                    ? `Sourced ${r.jobs ?? 0} candidates.`
                    : `Collected ${r.jobs ?? 0} job postings.`,
            );
          } catch (e: any) {
            say("system", "Research failed: " + e.message);
          }
          await refreshData();
          setTab(speculative ? "companies" : "jobs");
          break;
        }
        case "companies":
          setBusy("Researching companies in the browser…");
          try {
            const r = await engine.research("companies");
            say(
              "system",
              !r
                ? "Research couldn't reach the engine — check the model connection in Settings."
                : `Collected ${r.companies ?? 0} companies.`,
            );
          } catch (e: any) {
            say("system", "Research failed: " + e.message);
          }
          await refreshData();
          setTab("companies");
          break;
        case "list":
          await refreshData();
          setTab("jobs");
          say(
            "system",
            isRecruiter
              ? `${jobs.length} candidates sourced — see the Candidates tab below.`
              : `${jobs.length} postings collected — see the Jobs tab below.`,
          );
          break;
        case "draft": {
          // Scope drafting to the toggled application type: speculative -> from collected companies,
          // job postings -> from collected jobs. The model works on one type at a time.
          const spec = draftKind === "speculative";
          setBusy(
            spec
              ? "Drafting speculative applications…"
              : isRecruiter
                ? "Drafting outreach…"
                : "Drafting tailored applications…",
          );
          try {
            const r = await engine.draft(spec ? "company" : "job");
            say(
              "system",
              spec
                ? `Drafted ${r.drafted ?? 0} speculative application(s). Review them in the Drafts tab.`
                : isRecruiter
                  ? `Drafted ${r.drafted ?? 0} outreach messages. Review them in the Drafts tab.`
                  : `Drafted ${r.drafted ?? 0} applications. Review them in the Drafts tab.`,
            );
          } catch (e: any) {
            say("system", "Draft failed: " + e.message);
          }
          await refreshData();
          setTab("drafts");
          break;
        }
        case "approve":
          setBusy("Approving drafts…");
          try {
            const r = await engine.approve();
            say("system", `Approved ${r.approved ?? 0} drafts.`);
          } catch (e: any) {
            say("system", e.message);
          }
          await refreshData();
          break;
        case "prepare":
          setBusy("Opening Gmail — sign in if asked, then I'll create drafts…");
          try {
            await engine.prepareEmails();
            const r = await engine.createDrafts();
            say(
              "system",
              r.error
                ? `Couldn't create drafts: ${r.error}`
                : `Created ${r.created ?? 0} Gmail drafts.`,
            );
          } catch (e: any) {
            say("system", e.message);
          }
          break;
        case "send":
          setBusy("Sending due items…");
          try {
            const r = await engine.send();
            say(
              "system",
              `${r.sent ?? 0} sent${r.dryRun ? " (dry-run)" : ""}. ${r.message ?? ""}`,
            );
          } catch (e: any) {
            say("system", e.message);
          }
          await refreshStatus();
          await refreshData(); // sending updates the application tracker
          break;
        case "settings":
          say(
            "system",
            "Open Settings (top-right gear) to connect a model or email account.",
          );
          break;
      }
      setBusy(null);
      await refreshStatus();
    },
    [jobs.length, refreshData, refreshStatus, status?.mode, draftKind],
  );

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt("");
    say("user", text);
    setBusy("Thinking…");
    try {
      const r = await engine.chat(text);
      if (!r) {
        say("system", "Couldn't reach the engine — open Settings and check the model connection.");
        setBusy(null);
        return;
      }
      if (r.text) say("assistant", r.text);
      setBusy(null);
      for (const a of r.actions || []) await runAction(a);
    } catch (e: any) {
      say("system", "Engine error: " + e.message);
      setBusy(null);
    }
  }, [prompt, busy, runAction]);

  const quick = async (action: string) => {
    if (!busy) await runAction(action);
  };

  // ---- manage jobs / drafts (edit, delete, include) ----
  const setField = (key: string, value: string) =>
    setEditing((prev) =>
      prev
        ? ({ ...prev, data: { ...prev.data, [key]: value } } as EditState)
        : prev,
    );

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setBusy("Saving…");
    try {
      if (editing.kind === "job") {
        const j = editing.data;
        await engine.updateJob(j.id, {
          title: j.title,
          company: j.company,
          location: j.location,
          email: j.email || "",
        });
      } else {
        const d = editing.data;
        await engine.updateDraft(d.id, {
          role: d.role,
          company: d.company,
          to: d.to,
          subject: d.subject,
          body: d.body,
          status: d.status,
          coverLetter: d.coverLetter,
        });
      }
      await refreshData();
      setEditing(null);
    } catch (e: any) {
      say("system", "Save failed: " + e.message);
    }
    setBusy(null);
  }, [editing, refreshData]);

  const removeJob = useCallback(
    async (j: JobRow) => {
      if (
        !window.confirm(
          `Delete “${j.title}”? This removes it from your collected jobs.`,
        )
      )
        return;
      setBusy("Deleting…");
      try {
        await engine.deleteJob(j.id);
        await refreshData();
      } catch (e: any) {
        say("system", e.message);
      }
      setBusy(null);
    },
    [refreshData],
  );

  const removeDraft = useCallback(
    async (d: DraftRow) => {
      if (!window.confirm(`Delete the draft for ${d.company || d.role}?`))
        return;
      setBusy("Deleting…");
      try {
        await engine.deleteDraft(d.id);
        await refreshData();
      } catch (e: any) {
        say("system", e.message);
      }
      setBusy(null);
    },
    [refreshData],
  );

  const toggleInclude = useCallback(
    async (j: JobRow) => {
      try {
        await engine.updateJob(j.id, { included: !j.included });
        await refreshData();
      } catch (e: any) {
        say("system", e.message);
      }
    },
    [refreshData],
  );

  const loadCosts = async () => {
    try {
      const c = await engine.costs();
      setCosts(c);
      setShowCosts(true);
    } catch {
      /* ignore */
    }
  };

  // ---- app mode (job seeker vs recruiter) drives every domain label ----
  const recruiter = status?.mode === "Recruiter";
  const switchMode = useCallback(
    async (mode: "JobSeeker" | "Recruiter") => {
      if (busy || status?.mode === mode) return;
      try {
        const s = await engine.setMode(mode);
        if (s) setStatus(s);
        else say("system", "Couldn't switch mode — engine unreachable. Check the model connection in Settings.");
      } catch {
        /* ignore */
      }
      await refreshData();
    },
    [busy, status?.mode, refreshData],
  );
  // ---- job-seeker application mode (apply to postings vs speculative) ----
  // Drives both the Discover search target (jobs vs companies) and which
  // application type gets drafted. Switching also reveals the matching tab.
  const setSeekMode = useCallback((kind: "job" | "speculative") => {
    setDraftKind(kind);
    setTab(kind === "speculative" ? "companies" : "jobs");
  }, [setDraftKind]);
  const L = recruiter
    ? {
        rowsTab: "Candidates",
        research: "Find candidates",
        researchBusy: "Sourcing candidates in the browser…",
        companies: "Companies",
        draft: "Draft outreach",
        draftBusy: "Drafting outreach…",
        attachCv: status?.hasCv ? "Role brief" : "Load role brief",
        attachCvTitle:
          "Load the role brief / job description you're hiring for, so outreach is tailored to it",
        rowsEmpty: "No candidates sourced in this chat yet — hit “Find candidates”.",
        draftsEmpty:
          "No outreach drafted in this chat yet — source candidates, then “Draft outreach”.",
        scheduleTitle: "Queue approved outreach to send (rate-limited)",
        introTitle: "I source candidates and draft outreach in this browser.",
        introBody:
          "Ask me anything, or use the buttons above: source candidates → draft personalised outreach → put it in your Gmail.",
        rowsListLabel: "candidates",
      }
    : {
        rowsTab: "Jobs",
        research: "Recent jobs",
        researchBusy: "Researching jobs in the browser…",
        companies: "Companies",
        draft: "Draft",
        draftBusy: "Drafting tailored applications…",
        attachCv:
          status?.hasCv && status.profileName
            ? `${status.profileName.split(" ")[0]}’s CV`
            : "Attach CV",
        attachCvTitle:
          "Attach your CV (PDF / Word / text) so applications are tailored to you",
        rowsEmpty: "No postings in this chat yet — hit “Recent jobs”.",
        draftsEmpty:
          "No drafts in this chat yet — collect jobs, then “Draft”.",
        scheduleTitle: "Queue approved applications to send (rate-limited)",
        introTitle: "I run your job hunt in this browser.",
        introBody:
          "Ask me anything, or use the buttons above: collect jobs → draft tailored applications → put them in your Gmail.",
        rowsListLabel: "postings",
      };

  const pendingDrafts = useMemo(
    () => drafts.filter((d) => d.status.toLowerCase() === "draft"),
    [drafts],
  );
  // Drafts split by application type; the Drafts tab shows one type at a time (see draftKind toggle).
  const jobDrafts = useMemo(() => drafts.filter((d) => d.kind === "job"), [drafts]);
  const specDrafts = useMemo(
    () => drafts.filter((d) => d.kind === "speculative"),
    [drafts],
  );
  const visibleDrafts = draftKind === "speculative" ? specDrafts : jobDrafts;
  const approvedDrafts = useMemo(
    () => drafts.filter((d) => d.status.toLowerCase() === "approved"),
    [drafts],
  );
  const scoredRows = useMemo(
    () => jobs.filter((j) => (j.fitScore ?? 0) > 0),
    [jobs],
  );

  const pipelineStages = useMemo(
    () => [
      {
        id: "discover" as const,
        label: "Discover",
        count: jobs.length + companies.length,
        icon: recruiter ? <Users size={16} /> : <Briefcase size={16} />,
      },
      {
        id: "evaluate" as const,
        label: "Evaluate",
        count: scoredRows.length,
        icon: <TrendingUp size={16} />,
      },
      {
        id: "draft" as const,
        label: "Draft",
        count: drafts.length,
        icon: <FileText size={16} />,
      },
      {
        id: "approve" as const,
        label: "Approve",
        count: pendingDrafts.length,
        icon: <CheckCircle2 size={16} />,
      },
      {
        id: "send" as const,
        label: "Send",
        count: status?.queued ?? approvedDrafts.length,
        icon: <Mail size={16} />,
      },
      {
        id: "track" as const,
        label: "Track",
        count: tracker.length,
        icon: <CalendarClock size={16} />,
      },
    ],
    [
      approvedDrafts.length,
      companies.length,
      drafts.length,
      jobs.length,
      pendingDrafts.length,
      recruiter,
      scoredRows.length,
      status?.queued,
      tracker.length,
    ],
  );

  const selectWorkflowStage = (stage: WorkflowStage) => {
    setWorkflowStage(stage);
    if (stage === "draft" || stage === "approve" || stage === "send") {
      setTab("drafts");
    } else if (stage === "track") {
      setTab("tracker");
    } else {
      setTab("jobs");
    }
  };

  const scoreAll = useCallback(async () => {
    if (busy) return;
    setWorkflowStage("evaluate");
    setBusy(recruiter ? "Scoring candidate fit…" : "Scoring all jobs…");
    try {
      const r = await engine.scoreAllJobs();
      say(
        "system",
        recruiter
          ? `Scored ${r.scored} of ${r.of} candidates.`
          : `Scored ${r.scored} of ${r.of} jobs.`,
      );
    } catch (e: any) {
      say("system", "Scoring failed: " + e.message);
    }
    await refreshData();
    setBusy(null);
  }, [busy, recruiter, refreshData]);

  const runPrimaryStageAction = useCallback(async () => {
    switch (workflowStage) {
      case "discover":
        await quick("research");
        break;
      case "evaluate":
        await scoreAll();
        break;
      case "draft":
        await quick("draft");
        break;
      case "approve":
        await quick("approve");
        break;
      case "send":
        if ((status?.queued ?? 0) > 0) await quick("send");
        else await scheduleSend();
        break;
      case "track":
        setTab("tracker");
        say("system", "Tracker opened.");
        break;
    }
  }, [quick, scheduleSend, scoreAll, status?.queued, workflowStage]);

  const primaryAction = {
    discover: recruiter
      ? "Find candidates"
      : draftKind === "speculative"
        ? "Find companies"
        : "Find jobs",
    evaluate: recruiter ? "Score candidates" : "Score jobs",
    draft: recruiter ? "Draft outreach" : "Draft applications",
    approve: "Approve drafts",
    send: (status?.queued ?? 0) > 0 ? "Send due items" : "Schedule approved",
    track: "Open tracker",
  }[workflowStage];

  const selected =
    selectedWorkItem?.kind === "job"
      ? jobs.find((j) => j.id === selectedWorkItem.id)
      : selectedWorkItem?.kind === "company"
        ? companies.find((c) => c.id === selectedWorkItem.id)
        : selectedWorkItem?.kind === "draft"
          ? drafts.find((d) => d.id === selectedWorkItem.id)
          : selectedWorkItem?.kind === "tracker"
            ? tracker.find((r) => r.id === selectedWorkItem.id)
            : drafts[0] ?? jobs[0] ?? companies[0] ?? tracker[0] ?? null;

  const selectedKind =
    selectedWorkItem?.kind ??
    (drafts[0]
      ? "draft"
      : jobs[0]
        ? "job"
        : companies[0]
          ? "company"
          : tracker[0]
            ? "tracker"
            : null);

  const selectedKey =
    selected && selectedKind
      ? `${selectedKind}:${"id" in selected ? selected.id : ""}`
      : "";

  return (
    <section className="jbm" ref={sectionRef}>
      <header className="jbm__head">
        <div className="jbm__brand">
          <Bot size={16} /> <span>Jobomate</span>
        </div>
        <div className="jbm__modeCluster">
          <div
            className={`jbm__modeToggle ${recruiter ? "is-recruiter" : "is-seeker"}`}
            role="group"
            aria-label="App mode"
            title="Switch between finding work (job seeker) and finding candidates (recruiter)"
          >
            <button
              className={`jbm__seekerBtn ${!recruiter ? "on" : ""}`}
              onClick={() => switchMode("JobSeeker")}
              disabled={!!busy || !engineUp}
              title="Job seeker — find work and apply"
            >
              <Briefcase size={12} /> Job seeker
            </button>
            <button
              className={`jbm__recruiterBtn ${recruiter ? "on" : ""}`}
              onClick={() => switchMode("Recruiter")}
              disabled={!!busy || !engineUp}
              title="Recruiter — find candidates and reach out"
            >
              <Users size={12} /> Recruiter
            </button>
          </div>
          {!recruiter && (
            <div
              className={`jbm__seekToggle ${draftKind === "speculative" ? "is-spec" : "is-postings"}`}
              role="group"
              aria-label="Application mode"
              title="Apply to advertised job postings, or send speculative applications to companies that aren't advertising"
            >
              <button
                className={`jbm__postingsBtn ${draftKind === "job" ? "on" : ""}`}
                onClick={() => setSeekMode("job")}
                disabled={!!busy || !engineUp}
                title="Apply to advertised job postings"
              >
                <FileText size={12} /> Job postings
              </button>
              <button
                className={`jbm__specBtn ${draftKind === "speculative" ? "on" : ""}`}
                onClick={() => setSeekMode("speculative")}
                disabled={!!busy || !engineUp}
                title="Send speculative applications to companies that aren't advertising"
              >
                <Send size={12} /> Speculative
              </button>
            </div>
          )}
        </div>
        <div className="jbm__status">
          {!engineUp ? (
            <span className="jbm__dot jbm__dot--off" />
          ) : (
            <span
              className={`jbm__dot ${status?.connected ? "jbm__dot--on" : "jbm__dot--warn"}`}
            />
          )}
          <span className="jbm__statusText">
            {!engineUp
              ? "Starting engine…"
              : status?.connected
                ? status?.model || "connected"
                : "Connect a model (Settings)"}
          </span>
          {status?.dryRun && <span className="jbm__badge">dry-run</span>}
          {status && (
            <button
              className="jbm__costBtn"
              onClick={async () => {
                if (showCosts) {
                  setShowCosts(false);
                  return;
                }
                await loadCosts();
              }}
              title="LLM cost breakdown"
            >
              <DollarSign size={14} />
              {costs?.totals?.usdCost != null
                ? `$${costs.totals.usdCost.toFixed(4)}`
                : status.tokens > 0
                  ? `${status.tokens} tokens`
                  : ""}
            </button>
          )}
        </div>
      </header>

      {showCosts && costs && (
        <div className="jbm__costs">
          <div className="jbm__costsHead">
            <span>LLM Cost Ledger</span>
            <button onClick={() => setShowCosts(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="jbm__costsTotals">
            <span>
              Total: {costs.totals.promptTokens?.toLocaleString() ?? 0} prompt +{" "}
              {costs.totals.completionTokens?.toLocaleString() ?? 0} completion
              tokens
            </span>
            <span>${costs.totals.usdCost?.toFixed(6) ?? "0.000000"}</span>
          </div>
          <div className="jbm__costsList">
            {(costs.records ?? [])
              .slice(-20)
              .reverse()
              .map((r, i) => (
                <div key={i} className="jbm__costRow">
                  <span className="jbm__costModel">{r.model || r.adapter}</span>
                  <span className="jbm__costTokens">
                    {r.promptTokens?.toLocaleString() ?? "?"} +{" "}
                    {r.completionTokens?.toLocaleString() ?? "?"}
                  </span>
                  <span className="jbm__costUsd">
                    ${r.usdCost?.toFixed(6) ?? "?"}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="jbm__chatbar">
        <button
          className="jbm__chatbarBtn"
          onClick={newChat}
          title="Start a new chat"
        >
          <Plus size={14} /> New Chat
        </button>
        <button
          className="jbm__chatbarBtn"
          onClick={attachCv}
          disabled={!!busy}
          title={L.attachCvTitle}
        >
          <Paperclip size={14} /> {L.attachCv}
        </button>
        <div className="jbm__chatsWrap" ref={chatsRef}>
          <button
            className="jbm__chatbarBtn"
            onClick={() => {
              const open = !showChats;
              setShowChats(open);
              if (open) refreshThreads();
            }}
          >
            <MessagesSquare size={14} /> Chats <ChevronDown size={12} />
          </button>
          {showChats && (
            <div className="jbm__chatsMenu">
              <div className="jbm__chatsTools">
                <label className="jbm__chatsAll">
                  <input
                    type="checkbox"
                    checked={
                      threads.length > 0 && selThreads.size === threads.length
                    }
                    onChange={() =>
                      setSelThreads(
                        selThreads.size === threads.length
                          ? new Set()
                          : new Set(threads.map((t) => t.id)),
                      )
                    }
                  />
                  Select all
                </label>
                {selThreads.size > 0 && (
                  <button
                    className="jbm__chatsDelSel"
                    onClick={() => removeThreads([...selThreads])}
                  >
                    <Trash2 size={12} /> Delete ({selThreads.size})
                  </button>
                )}
              </div>
              <div className="jbm__chatsList">
                {threads.length === 0 && (
                  <div className="jbm__none">No chats yet.</div>
                )}
                {threads.map((t) => (
                  <div
                    key={t.id}
                    className={`jbm__chatItem ${t.active ? "is-active" : ""}`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      removeThreads([t.id]);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selThreads.has(t.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() =>
                        toggleSel(selThreads, setSelThreads, t.id)
                      }
                    />
                    <button
                      className="jbm__chatTitle"
                      onClick={() => switchChat(t.id)}
                      title={t.title}
                    >
                      <span className="jbm__chatName">
                        {t.title || "New chat"}
                      </span>
                      <span className="jbm__chatMeta">
                        {t.jobs} jobs · {t.drafts} drafts
                      </span>
                    </button>
                    <button
                      className="jbm__chatDel"
                      title="Delete chat"
                      onClick={() => removeThreads([t.id])}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="jbm__chatsHint">
                Right-click a chat to delete it.
              </div>
            </div>
          )}
        </div>
      </div>

      {status?.needsUser && (
        <div className="jbm__needsUser">
          <span>Action needed in the browser: {status.needsUser}</span>
          <button
            onClick={async () => {
              await engine.resumeBrowser();
              await refreshStatus();
            }}
          >
            Resume — I've handled it
          </button>
        </div>
      )}

      <div className="jbm__pipeline" aria-label="Pipeline stages">
        {pipelineStages.map((stage, index) => (
          <button
            key={stage.id}
            type="button"
            className={`jbm__stage ${workflowStage === stage.id ? "is-active" : ""}`}
            onClick={() => selectWorkflowStage(stage.id)}
            disabled={!!busy && workflowStage !== stage.id}
            title={`${stage.label}: ${stage.count}`}
          >
            <span className="jbm__stageIcon">{stage.icon}</span>
            <span className="jbm__stageLabel">{stage.label}</span>
            <span className="jbm__stageCount">{stage.count}</span>
            {index < pipelineStages.length - 1 && (
              <span className="jbm__stageLine" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>

      <div className="jbm__commandBar">
        <button
          className="jbm__primaryAction"
          onClick={runPrimaryStageAction}
          disabled={!!busy || !engineUp}
        >
          {workflowStage === "send" ? <Play size={15} /> : pipelineStages.find((s) => s.id === workflowStage)?.icon}
          {primaryAction}
        </button>
        <div className="jbm__secondaryActions">
          <button
            onClick={() => quick("companies")}
            disabled={!!busy}
            title="Research companies"
          >
            <Building2 size={15} />
            <span>Companies</span>
          </button>
          <button onClick={scoreAll} disabled={!!busy} title="Score fit">
            <TrendingUp size={15} />
            <span>Score</span>
          </button>
          <button
            onClick={() => quick("prepare")}
            disabled={!!busy}
            title="Open Gmail and prepare drafts"
          >
            <Mail size={15} />
            <span>Prepare</span>
          </button>
          <button onClick={() => quick("send")} disabled={!!busy} title="Send due items">
            <Play size={15} />
            <span>Send</span>
          </button>
          <button onClick={refreshData} disabled={!!busy} title="Refresh data">
            <RefreshCw size={15} />
          </button>
        </div>
        <label
          className="jbm__autosend"
          title="Automatically send due items every 2 minutes (rate-limited; dry-run unless a real email account is connected)"
        >
          <input
            type="checkbox"
            checked={autoSend}
            onChange={(e) => setAutoSend(e.target.checked)}
          />
          Auto-send
        </label>
      </div>

      <div className="jbm__activityHead">
        <span>Agent activity</span>
        <span>
          {status?.browserRunning ? "Browser linked" : "Browser idle"} ·{" "}
          {status?.dryRun ? "Dry-run protected" : "Live send ready"}
        </span>
      </div>

      <div ref={listRef} className="jbm__messages">
        {messages.length === 0 && (
          <div className="jbm__empty">
            <p>
              <strong>
                {!recruiter && status?.profileName
                  ? `Hi ${status.profileName.split(" ")[0]} —`
                  : "Welcome —"}
              </strong>{" "}
              {L.introTitle}
            </p>
            <p>{L.introBody}</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`jbm__msg jbm__msg--${m.role}`}>
            <div className="jbm__msgIcon">
              {m.role === "user" ? <UserRound size={14} /> : <Bot size={14} />}
            </div>
            <div className="jbm__msgBody">{m.content}</div>
          </div>
        ))}
        {busy && (
          <div className="jbm__busy">
            <Loader2 size={14} className="jbm__spin" /> {busy}
          </div>
        )}
      </div>

      <div
        className="jbm__vsplit"
        onMouseDown={startResultsDrag}
        title="Drag to resize"
      />

      <div
        className="jbm__results"
        style={{ height: resultsH, maxHeight: "none", flexShrink: 0 }}
      >
        <div className="jbm__workbenchHead">
          <div>
            <span className="jbm__eyebrow">Workbench</span>
            <strong>{recruiter ? "Sourcing pipeline" : "Application pipeline"}</strong>
          </div>
          <button
            className="jbm__iconTool"
            type="button"
            onClick={refreshData}
            title="Refresh workbench"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="jbm__tabs">
          <button
            className={tab === "jobs" ? "on" : ""}
            onClick={() => setTab("jobs")}
          >
            {L.rowsTab} ({jobs.length})
          </button>
          <button
            className={tab === "companies" ? "on" : ""}
            onClick={() => setTab("companies")}
          >
            Companies ({companies.length})
          </button>
          <button
            className={tab === "drafts" ? "on" : ""}
            onClick={() => setTab("drafts")}
          >
            Drafts ({drafts.length})
          </button>
          <button
            className={tab === "tracker" ? "on" : ""}
            onClick={() => setTab("tracker")}
          >
            Tracker ({tracker.length})
          </button>
        </div>

        {tab === "drafts" && (
          <div className="jbm__draftKindToggle" role="tablist" aria-label="Application type">
            <button
              role="tab"
              aria-selected={draftKind === "job"}
              className={`jbm__jobKindBtn ${draftKind === "job" ? "on" : ""}`}
              onClick={() => setDraftKind("job")}
              title="Applications to specific job postings you collected"
            >
              Job postings ({jobDrafts.length})
            </button>
            <button
              role="tab"
              aria-selected={draftKind === "speculative"}
              className={`jbm__specKindBtn ${draftKind === "speculative" ? "on" : ""}`}
              onClick={() => setDraftKind("speculative")}
              title="Speculative / unsolicited applications to target companies"
            >
              Speculative ({specDrafts.length})
            </button>
          </div>
        )}

        {tab === "jobs" && jobs.length > 0 && (
          <div className="jbm__resultBar">
            <label>
              <input
                type="checkbox"
                checked={selJobs.size === jobs.length}
                onChange={() =>
                  setSelJobs(
                    selJobs.size === jobs.length
                      ? new Set()
                      : new Set(jobs.map((j) => j.id)),
                  )
                }
              />{" "}
              All
            </label>
            {selJobs.size > 0 && (
              <button onClick={() => deleteJobsBulk(false)}>
                <Trash2 size={12} /> Delete ({selJobs.size})
              </button>
            )}
            <button
              className="jbm__delAll"
              onClick={() => deleteJobsBulk(true)}
            >
              Delete all
            </button>
          </div>
        )}
        {tab === "companies" && companies.length > 0 && (
          <div className="jbm__resultBar">
            <label>
              <input
                type="checkbox"
                checked={selCompanies.size === companies.length}
                onChange={() =>
                  setSelCompanies(
                    selCompanies.size === companies.length
                      ? new Set()
                      : new Set(companies.map((c) => c.id)),
                  )
                }
              />{" "}
              All
            </label>
            <button
              onClick={draftCompanies}
              disabled={!!busy}
              title="Draft speculative applications for the selected (or all) companies"
            >
              <FileText size={12} /> Draft
              {selCompanies.size > 0 ? ` (${selCompanies.size})` : ""}
            </button>
            {selCompanies.size > 0 && (
              <button onClick={() => deleteCompaniesBulk(false)}>
                <Trash2 size={12} /> Delete ({selCompanies.size})
              </button>
            )}
            <button
              className="jbm__delAll"
              onClick={() => deleteCompaniesBulk(true)}
            >
              Delete all
            </button>
          </div>
        )}
        {tab === "drafts" && visibleDrafts.length > 0 && (
          <div className="jbm__resultBar">
            <label>
              <input
                type="checkbox"
                checked={
                  visibleDrafts.length > 0 &&
                  visibleDrafts.every((d) => selDrafts.has(d.id))
                }
                onChange={() =>
                  setSelDrafts(
                    visibleDrafts.every((d) => selDrafts.has(d.id))
                      ? new Set()
                      : new Set(visibleDrafts.map((d) => d.id)),
                  )
                }
              />{" "}
              All
            </label>
            {selDrafts.size > 0 && (
              <button onClick={() => deleteDraftsBulk(false)}>
                <Trash2 size={12} /> Delete ({selDrafts.size})
              </button>
            )}
            <button
              className="jbm__delAll"
              onClick={() => deleteDraftsBulk(true)}
            >
              Delete all
            </button>
          </div>
        )}

        {tab === "jobs" && jobs.length > 0 && (
          <div className="jbm__tableHead">
            <span />
            <span>{recruiter ? "Candidate" : "Job"}</span>
            <span>Signals</span>
          </div>
        )}
        {tab === "companies" && companies.length > 0 && (
          <div className="jbm__tableHead">
            <span />
            <span>Company</span>
            <span>Contact</span>
          </div>
        )}
        {tab === "drafts" && visibleDrafts.length > 0 && (
          <div className="jbm__tableHead">
            <span />
            <span>{draftKind === "speculative" ? "Speculative application" : "Application"}</span>
            <span>Status</span>
          </div>
        )}
        {tab === "tracker" && tracker.length > 0 && (
          <div className="jbm__tableHead">
            <span />
            <span>Record</span>
            <span>Status</span>
          </div>
        )}

        <div className="jbm__resultList">
          {tab === "jobs" &&
            jobs.slice(0, 300).map((j) => (
              <div
                key={j.id}
                className={`jbm__job ${j.included === false ? "jbm__job--off" : ""} ${selJobs.has(j.id) ? "is-sel" : ""} ${selectedKey === `job:${j.id}` ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedWorkItem({ kind: "job", id: j.id })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedWorkItem({ kind: "job", id: j.id });
                  }
                }}
              >
                <input
                  type="checkbox"
                  className="jbm__rowCheck"
                  checked={selJobs.has(j.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSel(selJobs, setSelJobs, j.id)}
                />
                <div className="jbm__jobMain">
                  <div className="jbm__jobTitle">
                    {j.title}
                    {j.fitScore != null && j.fitScore > 0 && (
                      <span className="jbm__fitBadge" title={j.fitExplanation}>
                        Fit: {Math.round(j.fitScore)}%
                      </span>
                    )}
                  </div>
                  <div className="jbm__jobMeta">
                    {[j.company, j.location].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="jbm__rowActions" onClick={(e) => e.stopPropagation()}>
                  <button
                    title="Score fit"
                    onClick={async () => {
                      setBusy("Scoring fit…");
                      try {
                        const r = await engine.scoreJob(j.id);
                        say(
                          "system",
                          `Fit score for ${j.title}: ${r.fitScore}/100 — ${r.explanation}`,
                        );
                        await refreshData();
                      } catch (e: any) {
                        say("system", "Score failed: " + e.message);
                      }
                      setBusy(null);
                    }}
                  >
                    <TrendingUp size={14} />
                  </button>
                  <button
                    title={
                      j.included === false
                        ? "Include in drafting"
                        : "Exclude from drafting"
                    }
                    onClick={() => toggleInclude(j)}
                  >
                    {j.included === false ? (
                      <EyeOff size={14} />
                    ) : (
                      <Eye size={14} />
                    )}
                  </button>
                  <button
                    title="Edit job"
                    onClick={() => setEditing({ kind: "job", data: { ...j } })}
                  >
                    <Pencil size={14} />
                  </button>
                  <button title="Delete job" onClick={() => removeJob(j)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          {tab === "jobs" && jobs.length === 0 && (
            <div className="jbm__none">
              {L.rowsEmpty}
            </div>
          )}
          {tab === "companies" &&
            companies.slice(0, 300).map((c) => (
              <div
                key={c.id}
                className={`jbm__job ${selCompanies.has(c.id) ? "is-sel" : ""} ${selectedKey === `company:${c.id}` ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() =>
                  setSelectedWorkItem({ kind: "company", id: c.id })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedWorkItem({ kind: "company", id: c.id });
                  }
                }}
              >
                <input
                  type="checkbox"
                  className="jbm__rowCheck"
                  checked={selCompanies.has(c.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() =>
                    toggleSel(selCompanies, setSelCompanies, c.id)
                  }
                />
                <div className="jbm__jobMain">
                  <div className="jbm__jobTitle">{c.name}</div>
                  <div className="jbm__jobMeta">
                    {[c.email, c.website, c.location]
                      .filter(Boolean)
                      .join(" · ") || "no email — needs manual contact"}
                  </div>
                </div>
                <div className="jbm__rowActions" onClick={(e) => e.stopPropagation()}>
                  <button
                    title="Delete company"
                    onClick={async () => {
                      if (window.confirm(`Delete ${c.name}?`)) {
                        try {
                          await engine.deleteCompanies([c.id]);
                        } catch {
                          /* ignore */
                        }
                        await refreshData();
                        await refreshStatus();
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          {tab === "companies" && companies.length === 0 && (
            <div className="jbm__none">
              No companies in this chat yet — hit “Companies”.
            </div>
          )}
          {tab === "drafts" &&
            visibleDrafts.map((d) => (
              <div
                key={d.id}
                className={`jbm__job ${selDrafts.has(d.id) ? "is-sel" : ""} ${selectedKey === `draft:${d.id}` ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedWorkItem({ kind: "draft", id: d.id })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedWorkItem({ kind: "draft", id: d.id });
                  }
                }}
              >
                <input
                  type="checkbox"
                  className="jbm__rowCheck"
                  checked={selDrafts.has(d.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSel(selDrafts, setSelDrafts, d.id)}
                />
                <div className="jbm__jobMain">
                  <div className="jbm__jobTitle">
                    {d.role}{" "}
                    <span
                      className={`jbm__pill jbm__pill--${d.status.toLowerCase()}`}
                    >
                      {d.status}
                    </span>
                  </div>
                  <div className="jbm__jobMeta">
                    {d.company}
                    {d.to ? ` · ${d.to}` : ""}
                  </div>
                </div>
                <div className="jbm__rowActions" onClick={(e) => e.stopPropagation()}>
                  <button
                    title="Generate cover letter PDF"
                    onClick={async () => {
                      setBusy("Generating PDF…");
                      try {
                        const r = await engine.generateCoverLetterPdf(d.id);
                        say("system", `Cover letter PDF saved: ${r.path}`);
                      } catch (e: any) {
                        say("system", "PDF generation failed: " + e.message);
                      }
                      setBusy(null);
                    }}
                  >
                    <FileDown size={14} />
                  </button>
                  <button
                    title="Edit draft"
                    onClick={() =>
                      setEditing({ kind: "draft", data: { ...d } })
                    }
                  >
                    <Pencil size={14} />
                  </button>
                  <button title="Delete draft" onClick={() => removeDraft(d)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          {tab === "drafts" && visibleDrafts.length === 0 && (
            <div className="jbm__none">
              {draftKind === "speculative"
                ? drafts.length > 0
                  ? "No speculative applications yet — collect companies, then “Draft”. (You have job-posting drafts under the other tab.)"
                  : "No speculative applications yet — collect companies in the Companies tab, then “Draft”."
                : drafts.length > 0
                  ? "No job-posting applications yet — collect jobs, then “Draft”. (You have speculative drafts under the other tab.)"
                  : L.draftsEmpty}
            </div>
          )}
          {tab === "tracker" &&
            tracker.map((r) => (
              <div
                key={r.id}
                className={`jbm__job ${selectedKey === `tracker:${r.id}` ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() =>
                  setSelectedWorkItem({ kind: "tracker", id: r.id })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedWorkItem({ kind: "tracker", id: r.id });
                  }
                }}
              >
                <div className="jbm__jobMain">
                  <div className="jbm__jobTitle">
                    {r.roleTitle}{" "}
                    <span
                      className={`jbm__pill jbm__pill--${r.status.toLowerCase()}`}
                    >
                      {r.status}
                    </span>
                  </div>
                  <div className="jbm__jobMeta">
                    {r.company}
                    {r.appliedAt
                      ? ` · Applied ${new Date(r.appliedAt).toLocaleDateString()}`
                      : ""}
                  </div>
                </div>
                <div className="jbm__rowActions" onClick={(e) => e.stopPropagation()}>
                  <select
                    value={r.status}
                    onChange={async (e) => {
                      try {
                        await engine.updateTracker(r.id, e.target.value);
                        await refreshData();
                      } catch {
                        /* ignore */
                      }
                    }}
                    style={{
                      fontSize: 11,
                      padding: "2px 4px",
                      border: "1px solid var(--border-primary)",
                      borderRadius: 4,
                      background: "var(--bg-primary)",
                      color: "var(--text-primary)",
                    }}
                  >
                    {[
                      "Drafted",
                      "Approved",
                      "Queued",
                      "Sent",
                      "Replied",
                      "Interview",
                      "Rejected",
                      "Failed",
                      "ManualRequired",
                    ].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          {tab === "tracker" && tracker.length === 0 && (
            <div className="jbm__none">
              No application records yet — draft and send applications to see
              them here.
            </div>
          )}
        </div>
      </div>

      {selected && selectedKind && (
        <div className="jbm__detailDrawer">
          <div className="jbm__detailHead">
            <div className="jbm__detailTitle">
              <span className="jbm__eyebrow">
                {selectedKind === "job"
                  ? recruiter
                    ? "Candidate review"
                    : "Job review"
                  : selectedKind === "company"
                    ? "Company review"
                    : selectedKind === "draft"
                      ? "Draft review"
                      : "Tracker record"}
              </span>
              <strong>
                {selectedKind === "job"
                  ? (selected as JobRow).title
                  : selectedKind === "company"
                    ? (selected as CompanyRow).name
                    : selectedKind === "draft"
                      ? (selected as DraftRow).role
                      : (selected as TrackerRow).roleTitle}
              </strong>
              <span>
                {selectedKind === "job"
                  ? [(selected as JobRow).company, (selected as JobRow).location]
                      .filter(Boolean)
                      .join(" · ")
                  : selectedKind === "company"
                    ? [(selected as CompanyRow).website, (selected as CompanyRow).location]
                        .filter(Boolean)
                        .join(" · ")
                    : selectedKind === "draft"
                      ? [
                          (selected as DraftRow).company,
                          (selected as DraftRow).to,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : [
                          (selected as TrackerRow).company,
                          (selected as TrackerRow).appliedAt
                            ? `Applied ${new Date(
                                (selected as TrackerRow).appliedAt ?? "",
                              ).toLocaleDateString()}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
              </span>
            </div>
            <button
              className="jbm__modalClose"
              onClick={() => setSelectedWorkItem(null)}
              aria-label="Close selected item"
            >
              <X size={15} />
            </button>
          </div>

          <div className="jbm__detailTabs">
            <span className="on">Draft</span>
            <span>{selectedKind === "company" ? "Company" : "Job details"}</span>
            <span>Company</span>
            <span>Notes</span>
            <span>Activity</span>
          </div>

          <div className="jbm__detailBody">
            <div className="jbm__detailDocs">
              <div className="jbm__docLine">
                <FileText size={15} />
                <span>
                  {selectedKind === "draft"
                    ? "Email draft"
                    : selectedKind === "company"
                      ? "Speculative target"
                      : recruiter
                        ? "Candidate profile"
                        : "Application target"}
                </span>
                <span className="jbm__dot jbm__dot--on" />
              </div>
              <div className="jbm__docLine">
                <Paperclip size={15} />
                <span>{recruiter ? "Role brief" : "Resume / CV"}</span>
                <span
                  className={`jbm__dot ${
                    status?.hasCv ? "jbm__dot--on" : "jbm__dot--warn"
                  }`}
                />
              </div>
              {selectedKind === "draft" && (
                <button
                  className="jbm__previewBtn"
                  onClick={() =>
                    setEditing({
                      kind: "draft",
                      data: { ...(selected as DraftRow) },
                    })
                  }
                >
                  Preview full application <ExternalLink size={13} />
                </button>
              )}
              {selectedKind === "job" && (selected as JobRow).url && (
                <button
                  className="jbm__previewBtn"
                  onClick={() => engine.openBrowser((selected as JobRow).url)}
                >
                  Open source page <ExternalLink size={13} />
                </button>
              )}
            </div>

            <div className="jbm__detailSignals">
              <strong>
                {selectedKind === "draft" ? "Approval checks" : "Why it matches"}
              </strong>
              {selectedKind === "job" && (selected as JobRow).fitScore ? (
                <span className="jbm__signalGood">
                  {Math.round((selected as JobRow).fitScore ?? 0)}% fit ·{" "}
                  {(selected as JobRow).fitExplanation || "scored by Jobomate"}
                </span>
              ) : selectedKind === "draft" ? (
                <>
                  <span className="jbm__signalGood">
                    Status: {(selected as DraftRow).status}
                  </span>
                  <span className="jbm__signalGood">
                    Subject ready: {(selected as DraftRow).subject ? "yes" : "needs edit"}
                  </span>
                </>
              ) : selectedKind === "tracker" ? (
                <>
                  <span className="jbm__signalGood">
                    Current state: {(selected as TrackerRow).status}
                  </span>
                  <span>{(selected as TrackerRow).notes || "No notes yet."}</span>
                </>
              ) : (
                <span>Review details, score fit, then draft when ready.</span>
              )}
            </div>

            <div className="jbm__detailActions">
              {selectedKind === "draft" ? (
                <>
                  <button
                    className="jbm__approveBtn"
                    disabled={!!busy}
                    onClick={async () => {
                      const draft = selected as DraftRow;
                      setBusy("Approving selected draft…");
                      try {
                        const r = await engine.approve([draft.id]);
                        say("system", `Approved ${r.approved ?? 1} draft.`);
                      } catch (e: any) {
                        say("system", e.message);
                      }
                      await refreshData();
                      setBusy(null);
                    }}
                  >
                    <CheckCircle2 size={15} /> Approve
                  </button>
                  <button
                    className="jbm__rejectBtn"
                    disabled={!!busy}
                    onClick={async () => {
                      const draft = selected as DraftRow;
                      setBusy("Rejecting selected draft…");
                      try {
                        await engine.updateDraft(draft.id, { status: "Rejected" });
                        say("system", "Draft rejected.");
                      } catch (e: any) {
                        say("system", e.message);
                      }
                      await refreshData();
                      setBusy(null);
                    }}
                  >
                    <X size={15} /> Reject
                  </button>
                  <button onClick={scheduleSend} disabled={!!busy}>
                    <CalendarClock size={15} /> Schedule
                  </button>
                </>
              ) : selectedKind === "job" ? (
                <>
                  <button
                    className="jbm__approveBtn"
                    disabled={!!busy}
                    onClick={async () => {
                      const job = selected as JobRow;
                      setBusy(recruiter ? "Drafting outreach…" : "Drafting application…");
                      try {
                        const r = await engine.draft("job", [job.id]);
                        say("system", `Drafted ${r.drafted ?? 0} item(s).`);
                      } catch (e: any) {
                        say("system", "Draft failed: " + e.message);
                      }
                      await refreshData();
                      setTab("drafts");
                      setBusy(null);
                    }}
                  >
                    <FileText size={15} /> Draft
                  </button>
                  <button onClick={scoreAll} disabled={!!busy}>
                    <TrendingUp size={15} /> Score
                  </button>
                </>
              ) : selectedKind === "company" ? (
                <button
                  className="jbm__approveBtn"
                  disabled={!!busy}
                  onClick={async () => {
                    const company = selected as CompanyRow;
                    setBusy("Drafting speculative application…");
                    try {
                      const r = await engine.draft("company", [company.id]);
                      say("system", `Drafted ${r.drafted ?? 0} item(s).`);
                    } catch (e: any) {
                      say("system", "Draft failed: " + e.message);
                    }
                    await refreshData();
                    setTab("drafts");
                    setBusy(null);
                  }}
                >
                  <FileText size={15} /> Draft
                </button>
              ) : (
                <button onClick={() => setTab("tracker")}>
                  <CalendarClock size={15} /> Open tracker
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        className="jbm__composerSplit"
        onMouseDown={startComposerDrag}
        title="Drag to resize the message box"
      />

      {attachments.length > 0 && (
        <div className="jbm__attachments">
          {attachments.map((a) => (
            <span
              key={a.id}
              className={"jbm__chip" + (a.readable ? "" : " jbm__chip--warn")}
              title={
                a.readable
                  ? `${a.chars.toLocaleString()} characters available to the model`
                  : "Couldn't read this file as text (binary / image)"
              }
            >
              <Paperclip size={11} />
              <span className="jbm__chipName">{a.name}</span>
              <button
                className="jbm__chipX"
                onClick={() => removeAttachment(a.id)}
                aria-label={`Remove ${a.name}`}
                title="Remove"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className={"jbm__composer" + (dragOver ? " jbm__composer--drop" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragEnter={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length) attachDroppedFiles(files);
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message Jobomate…  (drag any file here to add it as context)"
          style={{ height: composerH }}
        />
        <button
          className="jbm__sendBtn"
          onClick={send}
          disabled={!!busy || !prompt.trim()}
        >
          <Send size={16} />
        </button>
        {dragOver && (
          <div className="jbm__dropHint">Drop file(s) — I'll read them for context</div>
        )}
      </div>

      {editing && (
        <div className="jbm__modalOverlay" onClick={() => setEditing(null)}>
          <div className="jbm__modal" onClick={(e) => e.stopPropagation()}>
            <div className="jbm__modalHead">
              <span>{editing.kind === "job" ? "Edit job" : "Edit draft"}</span>
              <button
                className="jbm__modalClose"
                onClick={() => setEditing(null)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="jbm__modalBody">
              {editing.kind === "job" ? (
                <>
                  <label>
                    Title
                    <input
                      value={editing.data.title}
                      onChange={(e) => setField("title", e.target.value)}
                    />
                  </label>
                  <label>
                    Company
                    <input
                      value={editing.data.company}
                      onChange={(e) => setField("company", e.target.value)}
                    />
                  </label>
                  <label>
                    Location
                    <input
                      value={editing.data.location}
                      onChange={(e) => setField("location", e.target.value)}
                    />
                  </label>
                  <label>
                    Contact email
                    <input
                      value={editing.data.email || ""}
                      onChange={(e) => setField("email", e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Role
                    <input
                      value={editing.data.role}
                      onChange={(e) => setField("role", e.target.value)}
                    />
                  </label>
                  <label>
                    Company
                    <input
                      value={editing.data.company}
                      onChange={(e) => setField("company", e.target.value)}
                    />
                  </label>
                  <label>
                    To
                    <input
                      value={editing.data.to}
                      onChange={(e) => setField("to", e.target.value)}
                      placeholder="recipient@company.com"
                    />
                  </label>
                  <label>
                    Subject
                    <input
                      value={editing.data.subject}
                      onChange={(e) => setField("subject", e.target.value)}
                    />
                  </label>
                  <label>
                    Status
                    <select
                      value={editing.data.status}
                      onChange={(e) => setField("status", e.target.value)}
                    >
                      {DRAFT_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Email body
                    <textarea
                      rows={7}
                      value={editing.data.body}
                      onChange={(e) => setField("body", e.target.value)}
                    />
                  </label>
                  <label>
                    Cover letter
                    <textarea
                      rows={9}
                      value={editing.data.coverLetter}
                      onChange={(e) => setField("coverLetter", e.target.value)}
                      placeholder="The tailored cover letter the model wrote"
                    />
                  </label>
                </>
              )}
            </div>
            <div className="jbm__modalFoot">
              <button
                className="jbm__btnGhost"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button
                className="jbm__btnPrimary"
                onClick={saveEdit}
                disabled={!!busy}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
