// Thin client for the headless Jobomate engine (the C# backend the Electron app spawns on :9223).
const BASE = "http://127.0.0.1:9223";

async function post(path: string, body?: unknown): Promise<any> {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

async function get(path: string): Promise<any> {
  const r = await fetch(BASE + path);
  return r.json();
}

export interface EngineStatus {
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
  profileName: string;
  profileHeadline: string;
  sites: string[];
  persona: string;
  browserRunning: boolean;
  browserStatus: string;
  needsUser?: string | null;
}

export interface JobRow { id: string; title: string; company: string; location: string; url: string; email?: string; included: boolean; }
export interface CompanyRow { id: string; name: string; website: string; location: string; email?: string; }
export interface DraftRow { id: string; company: string; role: string; status: string; to: string; subject: string; body: string; }
export interface ChatReply { text: string; actions: string[]; }

export const engine = {
  status: (): Promise<EngineStatus> => get("/api/status"),
  chat: (text: string): Promise<ChatReply> => post("/api/chat", { text }),
  research: (goal: "jobs" | "companies", url?: string): Promise<any> => post("/api/research", { goal, url }),
  jobs: (): Promise<JobRow[]> => get("/api/jobs"),
  companies: (): Promise<CompanyRow[]> => get("/api/companies"),
  drafts: (): Promise<DraftRow[]> => get("/api/drafts"),
  draft: (kind: "job" | "company", ids: string[] = []): Promise<any> => post("/api/draft", { kind, ids }),
  approve: (ids: string[] = []): Promise<any> => post("/api/approve", { ids }),
  schedule: (): Promise<any> => post("/api/schedule"),
  send: (): Promise<any> => post("/api/send"),
  loadCv: (path: string): Promise<any> => post("/api/cv", { path }),
  openBrowser: (url: string): Promise<any> => post("/api/browser/open", { url }),
  browserStatus: (): Promise<any> => get("/api/browser/status"),
  resumeBrowser: (): Promise<any> => post("/api/browser/resume"),
  prepareEmails: (): Promise<any> => post("/api/email/prepare"),
  createDrafts: (): Promise<any> => post("/api/email/create-drafts"),
  saveSites: (sites: string[]): Promise<any> => post("/api/sites", { sites }),
  savePersona: (persona: string): Promise<any> => post("/api/persona", { persona }),
  setKey: (provider: string, key: string): Promise<any> => post("/api/llm/key", { provider, key }),
  connect: (connect: boolean): Promise<any> => post("/api/llm/connect", { connect }),
};
