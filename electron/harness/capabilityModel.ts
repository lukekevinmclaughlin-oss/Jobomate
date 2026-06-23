// The Jobomate agent model, encoded as first-class, introspectable data.
//
// Jobomate is an *agent harness*. An agent's impressive behaviour comes from the
// combination of two layers, not from the model alone:
//
//   • The LLM is the REASONING ENGINE. It interprets prompts, reasons over
//     context, writes text/code, decides which actions to take, and chooses
//     when to call tools. It supplies reasoning and generation.
//
//   • The harness is the EXECUTION & CAPABILITY LAYER. It gives the model
//     access to a browser, git/GitHub, approval gates, attachment context, and
//     external systems. It supplies action, memory, tools, integrations,
//     permissions, retrieval, and environment control.
//
// This module turns that mental model into structured data grounded in the
// actual Jobomate implementation: every capability maps to the concrete tools
// and source modules that realise it, with an HONEST status. It is the single
// source of truth behind the `describe_harness` tool (so the model can
// introspect its own harness), the system-prompt grounding line, and
// docs/HARNESS_MODEL.md.
//
// Jobomate is a browser-automation shell: it ships the ~20 browser_* tools and
// (now) the purpose-built github_* toolkit, but it has NO dedicated
// file/exec/web/document tools — so several rows below are honestly "planned".
//
// Pure and dependency-free (no Electron imports) so it stays unit-testable and
// can be consumed from both the main process and tests.

/** One side of the agent: what the LLM contributes vs. what the harness contributes. */
export interface RoleSpec {
  /** Display name of the layer. */
  name: string;
  /** One-line definition of the layer's job. */
  role: string;
  /** The concrete things this layer is responsible for. */
  responsibilities: string[];
}

/**
 * How fully a capability is realised in *this* codebase.
 *  - "implemented": first-class, end-to-end support in Jobomate today.
 *  - "partial": present but scoped/limited vs. the general description.
 *  - "planned": described by the model but not yet built here.
 */
export type CapabilityStatus = "implemented" | "partial" | "planned";

/** A single row of the capability matrix, grounded to Jobomate code. */
export interface Capability {
  /** Stable kebab-case identifier (also the `describe_harness` filter key). */
  id: string;
  /** Human-facing capability name. */
  capability: string;
  /** The harness mechanism that provides it. */
  mechanism: string;
  /** What the capability enables the agent to do. */
  enables: string;
  /** Concrete Jobomate tool names that realise it (may be empty for cross-cutting layers). */
  tools: string[];
  /** Source modules (repo-relative paths) that implement it. */
  modules: string[];
  /** How fully Jobomate realises it today. */
  status: CapabilityStatus;
  /** Optional honesty note explaining a "partial"/"planned" status. */
  note?: string;
}

/** The LLM half of the agent. */
export const REASONING_ENGINE: RoleSpec = {
  name: "Reasoning engine (the LLM)",
  role: "Interprets prompts, reasons over context, and decides what to do.",
  responsibilities: [
    "Interpret the user's natural-language intent.",
    "Reason over the supplied context and tool results.",
    "Write text and code.",
    "Decide which actions to take.",
    "Choose when to call tools and with what arguments.",
  ],
};

/** The harness half of the agent — this is what Jobomate itself is. */
export const HARNESS: RoleSpec = {
  name: "Agent harness (Jobomate)",
  role: "The execution & capability layer that turns decisions into actions.",
  responsibilities: [
    "Give the model access to the in-app browser and git/GitHub.",
    "Provide attachment context and persistent custom instructions.",
    "Enforce permissions and approval boundaries on side-effecting actions.",
    "Connect to external systems (GitHub via git + the gh CLI).",
    "Run work in the local runtime environment.",
  ],
};

/**
 * The canonical browser tool names Jobomate exposes from llm-connection.ts.
 * Kept here as data (not imported from llm-connection.ts, which pulls in
 * Electron) so the capability matrix can reference and validate them without
 * dragging the Electron runtime into tests. This list MUST match
 * browserToolDefinitions() in electron/llm-connection.ts.
 */
export const KNOWN_BROWSER_TOOLS: readonly string[] = [
  "browser",
  "browser_navigate",
  "browser_snapshot",
  "browser_tabs",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_scroll",
  "browser_select_option",
  "browser_take_screenshot",
  "browser_press_key",
  "browser_highlight",
  "browser_cdp",
  "browser_get_text",
  "browser_get_html",
  "browser_reload",
  "browser_back",
  "browser_forward",
  "done",
  "ask_user",
];

