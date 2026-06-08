# Jobomate — Full Functionality Stack (with a connected LLM)

> What the software is **supposed to be capable of** when an LLM is connected, derived from the
> actual code (engine `JobomateEngine`/`EngineServer`, `BrowserAgent`/`LmBrowser`, the C# service
> stack, the Electron shell, and the React `JobomatePanel`/`SettingsPanel`).

**Architecture in one line:** one Electron app (the Jobomate / LM_Browser shell) renders a real
Chrome-like browser **plus** a docked Jobomate panel; a headless **C# engine** (spawned by the app,
HTTP on `127.0.0.1:9223`) runs all the logic and drives the in-app browser over the control server
on `127.0.0.1:9222`. The **same connected LLM** powers chat, browser research, and drafting — and it
is **provider-agnostic** (any of the 6 connection types below).

### Status legend
- ✅ **End-to-end** — usable today via a button or a chat directive in the merged app.
- ⚙️ **Engine-wired** — works via a chat `[[ACTION:…]]` directive or the HTTP API, but has **no dedicated button** yet.
- 🔧 **Backend-only** — the C# capability exists but there is **no path through the merged app** yet (a gap).

---

## 1. LLM Connection Layer — the provider-agnostic brain
The LLM is the engine that drives chat, the browser agent, CV extraction and drafting. One connection, used everywhere.

| Capability | LLM's job | Status |
|---|---|---|
| **6 connection types** — API Key · Local Server (OpenAI-compatible) · Local AI (GGUF/llama.cpp) · CLI Pipe · Terminal · OAuth | Resolve config → adapter (OpenAI-compatible / Anthropic / Google AI / CLI) | ✅ (full multi-tab form in Settings) |
| **~30 API-key providers** — OpenAI, Anthropic, Google AI, Groq, DeepSeek, Together, Mistral, xAI, OpenRouter, Perplexity, Fireworks, HuggingFace, Azure OpenAI, NvidiaNim, SambaNova, Moonshot, … Custom | Map provider → endpoint/model/auth | ✅ |
| **Connect / Disconnect / Test connection** | Sends a probe ("Reply with OK"), reports status | ✅ |
| **OAuth sign-in** (Google Vertex / Azure / HuggingFace / Custom, PKCE loopback) | Runs the OAuth flow, stores/refreshes tokens | ✅ |
| **Cost & token ledger** | Records tokens + USD per call | ⚙️ (sum shown in status; no per-call breakdown UI) |
| **Reasoning-effort / Fast mode** (o1, Claude, DeepSeek-R1) | Maps Low/Med/High → provider value | ⚙️ |
| **Local GGUF runtime** (bundled `llama-server`) | Validates path, serves model on loopback | 🔧 (no GGUF path picker in the React UI yet) |
| **CLI / Terminal pipe** (`ollama run llama3 {prompt}`, stdin) | Runs the shell command, returns output | 🔧 (no command field in the React UI yet) |
| **Env-var key injection** (`JOBOMATE_LLM_KEY`) | Headless/dev key without Keychain | ⚙️ |

---

## 2. Conversational Assistant Layer — chat + tool directives
Free-form chat on any topic. When the user clearly wants an action, the LLM appends an `[[ACTION:…]]`
directive on its own line; the app parses it and runs the matching tool.

