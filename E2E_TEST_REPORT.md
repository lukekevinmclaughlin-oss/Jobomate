# Jobomate — End-to-End Test Report (LLM-driven functionality)

**Date:** 2026-06-15 — closed the 5 remaining known issues + stabilisation pass (see the 2026-06-15 section below)
**Previous test:** 2026-06-08 — DeepSeek (`deepseek-chat`), connected; email dry-run; live engine HTTP API
**This audit:** Live endpoint E2E (isolated engine) + new unit tests + build/typecheck verification + bug fixes

## Verdict

**The connected LLM can perform every core task in the functionality stack.** All ✅ rows in
`FUNCTIONALITY_STACK.md` verified. **5 of 6 previously documented UI gaps are now CLOSED**
(CV-attach, Schedule, Auto-send, Company-drafting, GGUF/CLI/Terminal settings).
The remaining gaps are: FitScore (always 0), no tracker/cost-breakdown panel, no explicit
cover-letter-PDF button.

## Build Status

| Component | Result | Detail |
|---|---|---|
| Electron shell (`npm run build`) | ✅ PASS | 1619 modules, 945ms |
| C# engine (`dotnet build`) | ⚠️ Not run | `dotnet` not in env; codebase verified |
| C# tests (`dotnet test`) | ⚠️ Not run | 57 facts/theories across 9 test files verified |

## Previous Live Test Results (2026-06-08, still valid)

| # | Capability | Result | Evidence |
|---|---|---|---|
| 1 | **LLM connection** | ✅ PASS | `connected:true, model:deepseek-chat`; every LLM call succeeded |
| 2 | **Chat (general)** | ✅ PASS | "I can help you research… draft… manage Gmail drafts… approvals and sending" |
| 3 | **Directive emission** | ✅ PASS | "find backend jobs" → `actions:[research]`; "draft those" → `actions:[draft]` |
| 4 | **Name policy** | ✅ PASS | greeted **"Hi —"** (not "Hi Jordan") despite a CV loaded; no forced name |
| 5 | **Threads: new / switch / delete** | ✅ PASS | new→active+empty; switch persists; `delete → {deleted:1}` |
| 6 | **Per-thread job/draft scoping** | ✅ PASS | new thread shows 0 jobs; switching to a populated thread shows exactly its 2 |
| 7 | **CV load + LLM extraction** | ✅ PASS | loaded a *different-name* CV → extracted `name:"Alex Morgan", headline, location, skills 7/7` |
| 8 | **Browser research agent (LLM-driven)** | ✅ PASS | 38 clean postings in 1 step from an open job board |
| 9 | **Job management** (edit / include / delete / bulk) | ✅ PASS | edit title ✅, include-toggle ✅, delete 38→37 ✅, bulk-delete →35 ✅ |
| 10 | **Drafting (LLM, tailored + grounded)** | ✅ PASS | per-job subject+body grounded in CV; honest about role mismatch — guardrails working |
| 11 | **Draft management** (edit / bulk-delete) | ✅ PASS | edit subject+status→Approved ✅; delete-all 2→0 ✅ |
| 12 | **Approval** (batch) | ✅ PASS | `approve → {approved}`; `draftsApproved:2, draftsPending:0` |
| 13 | **Send pipeline** (schedule → queue → send-due, dry-run) | ✅ PASS | `schedule → {scheduled:1}`, `queued:1`; `send → {dryRun:true}` |
| 14 | **Email prepare / Gmail drafts** | ✅ PASS | opens Gmail; graceful on no-recipient / not-signed-in |
| 15 | **Browser control** (open / status / resume) | ✅ PASS | `open example.com → {ok:true}`, status + resume correct |
| 16 | **Preferences** (sites / persona) | ✅ PASS | both persist and appear in `/api/status` |
| 17 | **Filters / ranking** | ✅ PASS (indirect) | research returned ranked jobs with `included` flags; C# unit tests cover deterministic logic |
| 18 | **Privacy / clear data** | ✅ (code-verified) | Electron IPC; isolated browsing partition confirmed |

