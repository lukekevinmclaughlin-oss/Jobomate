// Thin client for the headless Jobomate engine (the C# backend the Electron app spawns on :9223).
const DEFAULT_PORT = 9223;

// Per-session engine coordinates (base URL + auth token), resolved once from the Electron host.
// Outside Electron (plain `vite` dev, unit tests) there is no host, so we fall back to the default
// loopback port with no token — matching an engine started without JOBOMATE_ENGINE_TOKEN.
let coords: Promise<{ base: string; token: string }> | null = null;
function engineCoords(): Promise<{ base: string; token: string }> {
  if (!coords) {
    coords = (async () => {
      try {
        const info = await window.browserAPI?.engine?.info();
        if (info?.port)
          return { base: `http://127.0.0.1:${info.port}`, token: info.token ?? "" };
      } catch {
        /* fall through to default */
      }
      return { base: `http://127.0.0.1:${DEFAULT_PORT}`, token: "" };
    })();
  }
  return coords;
}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const { token } = await engineCoords();
  const headers: Record<string, string> = { ...extra };
  if (token) headers["X-Jobomate-Token"] = token;
  return headers;
}

async function post(path: string, body?: unknown): Promise<any> {
  const { base } = await engineCoords();
  const r = await fetch(base + path, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

async function get(path: string): Promise<any> {
  const { base } = await engineCoords();
  const r = await fetch(base + path, { headers: await authHeaders() });
  return r.json();
}

export type AppMode = "JobSeeker" | "Recruiter";

export interface EngineStatus {
  mode: AppMode;
  connected: boolean;
  model: string;
  connectionType: string;
  provider: string;
  dryRun: boolean;
  emailProvider: string;
  status: string;
  jobs: number;
  companies: number;
  draftsPending: number;
  draftsApproved: number;
  queued: number;
  tokens: number;
  hasCv: boolean;
  profileName: string;
  profileHeadline: string;
  sites: string[];
  persona: string;
  browserRunning: boolean;
  browserStatus: string;
  needsUser?: string | null;
}

export interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  email?: string;
  included: boolean;
  fitScore?: number;
  fitExplanation?: string;
}
export interface CompanyRow {
  id: string;
  name: string;
  website: string;
  location: string;
  email?: string;
  contact?: string;
}
export interface DraftRow {
  id: string;
  company: string;
  role: string;
  status: string;
  to: string;
  subject: string;
  body: string;
  coverLetter: string;
}
export interface ChatReply {
  text: string;
  actions: string[];
}
export interface ThreadRow {
  id: string;
  title: string;
  lastActive: number;
  active: boolean;
  jobs: number;
  drafts: number;
}
export interface ThreadMessages {
  id: string;
  title: string;
  messages: { role: string; content: string }[];
}

export const engine = {
  status: (): Promise<EngineStatus> => get("/api/status"),
  chat: (text: string): Promise<ChatReply> => post("/api/chat", { text }),
  research: (goal: "jobs" | "companies", url?: string): Promise<any> =>
    post("/api/research", { goal, url }),
  jobs: (): Promise<JobRow[]> => get("/api/jobs"),
  companies: (): Promise<CompanyRow[]> => get("/api/companies"),
  drafts: (): Promise<DraftRow[]> => get("/api/drafts"),
  updateJob: (
    id: string,
    patch: Partial<
      Pick<
        JobRow,
        "title" | "company" | "location" | "email" | "url" | "included"
      >
    >,
  ): Promise<{ ok?: boolean; error?: string }> =>
    post("/api/jobs/update", { id, ...patch }),
  deleteJob: (id: string): Promise<{ ok?: boolean; error?: string }> =>
    post("/api/jobs/delete", { id }),
  updateDraft: (
    id: string,
    patch: Partial<
      Pick<
        DraftRow,
        | "role"
        | "company"
        | "to"
        | "subject"
        | "body"
        | "status"
        | "coverLetter"
      >
    >,
  ): Promise<{ ok?: boolean; error?: string }> =>
    post("/api/drafts/update", { id, ...patch }),
  deleteDraft: (id: string): Promise<{ ok?: boolean; error?: string }> =>
    post("/api/drafts/delete", { id }),
  deleteJobs: (ids: string[], all = false): Promise<{ deleted: number }> =>
    post("/api/jobs/delete-bulk", { ids, all }),
  deleteDrafts: (ids: string[], all = false): Promise<{ deleted: number }> =>
    post("/api/drafts/delete-bulk", { ids, all }),
  deleteCompanies: (ids: string[], all = false): Promise<{ deleted: number }> =>
    post("/api/companies/delete-bulk", { ids, all }),
  // ---- chat threads ----
  threads: (): Promise<ThreadRow[]> => get("/api/threads"),
  newThread: (): Promise<{ id: string; title: string; messages: any[] }> =>
    post("/api/thread/new"),
  switchThread: (id: string): Promise<ThreadMessages> =>
    post("/api/thread/switch", { id }),
  threadMessages: (): Promise<ThreadMessages> => get("/api/thread/messages"),
  deleteThreads: (
    ids: string[],
  ): Promise<{ deleted: number; active: string }> =>
    post("/api/thread/delete", { ids }),
  draft: (kind: "job" | "company", ids: string[] = []): Promise<any> =>
    post("/api/draft", { kind, ids }),
  approve: (ids: string[] = []): Promise<any> => post("/api/approve", { ids }),
  schedule: (): Promise<any> => post("/api/schedule"),
  send: (): Promise<any> => post("/api/send"),
  loadCv: (path: string): Promise<any> => post("/api/cv", { path }),
  openBrowser: (url: string): Promise<any> =>
    post("/api/browser/open", { url }),
  browserStatus: (): Promise<any> => get("/api/browser/status"),
  resumeBrowser: (): Promise<any> => post("/api/browser/resume"),
  prepareEmails: (): Promise<any> => post("/api/email/prepare"),
  createDrafts: (): Promise<any> => post("/api/email/create-drafts"),
  saveSites: (sites: string[]): Promise<any> => post("/api/sites", { sites }),
  savePersona: (persona: string): Promise<any> =>
    post("/api/persona", { persona }),
  setMode: (mode: AppMode): Promise<EngineStatus> => post("/api/mode", { mode }),
  setKey: (provider: string, key: string): Promise<any> =>
    post("/api/llm/key", { provider, key }),
  connect: (connect: boolean): Promise<any> =>
    post("/api/llm/connect", { connect }),
  // ---- costs & tracker ----
  costs: (): Promise<any> => get("/api/costs"),
  tracker: (): Promise<any> => get("/api/tracker"),
  updateTracker: (
    id: string,
    status: string,
    notes?: string,
  ): Promise<{ ok?: boolean; error?: string }> =>
    post("/api/tracker/update", { id, status, notes }),
  scoreJob: (id: string): Promise<{ fitScore: number; explanation: string }> =>
    post("/api/jobs/score", { id }),
  scoreAllJobs: (): Promise<{ scored: number; of: number }> =>
    post("/api/jobs/score-all"),
  generateCoverLetterPdf: (id: string): Promise<{ path: string }> =>
    post("/api/drafts/cover-letter-pdf", { id }),
};