/**
 * The capability matrix: the agent harness's contribution, row by row, mapped
 * to the Jobomate code that realises each one. Order mirrors the canonical
 * model. Statuses are HONEST for this repo: a row is only "implemented" when a
 * real tool/module here provides it.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: "codebase-access",
    capability: "Codebase access",
    mechanism: "File read, search, glob, repo indexing",
    enables: "Inspect real projects, understand architecture, trace dependencies.",
    tools: [],
    modules: ["electron/tools/githubTools.ts"],
    status: "planned",
    note: "No dedicated file read/search/glob tools in this browser-automation shell. The git toolkit can show diffs/log, but there is no general read_file/grep/glob here yet.",
  },
  {
    id: "file-editing",
    capability: "File editing",
    mechanism: "Write/edit tools, diffs, checkpoints",
    enables: "Create, modify, refactor, or revert files safely.",
    tools: [],
    modules: ["electron/tools/dispatch.ts"],
    status: "planned",
    note: "No write_file/edit_file tools in this repo. The model edits files only indirectly, by committing via github_commit; there is no in-harness editor.",
  },
  {
    id: "software-execution",
    capability: "Software execution",
    mechanism: "Shell, task runner, build/test commands",
    enables: "Run tests, install packages, build apps, inspect logs.",
    tools: [],
    modules: ["electron/tools/processRunner.ts"],
    status: "planned",
    note: "No general exec/run_python/run_node tool is exposed to the model. processRunner.ts spawns git/gh for the GitHub toolkit only — there is no arbitrary shell tool here yet.",
  },
  {
    id: "app-creation",
    capability: "App creation",
    mechanism: "File tools + terminal + preview/browser",
    enables: "Build full apps, launch dev servers, verify UI, iterate on failures.",
    tools: ["browser_navigate"],
    modules: ["electron/llm-connection.ts"],
    status: "planned",
    note: "Requires file + exec tools that this browser-automation shell does not ship. Only the in-app browser is available for verifying a UI.",
  },
  {
    id: "planning",
    capability: "Planning",
    mechanism: "Agentic loop, approval gates, task tracking",
    enables: "Explore before acting, break work into steps, execute with checkpoints.",
    tools: [],
    modules: ["electron/llm-connection.ts"],
    status: "implemented",
    note: "The assistant run loop in llm-connection.ts drives a multi-round agentic loop with a no-progress stall guard, pause/resume/stop controls, and approval gating before side-effecting tools.",
  },
  {
    id: "document-creation",
    capability: "Document creation",
    mechanism: "File generation, document libraries, render/export tools",
    enables: "Produce Markdown, HTML, PDFs, spreadsheets, slide decks, reports, docs.",
    tools: [],
    modules: ["electron/tools/dispatch.ts"],
    status: "planned",
    note: "No PDF/DOCX/PPTX/XLSX/image generation tools in this repo.",
  },
  {
    id: "browser-use",
    capability: "Browser use",
    mechanism: "Web search, page fetch, browser automation",
    enables: "Search, read pages, interact with web apps, fill forms, test UIs.",
    tools: [
      "browser_navigate",
      "browser_click",
      "browser_fill",
      "browser_type",
      "browser_get_text",
      "browser_snapshot",
    ],
    modules: ["electron/llm-connection.ts", "electron/llm-server.ts"],
    status: "implemented",
    note: "Full in-app browser automation: navigate, snapshot, click/fill/type/scroll/select, screenshots, key presses, CDP eval, tab management. Web search is done by navigating to a results URL (no dedicated web_search tool).",
  },
  {
    id: "desktop-automation",
    capability: "Desktop automation",
    mechanism: "Screen capture, mouse/keyboard control, app automation",
    enables: "Use native apps, operate GUIs, test desktop workflows.",
    tools: ["browser_take_screenshot", "browser_type", "browser_press_key", "browser_cdp"],
    modules: ["electron/llm-connection.ts"],
    status: "partial",
    note: "Automation is scoped to the in-app browser surface (screenshot, synthetic input, CDP), not arbitrary native OS apps.",
  },
  {
    id: "prompt-interpretation",
    capability: "Advanced prompt interpretation",
    mechanism: "System prompts, project rules, skills, tool schemas",
    enables: "Convert broad user intent into structured actions and workflows.",
    tools: [],
    modules: ["electron/llm-connection.ts"],
    status: "implemented",
    note: "A grounded system prompt plus a persisted custom system prompt and per-tool JSON schemas steer the model from broad intent to concrete tool calls.",
  },
  {
    id: "rag-grounding",
    capability: "RAG-style grounding",
    mechanism: "File search, external docs, MCP/resources, databases",
    enables: "Retrieve relevant context from repos, docs, tickets, wikis, APIs.",
    tools: ["browser_get_text", "github_diff", "github_log"],
    modules: ["electron/attachments.ts", "electron/llm-connection.ts"],
    status: "partial",
    note: "Grounding comes from attached-file extraction, live page text via the browser, and git history/diffs. No vector store, no MCP/resource servers here yet.",
  },
  {
    id: "external-integrations",
    capability: "External integrations",
    mechanism: "MCP servers, plugins, custom connectors",
    enables: "Connect to GitHub, Jira, Slack, databases, cloud providers, internal tools.",
    tools: ["github_pr", "github_api"],
    modules: ["electron/tools/githubTools.ts"],
    status: "partial",
    note: "Native GitHub integration via git + the gh CLI (github_pr / github_issue / github_checks / github_api). No MCP server support, Jira/Slack, or other connectors here yet.",
  },
  {
    id: "ide-support",
    capability: "IDE support",
    mechanism: "Editor extensions, diagnostics, LSP context",
    enables: "Use selected code, errors, symbols, references, inline diffs.",
    tools: [],
    modules: ["electron/tools/dispatch.ts"],
    status: "planned",
    note: "No editor/LSP/diagnostics surface in this browser-automation shell.",
  },
  {
    id: "git-workflows",
    capability: "Git workflows",
    mechanism: "Git commands, PR tools, CI inspection",
    enables: "Commit, branch, review diffs, open PRs, fix failing checks.",
    tools: [
      "github_clone",
      "github_status",
      "github_log",
      "github_diff",
      "github_commit",
      "github_branch",
      "github_sync",
      "github_pr",
      "github_checks",
      "github_issue",
      "github_api",
      "github_auth_status",
    ],
    modules: ["electron/tools/githubTools.ts", "electron/tools/processRunner.ts"],
    status: "implemented",
    note: "Dedicated GitHub toolkit wraps git + the gh CLI: structured status/log/diff, approval-gated commit/branch/push, a PR viewer (github_pr) and CI inspector (github_checks), issues, and a github_api escape hatch — all spawned via argv (no shell), with a flag-injection guard. Private repos and pushing require gh auth or configured git credentials; github_auth_status reports what is available.",
  },
  {
    id: "subagents",
    capability: "Subagents",
    mechanism: "Separate worker agents with scoped context/tools",
    enables: "Parallelize review, research, implementation, testing, migration tasks.",
    tools: [],
    modules: ["electron/tools/dispatch.ts"],
    status: "planned",
    note: "No multi-agent fan-out or scoped sub-completions in this repo.",
  },
  {
    id: "memory-context",
    capability: "Memory/context",
    mechanism: "Project instruction files, summaries, persistent notes",
    enables: "Remember project conventions, compress long sessions, preserve state.",
    tools: [],
    modules: ["electron/llm-connection.ts", "electron/attachments.ts"],
    status: "partial",
    note: "Persisted custom system prompt + a rolling history window + attachment context; no long-term vector/summary memory store yet.",
  },
  {
    id: "hooks-automation",
    capability: "Hooks/automation",
    mechanism: "Pre/post tool hooks, scheduled jobs, monitors",
    enables: "Run formatters, enforce policies, trigger tasks, watch for events.",
    tools: [],
    modules: ["electron/tools/dispatch.ts"],
    status: "planned",
    note: "No user-configurable hook scripts or schedulers. The approval gate (see safety-controls) is the only pre-tool interception, and it is fixed.",
  },
  {
    id: "safety-controls",
    capability: "Safety controls",
    mechanism: "Permissions, sandboxing, allow/deny rules",
    enables: "Limit what the agent can read, edit, run, browse, or automate.",
    tools: [],
    modules: ["electron/tools/githubTools.ts", "electron/tools/types.ts"],
    status: "implemented",
    note: "Side-effecting GitHub tools (clone/commit/branch mutations/push/PR+issue writes/non-GET api) route through the harness approval gate (ctx.approve) and abort on denial; git/gh are spawned via argv only, with a flag-injection guard on positional values.",
  },
  {
    id: "runtime-environments",
    capability: "Runtime environments",
    mechanism: "Local machine, remote server, cloud VM, container",
    enables: "Execute work in the right environment with the right dependencies.",
    tools: [],
    modules: ["electron/tools/processRunner.ts"],
    status: "partial",
    note: "Runs on the local machine; the GitHub toolkit spawns local git/gh processes. No remote/VM/container execution targets are built in.",
  },
];

/** The one-paragraph thesis behind the whole model. */
export const HARNESS_MODEL_SUMMARY =
  "The LLM supplies reasoning and generation, while the harness supplies action, " +
  "memory, tools, integrations, permissions, retrieval, and environment control. " +
  "The impressive agent behaviour comes from the combination, not from the model alone.";