## UI Gap Closure Verification (2026-06-10)

Per `LLM_FUNCTIONALITY_STACK.md` §9, these gaps were documented as open. Verified closed:

| Gap | Previous status | Current status | Evidence |
|---|---|---|---|
| CV-attach button in React panel | 🔧 Missing | ✅ **CLOSED** | `attachCv()` handler + "Attach CV" button in `JobomatePanel.tsx:345` |
| Schedule button | 🔧 Missing | ✅ **CLOSED** | `scheduleSend()` handler + "Schedule" button in `JobomatePanel.tsx:407` |
| Auto-send toggle | 🔧 Missing | ✅ **CLOSED** | `autoSend` state + checkbox toggle in `JobomatePanel.tsx:411` |
| Company-drafting UI | ⚙️ Chat/API only | ✅ **CLOSED** | `draft("company", ids)` + company rows + delete/edit in `JobomatePanel.tsx` |
| GGUF/CLI/Terminal Settings | 🔧 Missing | ✅ **CLOSED** | CliPipe, Terminal, LocalAI (GGUF path) fields in `SettingsPanel.tsx` |

## 2026-06-15 — Remaining Known Issues CLOSED + stabilisation pass

All 5 previously-remaining known issues are now implemented and verified (endpoints live-tested
against a headless engine in an isolated `JOBOMATE_DATA_DIR`; deterministic logic locked with new
unit tests). LLM-dependent output *quality* (scoring/drafting) relies on the 2026-06-08 live run.

| # | Was | Now | Evidence |
|---|---|---|---|
| 1 | Job `FitScore` always 0 | ✅ LLM fit scoring | `/api/jobs/score` + `/api/jobs/score-all`; per-job "Score fit" + toolbar "Score"; `Fit: n%` badge. Parser unit-tested (`FitScoreTests`) |
| 2 | No application-tracker panel | ✅ Tracker tab | `/api/tracker` + `/api/tracker/update`; 4th results tab with per-status dropdown |
| 3 | No per-call cost breakdown | ✅ Cost ledger panel | `/api/costs`; header `$` button opens per-call ledger + totals |
| 4 | No cover-letter-PDF button | ✅ Per-draft button | `/api/drafts/cover-letter-pdf` (QuestPDF); `FileDown` button on each draft row |
| 5 | `.docx/.rtf` CV not parsed | ✅ Parsed | `CvTextExtractor` unzips `word/document.xml` (DOCX) + strips RTF control words; `.doc` returns empty (unsupported). Unit-tested |

### Bug fixes in this pass

- **Tracker thread-scoping** — `ApplicationRecord` gained a `ThreadId`, now populated from the draft in
  both `UpsertRecord` sites and filtered in `Tracker()`, so the Tracker tab is per-chat like Jobs/Drafts/Companies
  (was global). Covered by `SchedulingTests.SendRunner_TracksApplication_UnderDraftThread`.
- **Notes wipe** — the status dropdown sent no `notes`, and the route used the non-null getter, so every
  status change overwrote `Notes` with `""`. Route now uses the nullable getter (`SN`); absent notes are left unchanged.
- **`SendRunner` self-assignment** — removed `record.EmailDraftId = record.EmailDraftId;` no-op.
- **Fit-score prompt** — literal `\n` escapes replaced with real newlines; scoring refactored so
  `ScoreAllJobs` counts only *successful* scorings; dead `email` local removed; blank-cover-letter guard added.
- **Live tracker** — frontend now `refreshData()` after manual + auto sends so the Tracker tab stays current.

### Test status (2026-06-15)

| Suite | Result |
|---|---|
| C# (`dotnet test`) | ✅ **91 passed** (was 80; +11 for CV docx/rtf, fit-score parsing, tracker thread-scoping) |
| Frontend (`vitest`) | ✅ 41 passed |
| Frontend typecheck (`tsc --noEmit`) | ✅ clean |
| Production build (`npm run build`) | ✅ 1620 modules |
| C# build (`dotnet build`) | ✅ 0 errors (5 pre-existing Avalonia deprecation warnings in `AssistantView.axaml.cs`, unrelated) |

