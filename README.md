# Jobomate

Jobomate is an **AI-driven hiring-and-job-hunt assistant** — a hybrid desktop app combining an
Electron browser shell with a headless C# .NET 8 engine. A connected LLM drives the in-app browser,
drafts tailored messages, and manages the entire pipeline from discovery to sending — all behind a
human approval wall.

It works two ways from a single toggle (top of the Jobomate panel):

- **Job seeker** — find work. Research job postings → draft tailored applications → apply.
- **Recruiter / HR** — find candidates. Source people for a role → draft personalised outreach → reach out.

Both modes share the same pipeline (research → draft → approve → send → track). The mode only flips
the domain framing of the LLM prompts and the UI labels: in recruiter mode the loaded "CV" becomes the
**role brief** you're hiring for, collected rows become **candidates**, and drafts become **outreach**.

## Architecture

```
React UI (Electron)          C# Engine (.NET 8)
┌──────────────────┐         ┌─────────────────────┐
│ Chrome-like tabs │  JSON   │ HTTP :9223           │
│ Jobomate panel   │◄───────►│ Chat · Research      │
│ (chat, jobs,     │  HTTP   │ Draft · Approve      │
│  drafts, send)   │         │ Send · Email · CV    │
│                  │         │                     │
│ Browser bridge   │◄────────│ LmBrowser.cs → :9222 │
│ control :9222    │  JSON   │ (drives browser)     │
└──────────────────┘         └─────────────────────┘
```

- **Electron shell** — LM_Browser fork (tabs, address bar, bookmarks, history) + docked Jobomate panel
- **C# engine** (`Jobomate.App`) — All job-hunt logic, LLM orchestration, browser agent, drafting, approval, sending
- **LLM-agnostic** — 32 providers, 6 connection types, 3 adapters (shared with LM_Browser / MAOS stack)

## Quick Start

```bash
# Electron shell
npm install
npm run build
npm run dev:electron

# C# engine (headless, spawned by the Electron app)
export DOTNET_ROOT="$HOME/.dotnet" && export PATH="$HOME/.dotnet:$PATH"
dotnet build Jobomate.sln
dotnet run --project Jobomate.App -- --engine --port 9223

# Run tests
dotnet test Jobomate.sln   # ~57 C# unit tests
```

## Features

### LLM Research Agent
- **Browser automation** — The LLM drives the in-app browser to search job boards, extract postings, and collect company targets
- **Human-in-the-loop** — Pauses on login walls / CAPTCHAs; never bypasses
- **Multi-source** — Job boards, company career pages, Greenhouse, Lever, API sources (Arbeitnow, Adzuna)
- **Dedup + ranking** — Normalized company+title dedup; start-date × language × recency ranking

### Drafting & Approval
- **Tailored applications** — Per-job email + cover letter grounded in CV facts
- **Honesty guardrails** — Never invents experience; caps language levels; handles role mismatch honestly
- **Company drafting** — Speculative applications to companies without open roles
- **Approval wall** — Draft → Review → Approve/Reject. Only approved drafts can be sent.
- **Edit reverts to Draft** — Re-approval required after editing

### Email & Sending
- **Dry-run by default** — Never sends without explicit configuration
- **Prepare emails** — Opens Gmail in the in-app browser, creates drafts in the mailbox
- **Rate-limited sending** — Min-gap, jitter, max/day, quiet hours
- **SMTP** (MailKit), **Gmail OAuth** (XOAUTH2), **Microsoft 365 Graph**
- **Queue + scheduler** — Enqueue, Schedule, Auto-send toggle

### Data Management
- **Chat threads** — New/Switch/Delete; per-thread job/draft scoping
- **CV loading** — PDF (PdfPig), DOCX, TXT → LLM profile extraction (name, headline, skills, languages)
- **Job management** — Edit, include/exclude, delete, bulk select/delete
- **Draft management** — Edit (role/company/to/subject/body/status), bulk select/delete
- **Preferences** — Search sites, persona profile

