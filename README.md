# Jobomate

A calm macOS application **command center** (Avalonia / .NET 8). Jobomate finds relevant
jobs or suitable companies, drafts tailored application emails + cover letters, shows
**everything for human approval**, then sends approved applications through your own email
account in a controlled, spaced-out way. Nothing leaves your machine without passing the
**approval wall**.

> Availability is **flexible by default** — the candidate is treated as available anytime, and
> drafts state availability accordingly. You can set a specific start date in the profile if you
> ever want one; only then are earlier-start roles flagged as a *start-date risk*.

## Quick start

`dotnet` lives at `~/.dotnet` on this machine (not on `PATH`). Prefix commands:

```bash
export DOTNET_ROOT="$HOME/.dotnet" && export PATH="$HOME/.dotnet:$PATH"
cd /Users/lukemclaughlin/Documents/GitHub/Jobomate

dotnet build Jobomate.sln          # build everything
dotnet test  Jobomate.sln          # run the test suite (64 tests)
dotnet run --project Jobomate.App   # launch the desktop app
```

First launch opens the **onboarding wizard**: load CV → confirm profile → confirm the
availability (flexible) → connect an LLM → connect email (dry-run by default) → choose a mode.
After that you land on the dashboard (Candidate · Search & Results · Drafts & Approval ·
Queue & Tracker · Settings · Audit).

### Optional one-time setup
- **Browser-assisted extraction** (LinkedIn/Indeed/Glassdoor/StepStone, logged-in & present):
  ```bash
  pwsh Jobomate.App/bin/Debug/net8.0/playwright.ps1 install chromium
  ```
- **Package a macOS `.app`** (self-contained, carries the logo icon):
  ```bash
  scripts/package-macos.sh osx-arm64   # → dist/Jobomate.app
  ```

## Three LLM setup menus
1. **Cloud API** — OpenAI, Anthropic, Google AI, OpenRouter, Mistral, Groq, DeepSeek, Together,
   xAI (keys stored in the macOS Keychain; connection test included).
2. **Local server** — auto-detects Ollama (`127.0.0.1:11434`) and LM Studio (`127.0.0.1:1234/v1`),
   lists models, custom OpenAI-compatible endpoints, connection test.
3. **Local GGUF** — pick a `.gguf` file; runs it on a loopback OpenAI-compatible endpoint via the
   bundled `llama-server` pattern; context-size setting. Models are never auto-downloaded.

## Job & company sources (in access-priority order)
Public APIs (**Arbeitnow**, **Remotive**, **Adzuna**¹, **Bundesagentur für Arbeit**) →
**Greenhouse**/**Lever** boards → company **career pages** + ATS (Greenhouse/Lever/Personio/Workday)
via JSON-LD → **user-provided URLs** → **browser-assisted** extraction² (LinkedIn/Indeed/Glassdoor/
StepStone/Wellfound/Otta) → **manual import** (CSV / pasted text / saved HTML). An offline **sample
source** lets you exercise the whole flow with no keys or network. Scraping respects logins/CAPTCHAs/
anti-bot — blocked roles become *“manual portal application required.”*

## Safety
- **Dry-run is the default** until you successfully test a real account.
- Nothing is scheduled or sent unless its draft is **Approved**; editing/regenerating a draft
  forces re-approval.
- Sending limits: **≤8/day**, **≥25 min apart**, **+5–15 min jitter**, **quiet hours 20:00–08:00
  Europe/Berlin**; the queue **stops immediately** on auth errors, throttling, bounces, or repeated
  failures (pause/resume/cancel controls).
- Secrets live **only in the macOS Keychain** (`com.jobomate.credentials`); logs are redacted.
- Generated text uses **only CV facts**, never claims German fluency (intermediate only), and never
  mentions layoffs, health, or private circumstances.

Local data lives under `~/Library/Application Support/Jobomate` (SQLite + documents + cover-letter
PDFs + audit JSONL + browser profile). Set `JOBOMATE_DATA_DIR` to relocate it and
`JOBOMATE_DISABLE_KEYCHAIN=1` to use an in-memory secret store (tests/CI).

¹ Adzuna needs a free `app_id`/`app_key` (entered in settings). ² Needs the Playwright Chromium install above.
Cloud OAuth email (Gmail/Microsoft) needs your own registered OAuth client id; SMTP works without that.
Local GGUF needs a `llama-server` binary present (e.g. `brew install llama.cpp`).

## Tested behaviors (`Jobomate.Tests`, 64 tests)
LLM config validation · local endpoint normalization · GGUF path validation · CV-parse fallback ·
dedup · strict language filtering (English-only excludes German-required; preferred never excludes;
unclear handled per setting; evidence required) · remote/hybrid/on-site filtering · ranking respects
configurable availability · prompts state availability and exclude forbidden topics · no send before approval ·
rate-limiter spacing · quiet hours · dry-run records-not-sends · secrets redacted · failed sends
stop/pause the queue · real PDF cover-letter generation · SQLite round-trip.

Infrastructure ported from `MultiAgentOS_Mac_OS` is documented in [REUSE_MAP.md](REUSE_MAP.md).
