// SPDX-License-Identifier: AGPL-3.0-only
// Review-tab server: renders each pipeline stage (Discover / Evaluate / Draft /
// Approve / Send / Track) as a self-contained HTML page that opens as a tab in
// Jobomate's own browser. The user fully inspects the prepared work (CV-based
// research, the employer/role list, the drafted emails) and Approves or Requests
// changes before the next stage. Data comes from the engine's existing JSON API;
// nothing here is provider- or account-specific.

import * as http from "http";

export type StageId = "discover" | "evaluate" | "draft" | "approve" | "send" | "track";

export interface ReviewAction {
  stage: StageId;
  action: "approve" | "changes";
  notes: string;
  mode: string; // "seeker" | "recruiter"
  kind: string; // "job" | "speculative"
}

interface ReviewServerDeps {
  enginePort: number;
  engineToken: string;
  onAction: (a: ReviewAction) => void;
}

let server: http.Server | null = null;
let boundPort = 0;

const STAGE_TITLES: Record<StageId, string> = {
  discover: "Discover — the employers & roles found",
  evaluate: "Evaluate — fit against your CV",
  draft: "Draft — prepared applications",
  approve: "Approve — ready to finalise",
  send: "Send — recipients & emails to send",
  track: "Track — application status",
};

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function engineGet(deps: ReviewServerDeps, path: string): Promise<any[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${deps.enginePort}${path}`, {
      headers: { "X-Jobomate-Token": deps.engineToken },
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function card(inner: string): string {
  return `<div class="card">${inner}</div>`;
}

function empty(msg: string): string {
  return `<div class="empty">${esc(msg)}</div>`;
}

/** Render the body for a stage from the engine's data. */
async function renderStageBody(deps: ReviewServerDeps, stage: StageId, mode: string, kind: string): Promise<string> {
  const recruiter = mode === "recruiter";
  const noun = recruiter ? "candidates" : "employers";

  if (stage === "discover" || stage === "evaluate") {
    // Job seeker → jobs; recruiter → companies/candidates.
    if (recruiter) {
      const companies = await engineGet(deps, "/api/companies");
      if (!companies.length) return empty(`No ${noun} sourced yet — run "Find candidates" first.`);
      return companies
        .map((c) =>
          card(`<div class="h">${esc(c.name)}</div>
            <div class="sub">${esc(c.location)} ${c.website ? `· <a href="${esc(c.website)}" target="_blank">${esc(c.website)}</a>` : ""}</div>
            ${c.email ? `<div class="meta">Contact: ${esc(c.email)} (${esc(c.contact)})</div>` : `<div class="meta warn">No contact email yet (${esc(c.contact)})</div>`}`),
        )
        .join("");
    }
    const jobs = await engineGet(deps, "/api/jobs");
    if (!jobs.length) return empty(`No ${noun} found yet — run "Find jobs" first.`);
    return jobs
      .map((j) => {
        const fit = typeof j.fitScore === "number" ? Math.round(j.fitScore * 100) : null;
        const showFit = stage === "evaluate" && fit !== null;
        return card(`<div class="h">${esc(j.title)}${j.included ? "" : ` <span class="tag off">excluded</span>`}</div>
          <div class="sub">${esc(j.company)} · ${esc(j.location)}</div>
          ${j.url ? `<div class="meta"><a href="${esc(j.url)}" target="_blank">${esc(j.url)}</a></div>` : ""}
          ${j.email ? `<div class="meta">Apply to: ${esc(j.email)}</div>` : ""}
          ${showFit ? `<div class="fit"><b>Fit ${fit}%</b> — ${esc(j.fitExplanation || "No explanation yet")}</div>` : ""}`);
      })
      .join("");
  }

  if (stage === "draft" || stage === "approve" || stage === "send") {
    const drafts = await engineGet(deps, "/api/drafts");
    const filtered = drafts.filter((d) => (kind === "speculative" ? d.kind === "speculative" : d.kind === "job"));
    if (!filtered.length) return empty(`No drafts yet — collect ${noun}, then "Draft".`);
    return filtered
      .map((d) =>
        card(`<div class="h">${esc(d.company)} — ${esc(d.role)}</div>
          <div class="sub">To: ${esc(d.to) || `<span class="warn">no recipient yet</span>`} · <span class="tag">${esc(d.status)}</span></div>
          ${d.subject ? `<div class="meta"><b>Subject:</b> ${esc(d.subject)}</div>` : ""}
          ${d.body ? `<pre class="body">${esc(d.body)}</pre>` : d.coverLetter ? `<pre class="body">${esc(d.coverLetter)}</pre>` : `<div class="meta warn">Body not drafted yet.</div>`}`),
      )
      .join("");
  }

  // track
  const rows = await engineGet(deps, "/api/tracker");
  if (!rows.length) return empty("No applications tracked yet.");
  return rows
    .map((r) =>
      card(`<div class="h">${esc(r.company || r.role || r.title || "—")}</div>
        <div class="sub">${esc(r.role || "")} ${r.status ? `· <span class="tag">${esc(r.status)}</span>` : ""}</div>
        ${r.notes ? `<div class="meta">${esc(r.notes)}</div>` : ""}`),
    )
    .join("");
}

function pageHtml(stage: StageId, mode: string, kind: string, bodyHtml: string): string {
  const title = STAGE_TITLES[stage];
  const isSend = stage === "send";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root { --accent:#2563eb; --green:#16a34a; --amber:#b45309; --bg:#f6f8fa; --card:#fff; --border:#e5e7eb; --text:#111827; --sub:#6b7280; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  header { position:sticky; top:0; background:var(--card); border-bottom:1px solid var(--border); padding:16px 24px; }
  header .eyebrow { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--sub); }
  header h1 { margin:2px 0 0; font-size:19px; }
  main { padding:20px 24px 120px; max-width:900px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px 16px; margin-bottom:12px; }
  .h { font-weight:650; font-size:15px; }
  .sub { color:var(--sub); margin-top:2px; }
  .meta { margin-top:6px; font-size:13px; }
  .meta a { color:var(--accent); }
  .fit { margin-top:8px; padding:8px 10px; background:#eff6ff; border-radius:8px; font-size:13px; }
  .body { margin:8px 0 0; padding:10px 12px; background:#f9fafb; border:1px solid var(--border); border-radius:8px; white-space:pre-wrap; font:13px/1.5 ui-monospace,Menlo,monospace; max-height:280px; overflow:auto; }
  .tag { display:inline-block; padding:1px 7px; border-radius:999px; background:#eef2ff; color:#3730a3; font-size:11px; font-weight:600; }
  .tag.off { background:#fef2f2; color:#991b1b; }
  .warn { color:var(--amber); }
  .empty { color:var(--sub); padding:40px 0; text-align:center; }
  .bar { position:fixed; left:0; right:0; bottom:0; background:var(--card); border-top:1px solid var(--border); padding:14px 24px; display:flex; gap:10px; justify-content:flex-end; align-items:center; }
  .bar .hint { margin-right:auto; color:var(--sub); font-size:13px; }
  button { font:inherit; font-weight:600; border-radius:9px; padding:10px 18px; cursor:pointer; border:1px solid var(--border); background:var(--card); }
  button.primary { background:var(--green); border-color:var(--green); color:#fff; }
  button.changes { background:#fff; color:var(--amber); border-color:#fcd9a8; }
  dialog { border:none; border-radius:12px; padding:0; max-width:520px; width:92%; box-shadow:0 20px 60px rgba(0,0,0,.25); }
  dialog .dlg { padding:18px 20px; }
  dialog textarea { width:100%; min-height:90px; margin-top:8px; padding:10px; border:1px solid var(--border); border-radius:8px; font:inherit; resize:vertical; }
  dialog .row { display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
  .done { position:fixed; inset:0; display:none; place-items:center; background:rgba(255,255,255,.9); font-size:16px; }
</style></head>
<body>
<header><div class="eyebrow">Review &amp; approve · ${esc(mode === "recruiter" ? "Recruiter" : "Job seeker")}${kind === "speculative" ? " · Speculative" : ""}</div><h1>${esc(title)}</h1></header>
<main>${bodyHtml}</main>
<div class="bar">
  <div class="hint">Review everything above, then approve to continue${isSend ? " — the next step opens your email account to sign in and send." : ", or request changes."}</div>
  <button class="changes" onclick="reqChanges()">Request changes</button>
  <button class="primary" onclick="approve()">${isSend ? "Approve & continue to send" : "Approve"}</button>
</div>
<dialog id="dlg"><div class="dlg"><b>What should be changed?</b>
  <textarea id="notes" placeholder="Describe the changes you want (e.g. tighten the cover letter, drop these employers, fix the recipient)…"></textarea>
  <div class="row"><button onclick="document.getElementById('dlg').close()">Cancel</button>
  <button class="primary" onclick="sendChanges()">Send to the assistant</button></div></div></dialog>
<div class="done" id="done"></div>
<script>
  const STAGE=${JSON.stringify(stage)}, MODE=${JSON.stringify(mode)}, KIND=${JSON.stringify(kind)};
  async function post(action, notes){
    await fetch('/review/action',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({stage:STAGE,action,notes:notes||'',mode:MODE,kind:KIND})}).catch(()=>{});
  }
  async function approve(){ await post('approve',''); showDone('Approved \\u2014 you can close this tab. Continuing to the next stage\\u2026'); }
  function reqChanges(){ document.getElementById('dlg').showModal(); }
  async function sendChanges(){ const n=document.getElementById('notes').value.trim(); document.getElementById('dlg').close(); await post('changes',n); showDone('Sent to the assistant \\u2014 it will revise and re-open this stage.'); }
  function showDone(msg){ const d=document.getElementById('done'); d.textContent=msg; d.style.display='grid'; }
</script>
</body></html>`;
}

export async function startReviewServer(deps: ReviewServerDeps): Promise<number> {
  if (server) return boundPort;
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/review/action") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          try {
            const a = JSON.parse(raw || "{}") as ReviewAction;
            deps.onAction(a);
          } catch {
            /* ignore */
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        });
        return;
      }
      const m = url.pathname.match(/^\/review\/(discover|evaluate|draft|approve|send|track)$/);
      if (req.method === "GET" && m) {
        const stage = m[1] as StageId;
        const mode = url.searchParams.get("mode") || "seeker";
        const kind = url.searchParams.get("kind") || "job";
        const body = await renderStageBody(deps, stage, mode, kind);
        const html = pageHtml(stage, mode, kind, body);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("error");
    }
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      boundPort = (server!.address() as import("net").AddressInfo).port;
      resolve();
    });
  });
  return boundPort;
}

export function reviewUrl(stage: StageId, mode: string, kind: string): string {
  return `http://127.0.0.1:${boundPort}/review/${stage}?mode=${encodeURIComponent(mode)}&kind=${encodeURIComponent(kind)}`;
}

export function stopReviewServer(): void {
  try { server?.close(); } catch { /* ignore */ }
  server = null;
  boundPort = 0;
}