| Capability | LLM's job | Status |
|---|---|---|
| **Natural chat** | Answer anything, naturally | ✅ |
| **Directive protocol** `[[ACTION:verb]]` | Decide *when* a tool is wanted and emit the directive | ✅ |
| `[[ACTION:research]]` / **Recent jobs** | Drive the browser to collect job postings | ✅ |
| `[[ACTION:companies]]` / **Companies** | Drive the browser to collect companies (speculative apps) | ✅ |
| `[[ACTION:list]]` | Show already-collected items (don't re-search) | ✅ |
| `[[ACTION:draft]]` / **Draft** | Draft tailored applications | ✅ |
| `[[ACTION:approve]]` / **Approve** | Approve pending drafts | ✅ |
| `[[ACTION:prepare]]` / **Prepare emails** | Open Gmail + create drafts in the user's mailbox | ✅ |
| `[[ACTION:send]]` / **Send** | Send due items (dry-run unless a real account is connected) | ✅ |
| `[[ACTION:settings]]` | Hint the user to open Settings | ⚙️ (hint only; no auto-open) |

**Chat threads**
| Capability | Status |
|---|---|
| **New Chat** (fresh thread, empty jobs/drafts) | ✅ |
| **Chats** dropdown — switch · multi-select · select-all · right-click delete · per-row delete | ✅ |
| **Per-thread history** (persisted to the thread) | ✅ |
| **Jobs & drafts auto-scope to the active chat** | ✅ |

---

## 3. Candidate Profile / CV Layer
The CV is the LLM's source of truth for personalisation; guardrails stop it inventing experience.

| Capability | LLM's job | Status |
|---|---|---|
| **Load CV** (PDF via PdfPig / TXT) → text | — (extraction) | 🔧 **no CV picker in the merged React UI** — `/api/cv` exists, but nothing calls it from the app yet |
| **LLM profile extraction** (name, headline, location, skills, languages) | Read CV text → structured profile JSON | ✅ (runs when a CV is loaded) |
| **Honesty guards** (e.g. cap claimed language levels) | — | ✅ |
| **Name policy** — use the name **only** from a genuinely-attached CV; no CV ⇒ no name; never force "Hi <name>" | Obey the system-prompt rule | ✅ |
| **Profile persistence** | — | ✅ |

> ⚠️ **Gap that affects testing:** there is currently **no way to attach a CV from inside the merged app** (the old Avalonia UI had an Attach button; the React UI doesn't). The persisted "Jordan Avery" test profile is still treated as the attached CV.

---

## 4. In-App Browser Layer — the "LLM Browser"
A real Chrome-like browser (Electron `BrowserView` tabs) that the user and the LLM share.

| Capability | LLM's job | Status |
|---|---|---|
| **Tabs, address bar, bookmarks, history, downloads, settings** | — | ✅ |
| **JSON-RPC control server** (`:9222`) — navigate / execute-JS / click / fill / scroll / get-url / screenshot | The engine drives the browser through this | ✅ |
| **Human-in-the-loop** — pauses on login/CAPTCHA, never bypasses; user resumes | Detect blocker → flag `needsUser` → wait for Resume | ✅ |
| **Isolated browsing session** (own partition, separate from app data) | — | ✅ |

---

## 5. Research Layer — the LLM browser-automation agent
The connected LLM **drives the browser in a loop**: observe page → decide an action → act/extract → repeat.

| Capability | LLM's job | Status |
|---|---|---|
| **Observe → decide → act loop** (≤18 steps) | Read a page snapshot, output the next JSON action | ✅ |
| **Actions:** navigate · click · type(+Enter) · scroll · back · extract · finish | Choose & parameterise each | ✅ |
| **Job-posting extraction** (JSON-LD + heuristic DOM), dedup, map → `JobPosting` | Decide when to extract | ✅ |
| **Company extraction** → `CompanyTarget` (unsolicited) | Same loop, company goal | ✅ |
| **Target count + early finish** | Self-regulate using "X/Y collected, step N/18" | ✅ |
| **Provider-agnostic** | Identical loop on any of the 6 connection types | ✅ |
| **Non-browser API sources** — Arbeitnow / Adzuna / Greenhouse / Lever / career-page / URL-import / mock | — (deterministic) | ⚙️ (used by the search service; the merged UI's primary path is the browser agent) |

---

## 6. Filtering & Ranking Layer
Applied after collection; mostly deterministic, with the LLM doing language classification.

| Capability | LLM's job | Status |
|---|---|---|
| **Language classification** — extract required/preferred languages, **must quote evidence** or it's dropped | Read posting → languages + evidence | ⚙️ |
| **Strict language filter** (Accepted languages; strict / include-unclear / preferred-mismatch / show-all-flag) | — | ✅ |
| **Work-location filter** (Remote/Hybrid/OnSite/Unclear) | — | ✅ |
| **Start-date risk** (ASAP vs availability) | — | ✅ |
| **Dedup** (normalised company+title) | — | ✅ |
| **Ranking** (start-date × language × confidence × recency) | — | ✅ |
| **Fit scoring** | — | 🔧 job `FitScore` is a placeholder (always 0); only **company** research sets a fit score |

---

## 7. Drafting Layer — tailored applications
| Capability | LLM's job | Status |
|---|---|---|
| **Tailored application email** (subject + body), grounded in CV facts | Write it | ✅ |
| **Tailored cover letter** | Write it | ⚙️ (generated + stored; the React UI shows the **email** body, not the cover letter) |
| **Unsolicited (company) drafting** | Write a speculative letter | ⚙️ (engine supports `kind=company`; the **Draft** button only does jobs) |
| **Content guardrails** — strip forbidden topics, cap language levels, fill placeholders | — | ✅ |
| **Offline fallback** (template) when no/failed LLM | — | ✅ |
| **Cover-letter PDF** (QuestPDF) | — | 🔧 (renderer exists; no UI to produce it) |

---

## 8. Approval Layer
| Capability | Status |
|---|---|
| **Approve / Reject** single + **batch** | ✅ |
| **Status pills** Draft / Approved / Rejected / Paused | ✅ |
| **Hard gate** — only Approved drafts can be sent | ✅ |
| **Edit reverts to Draft** (re-approval required) | ⚙️ |

---

## 9. Email & Sending Layer
| Capability | Status |
|---|---|
| **Dry-run sender** (default, never sends) | ✅ |
| **Prepare emails → create Gmail drafts** (open Gmail in the in-app browser; user signs in; app fills the compose form) | ✅ (Prepare emails button) |
| **Send due items** | ✅ (Send button → SendRunner) |
| **SMTP** (MailKit / app-password) | ⚙️ (configured in Settings → Email; tested before live) |
| **Gmail OAuth** (XOAUTH2) | ⚙️ |
| **Microsoft 365 Graph** (`/me/sendMail`) | ⚙️ |
| **Attachments** (CV / cover-letter PDF) | 🔧 |
| **Error classification** (Auth / Throttle / Bounce / Transient → queue policy) | ⚙️ |

---

## 10. Scheduling & Automation Layer
| Capability | Status |
|---|---|
| **Send queue + scheduler** (`Enqueue` → `ScheduledAt`) | 🔧 (no **Schedule** button in the merged UI) |
| **Rate limits** — min-gap, jitter, max/day, **quiet hours** | ⚙️ (applied by the runner; not edited in the merged UI) |
| **Auto-send vs manual** (queue Pause / Resume / Cancel) | 🔧 (engine state machine; no UI controls yet) |

---

## 11. Tracking & Audit Layer
| Capability | Status |
|---|---|
| **Application tracker** (`ApplicationRecord`: Drafted → Approved → Queued → Sent → …) | ⚙️ (updated by the engine; no tracker panel in the merged UI) |
| **Audit log** (every approval / send / error) | ⚙️ |

---

## 12. Data Management Layer (jobs / drafts / threads)
| Capability | Status |
|---|---|
| **Jobs:** view (per chat) · edit · include/exclude · delete · **select-all / multiselect / delete-selected / delete-all** | ✅ |
| **Drafts:** view (per chat) · edit (role/company/to/subject/body/status) · delete · **bulk select/delete** | ✅ |
| **Threads:** new · switch · delete (single/multi/right-click) | ✅ |

---

## 13. Privacy & Security Layer
| Capability | Status |
|---|---|
| **Isolated browsing session** (clearing it never wipes app settings/jobs) | ✅ |
| **Clear browsing data** — history · cookies/logins · cache · site data · downloads | ✅ (Settings → Privacy & data) |
| **Credential storage** — macOS Keychain (no plaintext) | ⚙️ (used; masked in UI) |
| **Resizable panes** — browser↔panel, chat↔jobs, message-box height (persisted) | ✅ |

---

## End-to-end "happy path" the LLM should run (the headline test)
1. **Connect an LLM** (Settings → LLM) → status shows the model, green dot.
2. *(Attach a CV — currently only possible outside the merged UI; see gap.)*
3. **Chat** "find recent backend jobs" → LLM replies **and** emits `[[ACTION:research]]`.
4. **Research** → the LLM drives the in-app browser; on any login/CAPTCHA it **pauses** and waits; postings land in **Jobs**, scoped to this chat.
5. **Manage** jobs — edit/exclude/delete, bulk-delete.
6. **Draft** → LLM writes a tailored email per included job → **Drafts** tab.
7. **Approve** → drafts go Draft → Approved.
8. **Prepare emails** → Gmail opens, user signs in, drafts are created in the mailbox.
9. **Send** → due items send (dry-run unless a real email account is connected).
10. **New Chat / Chats** → switch context; each chat keeps its own jobs/drafts.

---

## Known gaps in the **current merged UI** (so testing targets reality)
1. **No CV-attach button** in the React app (`/api/cv` exists; nothing calls it). The "Jordan Avery" test profile is still loaded.
2. **No Schedule button / auto-send controls / queue pause-resume** surfaced (engine has them).
3. **Unsolicited (company) drafting** only via chat/API — the **Draft** button is job-only.
4. **Cover-letter text & PDF** generated but not shown/produced in the React UI (only the email body is shown).
5. **Application-tracker panel** and **per-call cost breakdown** not surfaced.
6. **Job fit-scoring by the LLM** not implemented (job `FitScore` always 0; ranking still works on the other signals).
7. Local **GGUF / CLI / Terminal** connection fields not in the React Settings form yet (API-key + OAuth are).

---

*Generated from the codebase on 2026-06-08. Use this as the test matrix: each ✅ row is directly
verifiable in the running app; ⚙️ rows are verifiable via chat directive or the engine HTTP API; 🔧
rows are not yet reachable through the merged app.*
