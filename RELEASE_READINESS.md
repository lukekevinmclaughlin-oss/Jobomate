# Jobomate — Release-Readiness Checklist & Engineering Log

**Product:** Jobomate — AI-driven hiring/job-hunt assistant (dual-purpose: job seeker + recruiter/HR)
**Type:** Desktop app — Electron + React/TypeScript shell over a headless C# .NET 8 engine (loopback HTTP on `:9223`)
**Targets:** macOS, Windows (electron-builder; Linux also configured)
**Audit started:** 2026-06-16 · **Baseline commit:** `0643526`

This is the living release-readiness document. Status legend: ✅ done · 🟡 partial / acceptable with caveat · 🔲 open · ⛔ blocked on external input.

---

## Baseline (measured 2026-06-16)

| Check | Command | Result |
|---|---|---|
| C# build | `dotnet build Jobomate.sln` | ✅ 0 errors (5 pre-existing Avalonia deprecation warnings in `AssistantView.axaml.cs`) |
| C# tests | `dotnet test Jobomate.sln` | ✅ 95 passed |
| Frontend typecheck | `npx tsc --noEmit` | ✅ clean |
| Electron typecheck | `npx tsc -p tsconfig.electron.json` | ✅ clean |
| Frontend tests | `npx vitest run` | ✅ 41 passed |
| Production build | `npm run build` | ✅ 1620 modules |
| Lint | `npm run lint` | ❌ → ✅ eslint 9 flat config added; 0 errors/0 warnings |
| Dependency audit | `npm audit` | 🟡 16 → 15 after safe `npm audit fix`; remaining are **all dev/build tooling** (electron-builder/node-gyp/vite/esbuild/concurrently), none in shipped runtime deps, only fixable via breaking `--force` |
| Engine token | live curl | ✅ 401 without/invalid token, 200 with, no CORS wildcard when gated; open without env (dev) |
| CI | `.github/workflows/ci.yml` | ✅ added (engine build+test; frontend lint+typecheck×2+test+build) |

---

## Release-readiness checklist

### Critical functional correctness
- 🟡 Core engine endpoints live-tested (status, jobs, drafts, score, tracker, costs, cover-letter-PDF, mode). LLM-dependent output quality relies on a connected model.

### Core user workflows
- ✅ Job seeker: research → draft → approve → send (dry-run safe) → track
- ✅ Recruiter: source candidates → draft outreach → approve → send → track
- ✅ Mode toggle persists across engine restart

### Data integrity
- ✅ Per-chat scoping for jobs/companies/drafts/tracker (tracker thread-scoping fixed `0643526`)
- ✅ Approval gate: only Approved drafts can be sent; editing reverts to Draft

### Authentication & authorization
- ✅ Loopback engine API now requires a per-session token (this pass) — was unauthenticated
- ✅ LLM provider keys in OS keychain; email OAuth via system flow

### Security
- ✅ Electron: contextIsolation on, nodeIntegration off, sandbox on browser views, loopback-only servers
- ✅ `shell.openExternal` restricted to http/https; popups denied (open as tabs); WS origin allowlist
- ✅ Engine token auth closes cross-origin localhost data-exfil / action-trigger (this pass)
- ✅ `SecretRedactor` scrubs secret shapes from logs
- 🟡 npm audit: dev/build-tooling advisories only (documented)

### Privacy
- ✅ Isolated browsing partition; clear-browsing-data IPC; CV/profile stored locally only

### Error handling & resilience
- ✅ Engine wraps handlers, returns `{error}` + 500; React ErrorBoundary; UI surfaces failures
- ✅ Engine accept-loop dispatches to thread pool so one slow handler can't stall it

### Input validation
- 🟡 Engine getters coerce types; token boundary added this pass. Trusted local boundary (single user).

### Performance
- 🟡 Bundle ~243 KB JS gzipped ~71 KB; lists capped at 300 rows; acceptable for desktop.

### Accessibility
- 🟡 Mode toggle has `role=group`/`aria-label`/`title`; broader a11y pass is future work (documented).

### UX polish
- ✅ Loading/empty/error states across panels; mode-adaptive labels; dry-run badge

### API contract correctness
- ✅ api.ts types match engine responses; endpoints verified live

### Database correctness
- ✅ SQLite via repository pattern; per-entity repos; no migrations (single-file local store)

### Test coverage
- ✅ 95 C# + 41 frontend; covers scoring parse, CV extraction, scheduling, drafting, recruiter framing

### Build & packaging
- 🟡 `electron-builder` configured (mac/win/linux). `npm run build` green. Packaging needs the engine binary built (`scripts/build-engine.sh`).

### Deployment readiness
- ⛔ Code signing / notarization: `identity: null` (unsigned) — needs paid Apple Developer + Windows cert (external blocker, documented)

### Observability
- 🟡 Engine logs to stdout/stderr; secret-redacted. No remote telemetry (by design, privacy-first).

### Documentation
- ✅ README (setup/build/test/architecture), FUNCTIONALITY_STACK, E2E_TEST_REPORT, this file; env vars documented

### Legal / compliance
- ✅ MIT LICENSE present. 🟡 Recruiter mode touches candidate PII — outreach guardrails + privacy note added.

### Release notes & operational handoff
- 🔲 Tag a release + notes once signing is resolved (see Next steps)

---

## Engineering log

### 2026-06-16 — Release-readiness pass
- **Inspected:** repo structure, Electron main/preload/llm-server/engine-spawn, C# engine server + handlers, security flags, CORS/auth, npm audit, lint, CI, TODO/placeholder scan.
- **Initial failures:** `npm run lint` (eslint not installed); no CI; engine API unauthenticated with CORS `*`.
- **Fixed this pass:**
  1. **P1 security** — engine session-token auth (`JOBOMATE_ENGINE_TOKEN`): generated in Electron main, passed to the engine env + exposed to the renderer via `jobomate:engine-info` IPC; `api.ts` sends `X-Jobomate-Token` on every call; engine returns 401 without it and drops the wildcard CORS header when gated. Constant-time compare. Unit-tested (`EngineAuthTests`) + live curl matrix.
  2. **Lint** — added eslint 9 flat config + `typescript-eslint`; fixed 6 real issues (case-decl, const, unused-expr ternary, 2 dead imports) and relaxed 2 intentional patterns (ANSI control-regex, `import =` under esModuleInterop:false). `npm run lint` now 0/0.
  3. **CI** — `.github/workflows/ci.yml` runs the C# build+test and the frontend lint+typecheck(×2)+test+build on push/PR.
  4. **Docs** — README Configuration (env vars), Security, and Building/Signing sections; fixed stale test count; this checklist.
  5. **Deps** — safe `npm audit fix` (16→15); remaining are dev/build-only, documented.
- **Verification:** C# 101 tests, frontend 41 tests, lint 0/0, renderer+electron tsc clean, production build green.
- **Risks remaining:** code signing/notarization (external — paid certs); broader a11y audit (future); LLM-output quality depends on a connected model; recruiter browser-sourcing reuses the generic page extractor.
