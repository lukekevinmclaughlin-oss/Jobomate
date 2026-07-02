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
  `llm-connection.ts`, the tool modules under
  [`electron/tools/`](../electron/tools) (files, exec, background processes,
  task state, GitHub, web, documents, research, memory, subagents, schedules,
  verification, connectors + the `describe_harness` introspection tool), the
  approval gate wired in [`electron/main.ts`](../electron/main.ts), the
  sensitive-path / SSRF policies in
  [`electron/security/policy.ts`](../electron/security/policy.ts), and the
  attachment context in [`electron/attachments.ts`](../electron/attachments.ts).

Jobomate ships the full **coding-harness core** on top of its browser shell:

- **Workspace + files** — `set_workspace` pins the project root;
  `list_dir` / `glob_files` / `grep_search` / `read_file` / `file_info` explore
  it; `write_file` / `edit_file` / `make_dir` / `move_path` / `copy_path` /
  `delete_path` change it. Every mutation snapshots the previous content, so
  `list_file_changes` / `diff_file_change` / `undo_file_change` provide diff
  awareness and one-step recovery ([`electron/tools/fileTools.ts`](../electron/tools/fileTools.ts)).
- **Execution** — `exec` for one-shot shell commands, `run_python` / `run_node`
  for snippets, `python_session` for a stateful kernel, and
  `start_process` / `process_output` / `stop_process` / `list_processes` /
  `wait_for_server` for dev servers and other long-running processes
  ([`electron/tools/processTools.ts`](../electron/tools/processTools.ts)).
- **Task state** — `todo_write` / `todo_update` / `todo_read` keep a plan alive
  across tool rounds ([`electron/tools/taskTools.ts`](../electron/tools/taskTools.ts)).

## Capability matrix

Each capability below is mapped to the harness mechanism that provides it, what
it enables, an honest status for *this* codebase, and the concrete Jobomate
tools that realise it. Statuses: **implemented** (first-class today), **partial**
(present but scoped), **planned** (described but not yet built here).