/** Look up one capability row by its id. */
export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** All capability rows with the given status. */
export function capabilitiesByStatus(status: CapabilityStatus): Capability[] {
  return CAPABILITIES.filter((c) => c.status === status);
}

/** Every concrete tool name referenced by the matrix (deduped, sorted). */
export function declaredTools(): string[] {
  return [...new Set(CAPABILITIES.flatMap((c) => c.tools))].sort();
}

/** A compact count summary, e.g. for telemetry or a status line. */
export function capabilityCounts(): Record<CapabilityStatus, number> {
  return {
    implemented: capabilitiesByStatus("implemented").length,
    partial: capabilitiesByStatus("partial").length,
    planned: capabilitiesByStatus("planned").length,
  };
}

/** A short grounding line for the system prompt (kept terse on purpose). */
export function harnessSystemPromptLine(): string {
  return (
    "Architecture: you are the reasoning engine; Jobomate is your agent harness — " +
    "the execution and capability layer (browser, git/GitHub, permissions, retrieval, runtime). " +
    HARNESS_MODEL_SUMMARY +
    " Call describe_harness to see exactly which capabilities and tools you have."
  );
}

/** Render the full model as Markdown (used by describe_harness and the docs). */
export function renderHarnessOverview(): string {
  const lines: string[] = [];
  lines.push("# Jobomate agent model");
  lines.push("");
  lines.push(`**${REASONING_ENGINE.name}** — ${REASONING_ENGINE.role}`);
  for (const r of REASONING_ENGINE.responsibilities) lines.push(`- ${r}`);
  lines.push("");
  lines.push(`**${HARNESS.name}** — ${HARNESS.role}`);
  for (const r of HARNESS.responsibilities) lines.push(`- ${r}`);
  lines.push("");
  lines.push("## Capability matrix");
  lines.push("");
  lines.push("| Capability | Harness mechanism | What it enables | Status | Tools |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const c of CAPABILITIES) {
    const tools = c.tools.length ? c.tools.map((t) => `\`${t}\``).join(", ") : "—";
    lines.push(
      `| ${c.capability} | ${c.mechanism} | ${c.enables} | ${c.status} | ${tools} |`,
    );
  }
  const counts = capabilityCounts();
  lines.push("");
  lines.push(
    `_${CAPABILITIES.length} capabilities — ${counts.implemented} implemented, ` +
      `${counts.partial} partial, ${counts.planned} planned._`,
  );
  lines.push("");
  lines.push(`> ${HARNESS_MODEL_SUMMARY}`);
  return lines.join("\n");
}

/** Render a single capability in detail (used by describe_harness filtering). */
export function renderCapability(id: string): string {
  const c = getCapability(id);
  if (!c) {
    const ids = CAPABILITIES.map((x) => x.id).join(", ");
    return `Unknown capability "${id}". Known ids: ${ids}.`;
  }
  const lines = [
    `# ${c.capability} (${c.id})`,
    "",
    `- Mechanism: ${c.mechanism}`,
    `- Enables: ${c.enables}`,
    `- Status: ${c.status}`,
    `- Tools: ${c.tools.length ? c.tools.map((t) => `\`${t}\``).join(", ") : "—"}`,
    `- Modules: ${c.modules.map((m) => `\`${m}\``).join(", ")}`,
  ];
  if (c.note) lines.push(`- Note: ${c.note}`);
  return lines.join("\n");
}
