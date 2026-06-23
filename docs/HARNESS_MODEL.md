# The Jobomate agent model — reasoning engine + harness

This document explains the mental model the Jobomate assistant is built around,
and points at the code that makes it real. The canonical, machine-readable
source of truth is
[`electron/harness/capabilityModel.ts`](../electron/harness/capabilityModel.ts);
the connected LLM can fetch the same information at runtime by calling the
`describe_harness` tool.

## Two layers, one agent

An agent's impressive behaviour comes from the **combination** of two layers,
not from the model alone:

### The LLM is the reasoning engine

It interprets prompts, reasons over context, writes text and code, decides which
actions to take, and chooses when to call tools. It supplies **reasoning and
generation**.

### The harness is the execution & capability layer — this is Jobomate

It gives the model access to the in-app browser, git/GitHub, an approval gate,
attachment context, and external systems. It supplies **action, memory, tools,
integrations, permissions, retrieval, and environment control**.

> The LLM supplies reasoning and generation, while the harness supplies action,
> memory, tools, integrations, permissions, retrieval, and environment control.
> The impressive agent behaviour comes from the combination, not from the model
> alone.

In Jobomate specifically:

- The reasoning engine is the connected model, driven through
  [`electron/llm-connection.ts`](../electron/llm-connection.ts) /
  [`electron/llm-server.ts`](../electron/llm-server.ts).
- The harness is everything else: the browser bridge tools in
  `llm-connection.ts`, the ported tool modules under
  [`electron/tools/`](../electron/tools) (the GitHub toolkit + the
  `describe_harness` introspection tool), the approval gate wired in
  [`electron/main.ts`](../electron/main.ts), and the attachment context in
  [`electron/attachments.ts`](../electron/attachments.ts).

Jobomate is a **browser-automation shell**: it ships the ~20 `browser_*` tools
and (now) the purpose-built `github_*` toolkit, but it has **no** dedicated
file / exec / web / document tools — so several rows in the matrix below are
honestly **planned**, not implemented.

## Capability matrix

Each capability below is mapped to the harness mechanism that provides it, what
it enables, an honest status for *this* codebase, and the concrete Jobomate
tools that realise it. Statuses: **implemented** (first-class today), **partial**
(present but scoped), **planned** (described but not yet built here).

| Capability | Harness mechanism | What it enables | Status | Tools |
| --- | --- | --- | --- | --- |
| Codebase access | File read, search, glob, repo indexing | Inspect real projects, understand architecture, trace dependencies. | planned | — |
| File editing | Write/edit tools, diffs, checkpoints | Create, modify, refactor, or revert files safely. | planned | — |
| Software execution | Shell, task runner, build/test commands | Run tests, install packages, build apps, inspect logs. | planned | — |
| App creation | File tools + terminal + preview/browser | Build full apps, launch dev servers, verify UI, iterate on failures. | planned | `browser_navigate` |
| Planning | Agentic loop, approval gates, task tracking | Explore before acting, break work into steps, execute with checkpoints. | implemented | — |
| Document creation | File generation, document libraries, render/export tools | Produce Markdown, HTML, PDFs, spreadsheets, slide decks, reports, docs. | planned | — |
| Browser use | Web search, page fetch, browser automation | Search, read pages, interact with web apps, fill forms, test UIs. | implemented | `browser_navigate`, `browser_click`, `browser_fill`, `browser_type`, `browser_get_text`, `browser_snapshot` |
| Desktop automation | Screen capture, mouse/keyboard control, app automation | Use native apps, operate GUIs, test desktop workflows. | partial | `browser_take_screenshot`, `browser_type`, `browser_press_key`, `browser_cdp` |
| Advanced prompt interpretation | System prompts, project rules, skills, tool schemas | Convert broad user intent into structured actions and workflows. | implemented | — |
| RAG-style grounding | File search, external docs, MCP/resources, databases | Retrieve relevant context from repos, docs, tickets, wikis, APIs. | partial | `browser_get_text`, `github_diff`, `github_log` |
| External integrations | MCP servers, plugins, custom connectors | Connect to GitHub, Jira, Slack, databases, cloud providers, internal tools. | partial | `github_pr`, `github_api` |
| IDE support | Editor extensions, diagnostics, LSP context | Use selected code, errors, symbols, references, inline diffs. | planned | — |
| Git workflows | Git commands, PR tools, CI inspection | Commit, branch, review diffs, open PRs, fix failing checks. | implemented | `github_commit`, `github_branch`, `github_sync`, `github_pr`, `github_checks`, … |
| Subagents | Separate worker agents with scoped context/tools | Parallelize review, research, implementation, testing, migration tasks. | planned | — |
| Memory/context | Project instruction files, summaries, persistent notes | Remember project conventions, compress long sessions, preserve state. | partial | — |
| Hooks/automation | Pre/post tool hooks, scheduled jobs, monitors | Run formatters, enforce policies, trigger tasks, watch for events. | planned | — |
| Safety controls | Permissions, sandboxing, allow/deny rules | Limit what the agent can read, edit, run, browse, or automate. | implemented | — |
| Runtime environments | Local machine, remote server, cloud VM, container | Execute work in the right environment with the right dependencies. | partial | — |