## LLM Connection

Jobomate has **two independent LLM layers**:
1. **C# engine LLM** — Powers chat, research, drafting, CV extraction (32 providers)
2. **Electron assistant** — The LM_Browser bridge panel (20 browser tools, same provider stack)

6 connection types: ApiKey · OAuth · LocalServer · LocalAI · CliPipe · Terminal.
Configure in Settings → LLM Connection.

## Engine API Endpoints (JSON over HTTP on :9223)

| Endpoint | Purpose |
|---|---|
| `/api/status` | Full engine status (mode, LLM, CV, browser, queue) |
| `/api/mode` | Switch app mode (`JobSeeker` / `Recruiter`) |
| `/api/chat` | Send a chat message → LLM responds with directives |
| `/api/cv` | Load a CV file (PDF/DOCX/TXT) |
| `/api/research` | Run the browser research agent |
| `/api/jobs` / `/api/companies` / `/api/drafts` | List collections |
| `/api/draft` | Draft tailored applications |
| `/api/approve` | Approve pending drafts |
| `/api/schedule` | Queue approved drafts for sending |
| `/api/send` | Send due items (dry-run safe) |
| `/api/browser/open` | Open URL in the in-app browser |
| `/api/email/prepare` / `/api/email/create-drafts` | Gmail draft creation |
| `/api/threads` | Chat thread CRUD |
| `/api/jobs/delete-bulk` | Bulk delete jobs |
| `/api/drafts/update` | Edit draft fields |

## Project Structure

```
Jobomate/
├── Jobomate.App/           # C# .NET 8 engine
│   ├── Engine/             # EngineServer + JobomateEngine
│   ├── Browser/            # LmBrowser client → :9222
│   ├── Llm/                # 32-provider LLM gateway
│   ├── Drafting/           # Draft generation + guardrails
│   ├── Email/              # SMTP, Gmail OAuth, M365 Graph
│   ├── Filters/            # Language, location, date filters
│   ├── Profile/            # CV extraction + persistence
│   ├── Sources/            # Research sources (API + browser)
│   ├── Scheduling/         # Queue + rate-limiter + quiet hours
│   ├── Approval/           # Approval rules
│   ├── Persistence/        # Thread/Job/Draft storage
│   └── Security/           # CredentialStore (OS keychain)
├── Jobomate.Tests/         # ~57 xUnit tests
├── electron/               # Electron main process (LM_Browser fork)
│   ├── main.ts             # Electron main + engine spawn
│   ├── preload.ts          # IPC bridge
│   ├── llm-server.ts       # Browser control server :9222
│   ├── llm-connection.ts   # Assistant LLM brain
│   └── jobomate-engine.ts  # Engine process management
├── src/                    # React UI
│   ├── components/         # TabBar, AddressBar, SettingsPanel, etc.
│   ├── jobomate/           # JobomatePanel (chat, jobs, drafts)
│   └── stores/             # Zustand state
├── FUNCTIONALITY_STACK.md  # Complete capability map
├── E2E_TEST_REPORT.md      # Test results
└── package.json
```

## Tech Stack

- **Electron + React 18 + TypeScript** — Desktop shell
- **C# .NET 8** — Job-hunt engine (Avalonia standalone also available)
- **Vite** — Build tool
- **Zustand** — State management
- **PdfPig** — PDF text extraction
- **MailKit** — SMTP email
- **QuestPDF** — Cover-letter PDF generation
- **Lucide React** — Icons

## Documentation

- **[FUNCTIONALITY_STACK.md](FUNCTIONALITY_STACK.md)** — Complete capability map with status per feature
- **[E2E_TEST_REPORT.md](E2E_TEST_REPORT.md)** — Latest end-to-end test results
- **[LLM_FUNCTIONALITY_STACK.md](../LLM_FUNCTIONALITY_STACK.md)** — Master cross-repo test plan

## License

MIT