| Capability | Harness mechanism | What it enables | Status | Tools |
| --- | --- | --- | --- | --- |
| Codebase access | File read, search, glob, workspace, repo indexing | Inspect real projects, understand architecture, trace dependencies. | implemented | `set_workspace`, `get_workspace`, `list_dir`, `glob_files`, `grep_search`, `read_file`, `file_info` |
| File editing | Write/edit tools, diffs, checkpoints | Create, modify, refactor, or revert files safely. | implemented | `write_file`, `edit_file`, `make_dir`, `move_path`, `copy_path`, `delete_path`, `list_file_changes`, `diff_file_change`, `undo_file_change` |
| Software execution | Shell, task runner, build/test commands, stateful kernel | Run tests, install packages, build apps, inspect logs, iterate on data. | implemented | `exec`, `run_python`, `run_node`, `python_session` |
| App creation | File tools + terminal + dev-server control + in-app browser | Build full apps, launch dev servers, verify UI, iterate on failures. | implemented | `start_process`, `process_output`, `stop_process`, `list_processes`, `wait_for_server`, `browser_navigate` |
| Planning | Agentic loop, approval gates, task tracking | Explore before acting, break work into steps, execute with checkpoints. | implemented | `todo_write`, `todo_update`, `todo_read` |
| Document creation & editing | Document libraries (pdf-lib/docx/pptx/xlsx), HTML→PDF, charts, diagrams | Produce and edit designed PDFs/Word/PowerPoint/Excel, charts, diagrams, mail-merge. | implemented | `write_pdf`, `write_docx`, `write_pptx`, `write_xlsx`, `edit_pdf`, `read_pdf`, `render_html_pdf`, `generate_chart`, `generate_diagram`, `merge_template`, `generate_image` |
| Image generation | Provider diffusion image APIs with an offline procedural fallback | Create images from text and embed them into documents. | implemented | `generate_image` |
| Deep research | Multi-query web search + source fetching + cited synthesis loop | Investigate a topic across many sources; produce a structured, cited report. | implemented | `deep_research`, `web_search`, `web_fetch` |
| Semantic memory / RAG | Vector store with provider or local embeddings, persisted across sessions | Remember facts long-term and retrieve relevant context from indexed files. | implemented | `remember`, `recall`, `index_files`, `memory_list`, `memory_forget` |
| Code interpreter (stateful) | Persistent Python kernel with a shared namespace | Iterative data analysis where variables persist across cells. | implemented | `python_session`, `run_python`, `run_node` |
| Multimodal I/O | Text-to-speech, OCR, and speech-to-text | Speak responses, read text from images/scans, transcribe audio. | partial | `text_to_speech`, `ocr_image`, `transcribe_audio` |
| Self-verification & evaluation | Batch code checks + web-grounded claim checking | Confirm code actually works (tests/lint/typecheck/build); fact-check statements. | implemented | `verify_code`, `verify_claims` |
| Browser use | Web search, page fetch, browser automation | Search, read pages, interact with web apps, fill forms, test UIs. | implemented | `browser_navigate`, `browser_click`, `browser_fill`, `browser_type`, `browser_get_text`, `browser_snapshot` |
| Desktop automation | Screen capture, mouse/keyboard control, app automation | Use native apps, operate GUIs, test desktop workflows. | implemented | `screen_capture`, `screen_size`, `open_app`, `type_text`, `press_keys`, `mouse_click`, `browser_take_screenshot` |
| Advanced prompt interpretation | System prompts, project rules, skills, tool schemas | Convert broad user intent into structured actions and workflows. | implemented | — |
| RAG-style grounding | File search, external docs, MCP/resources, databases | Retrieve relevant context from repos, docs, tickets, wikis, APIs. | implemented | `web_search`, `web_fetch`, `recall`, `index_files`, `browser_get_text`, `github_diff`, `github_log` |
| External integrations | MCP servers, plugins, custom connectors | Connect to GitHub, Jira, Slack, databases, cloud providers, internal tools. | implemented | `github_pr`, `github_api`, `http_request`, `send_email`, `calendar_add`, `sql_query` |
| IDE support | Editor extensions, diagnostics, LSP context | Use selected code, errors, symbols, references, inline diffs. | planned | — |
| Git workflows | Git commands, PR tools, CI inspection | Commit, branch, review diffs, open PRs, fix failing checks. | implemented | `github_clone`, `github_status`, `github_log`, `github_diff`, `github_commit`, `github_branch`, `github_sync`, `github_pr`, `github_checks`, `github_issue`, `github_api`, `github_auth_status` |
| Subagents | Parallel scoped worker completions + coordinator synthesis | Parallelize review, research, implementation, analysis. | implemented | `spawn_subagents` |
| Memory/context | Project instruction files, summaries, persistent notes, semantic store | Remember project conventions, compress long sessions, preserve state. | implemented | `remember`, `recall`, `memory_list`, `memory_forget` |
| Hooks/automation | Pre/post tool hooks + scheduled & recurring jobs | Run formatters, enforce policies, trigger one-shot or recurring tasks. | implemented | `schedule_task`, `list_schedules`, `cancel_schedule` |
| Safety controls | Permissions, sandboxing, allow/deny rules | Limit what the agent can read, edit, run, browse, or automate. | implemented | — |
| Runtime environments | Local machine, remote server, cloud VM, container | Execute work in the right environment with the right dependencies. | partial | `exec`, `run_python`, `run_node`, `python_session`, `start_process`, `wait_for_server` |

### Where the matrix is honest about the gap

- **IDE support** — no editor/LSP/diagnostics surface in this shell.
- **Multimodal I/O** — TTS/OCR/transcription lean on macOS-native helpers and
  degrade on other platforms.
- **Runtime environments** — runs on the local machine (with a persistent
  Python kernel and managed background processes); no remote/VM/container
  execution targets are built in.
- **Safety controls** — every side-effecting tool (file writes/deletes, exec,
  process control, commits/pushes, PR/issue writes) clears the user approval
  gate; file tools refuse sensitive paths (`~/.ssh`, keychains, wallets);
  `web_fetch` has an SSRF guard; git/gh are spawned via argv only.

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