### Where the matrix is honest about the gap

- **Planned (no dedicated tool here yet):** codebase access, file editing,
  software execution, app creation, document creation, IDE support, subagents,
  hooks/automation. Jobomate is a browser-automation shell; these would need
  file / exec / document tools it does not ship. The git toolkit can show
  diffs / log and commit, but there is no general read / write / shell tool.
- **Desktop automation** — scoped to the in-app browser surface (screenshot,
  synthetic input, CDP), not arbitrary native OS apps.
- **RAG-style grounding** — attachment extraction + live page text + git
  history/diffs; no vector store or MCP/resource servers yet.
- **External integrations** — native GitHub only (git + the `gh` CLI); no MCP,
  Jira, Slack, or other connectors yet.
- **Memory/context** — persisted custom system prompt + a rolling history window
  + attachment context; no long-term vector/summary memory store yet.
- **Runtime environments** — runs on the local machine and spawns local
  `git`/`gh`; no remote/VM/container execution targets.

### GitHub toolkit

The harness ships a purpose-built GitHub toolkit
([`electron/tools/githubTools.ts`](../electron/tools/githubTools.ts)) so the model
works with repos the way a coding agent does — structured tools over `git` + the
`gh` CLI (invoked via argv, never a shell string), rather than hand-rolling shell
commands:

| Tool | Purpose | Side-effecting? |
| --- | --- | --- |
| `github_auth_status` | Report git/gh availability, gh auth, repo + remotes | no |
| `github_clone` | Clone owner/name (via gh) or a URL (via git) | yes (approval) |
| `github_status` | Structured branch + staged/modified/untracked summary | no |
| `github_log` | Clean commit history (hash, date, author, subject) | no |
| `github_diff` | Working-tree / staged / ref-range diff or diffstat | no |
| `github_commit` | Stage + commit (paths, `-u`, or `-A`) | yes (approval) |
| `github_branch` | list / create / checkout / delete | mutations (approval) |
| `github_sync` | fetch (read) / pull / push | pull+push (approval) |
| `github_pr` | **PR viewer**: list / view / diff / checks / create / comment / checkout | writes (approval) |
| `github_checks` | **CI inspector**: list/view Actions runs + failed-step logs | no |
| `github_issue` | list / view / create / comment | writes (approval) |
| `github_api` | Generic `gh api` escape hatch (GET read, others approval) | non-GET (approval) |

Read-only tools run without a prompt; every side-effecting tool clears the
approval gate first (a native confirm dialog wired in `electron/main.ts`).
Positional values that begin with `-` are rejected before anything runs, as
defence in depth on top of argv-only spawning. Private repos and pushing require
`gh auth login` or configured git credentials — `github_auth_status` reports
exactly what is available before the model relies on it.

## Using it from the model

The connected model is grounded in this split via the system prompt (see
`systemPrompt()` in `electron/llm-connection.ts`, which appends
`harnessSystemPromptLine()`) and can pull the full matrix on demand:

- `describe_harness` — full overview (both layers + the capability matrix).
- `describe_harness {"capability": "browser-use"}` — one capability in detail.
  The id or the human-facing name both work.

## Keeping this honest

`tests/capabilityModel.test.ts` enforces that the matrix stays grounded: every
tool a capability claims is checked against the live dispatch registry (or the
known browser tools), and every source module path is checked to exist on disk.
If a tool is renamed or a module moves, the test fails until this model is
updated — so the description can't silently drift from the implementation.