## 2026-06-15 — Dual-purpose: recruiter / HR mode added

Jobomate is now multipurpose. A header toggle switches between **Job seeker** (find work) and
**Recruiter** (find candidates). The mode is a prompt + label + research-goal switch with **no
data-model fork** — the same pipeline (research → draft → approve → send → track) is reused, with the
"CV" reinterpreted as a **role brief**, collected rows as **candidates**, and drafts as **outreach**.

| Layer | What changes in recruiter mode | Verified |
|---|---|---|
| Mode state | `AppMode` enum + `SearchPreferences.Mode`; `/api/mode` GET (via status) + POST; persisted | ✅ live: switch, ignore-bogus, **persists across engine restart** |
| Chat brain | `BuildMessages` reframes the system prompt + directive descriptions (source candidates / draft outreach) | ✅ build + structural |
| Research | `BrowserAgent` goal/strategy/`kind` → sources people; default start URL → people search; `"candidates"` routes to the generic row extractor | ✅ build; live graceful-without-LLM |
| Drafting | `DraftPromptBuilder` flips to candidate-outreach / role-overview with recruiter guardrails (never invent candidate facts, respect privacy) | ✅ unit-tested (`RecruiterModeTests`) |
| Role brief | `BuildFromCvAsync` extraction prompt becomes role-oriented in recruiter mode | ✅ build |
| UI | Header mode toggle + adaptive labels (Jobs↔Candidates, Draft↔Draft outreach, Attach CV↔Load role brief, intro/empty states/toasts) | ✅ tsc + vitest + build |

New tests: `RecruiterModeTests` (default mode, outreach-vs-application framing, recruiter guardrails,
role-overview vs cover-letter) → C# suite now **95 passing**.

### Still open / notes

- `.doc` (legacy binary Word) uploads return empty text (needs Word Interop / Tika) → seed-profile fallback, by design.
- `ScoreAllJobs` scores every job in the thread sequentially (one LLM call each) — no cap; can be slow/costly on large threads.
- Tracker is intentionally **per-chat** (consistent with sibling tabs). Flip to global by dropping the `ThreadId` filter in `Tracker()` if a cross-search tracker is preferred.

## Engine API Endpoints (all verified present)

| Endpoint | Purpose | Status |
|---|---|---|
| `/api/status` | Full engine status | ✅ |
| `/api/chat` | Send chat message | ✅ |
| `/api/cv` | Load CV file | ✅ |
| `/api/research` | Run browser research agent | ✅ |
| `/api/jobs` / `/api/companies` / `/api/drafts` | List collections | ✅ |
| `/api/draft` | Draft applications (`kind: job\|company`) | ✅ |
| `/api/approve` | Approve drafts (batch) | ✅ |
| `/api/schedule` | Queue for sending | ✅ |
| `/api/send` | Send due items (dry-run safe) | ✅ |
| `/api/browser/open` | Open URL in browser | ✅ |
| `/api/email/prepare` / `/api/email/create-drafts` | Gmail draft creation | ✅ |
| `/api/threads` | Thread CRUD | ✅ |
| `/api/sites` / `/api/persona` | Preferences | ✅ |
| `/api/llm/connect` / `/api/llm/config` | LLM configuration | ✅ |

## C# Test Suite

9 test files, 57 `[Fact]`/`[Theory]` attributes:
- ConnectionPlumbingTests.cs, DraftingTests.cs, FilterTests.cs, LlmConnectionTests.cs,
  PersistenceTests.cs, ProfileTests.cs, SchedulingTests.cs, SmokeTests.cs, SourceTests.cs

---

*Previous live test: 2026-06-08 with DeepSeek chat. This re-verification: 2026-06-10.*
*Electron shell builds green. C# codebase structurally verified. 5 of 6 documented UI gaps now closed.*
