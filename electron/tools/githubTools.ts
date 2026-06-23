// Purpose-built GitHub toolkit for the MAOS harness.
//
// The model could always drive git/GitHub through the raw `exec` shell tool, but
// that leaves it juggling shell quoting and parsing free-form output. This module
// gives it dedicated, structured, approval-gated tools — the "PR viewer" and "CI
// inspector" the harness previously lacked — mirroring how a coding agent actually
// works with GitHub: the `gh` CLI for the platform (PRs / issues / checks / api)
// and `git` for the local repo, invoked via argv (never a shell string, so there
// is no command-injection surface).
//
// Conventions, consistent with the rest of the tool catalog:
//   * Read-only tools (status/log/diff/list/view/checks/auth) run without a prompt.
//   * Side-effecting tools (clone/commit/push/pull/branch-mutations/PR+issue writes/
//     non-GET api) clear ctx.approve first and abort with DENIED on refusal.
//   * Every process is spawned through execTools.runProcess, so it inherits the
//     same timeout, output cap, and PATH handling. We additionally prepend the
//     common CLI install dirs so git/gh resolve even under a GUI app's slim PATH.

import * as os from "node:os";
import * as path from "node:path";
import { defineTool, type ToolHandler, type ToolModule } from "./types";
import { runProcess, formatOutcome, resolveCwd, firstString, summarize } from "./processRunner";

const DENIED = "Denied by user.";
const DEFAULT_TIMEOUT_MS = 60_000;

const GH_MISSING =
  "GitHub CLI (`gh`) is not available on PATH. Install it from https://cli.github.com and run " +
  "`gh auth login`. The git-based tools (github_status / github_log / github_diff / github_commit / " +
  "github_branch / github_sync, and github_clone over an https URL) work without gh. " +
  "Run github_auth_status to see what is available.";

// Common locations for git/gh so a packaged GUI app (slim PATH) still finds them.
function cliBinDirs(): string | null {
  if (process.platform === "win32") return null; // gh/git are normally already on PATH on Windows
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, ".local", "bin"),
  ].join(path.delimiter);
}

function timeoutFor(args: Record<string, unknown>): number {
  const raw = args["timeoutSeconds"] ?? args["timeout"];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(n * 1000, 1000), 600_000);
}

/** Run `git`/`gh` with argv (no shell). Returns the raw process outcome. */
async function runCli(
  bin: "git" | "gh",
  argv: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
) {
  return runProcess(bin, argv, { cwd, binDir: cliBinDirs(), timeoutMs });
}

let ghProbe: boolean | null = null;
async function hasGh(cwd: string): Promise<boolean> {
  if (ghProbe !== null) return ghProbe;
  const outcome = await runCli("gh", ["--version"], cwd, 15_000);
  ghProbe = outcome.exitCode === 0;
  return ghProbe;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((s) => s.length > 0);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Reject a user/model-supplied positional that begins with "-" so it can't be
 * misread by git/gh as an option (e.g. a ref of `--upload-pack=…`). Defence in
 * depth on top of argv-only spawning (no shell) and the approval gate. Returns
 * the offending value, or null if all are safe. Legitimate git refs, branch
 * names, PR numbers and API endpoints never start with "-".
 */
function flagLike(...values: string[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.startsWith("-")) return v;
  }
  return null;
}
const flagReject = (v: string) =>
  `Error: refusing the value "${v}" because it begins with "-" and could be misread as a command-line flag.`;

// ---------------------------------------------------------------------------
// Read-only: capability / auth probe
// ---------------------------------------------------------------------------

const authStatusHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  const lines: string[] = [];

  const git = await runCli("git", ["--version"], cwd, 15_000);
  lines.push(git.exitCode === 0 ? `git: ${git.output.trim()}` : "git: NOT FOUND on PATH");

  const ghOk = await hasGh(cwd);
  if (ghOk) {
    const ver = await runCli("gh", ["--version"], cwd, 15_000);
    lines.push(`gh: ${ver.output.trim().split("\n")[0]}`);
    const auth = await runCli("gh", ["auth", "status"], cwd, 20_000);
    // `gh auth status` writes its human summary to stderr; runProcess interleaves both.
    lines.push("gh auth:");
    lines.push(auth.output.trim() || (auth.exitCode === 0 ? "authenticated" : "not authenticated"));
  } else {
    lines.push("gh: NOT FOUND on PATH (platform tools — PRs/issues/checks/api — are unavailable)");
  }

  // Repo context, if cwd is inside a working tree.
  const inside = await runCli("git", ["rev-parse", "--is-inside-work-tree"], cwd, 15_000);
  if (inside.exitCode === 0 && /true/.test(inside.output)) {
    const branch = await runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd, 15_000);
    const remote = await runCli("git", ["remote", "-v"], cwd, 15_000);
    lines.push(`repo: yes (branch ${branch.output.trim() || "?"})`);
    if (remote.output.trim()) lines.push(`remotes:\n${remote.output.trim()}`);
  } else {
    lines.push(`repo: ${cwd} is not a git repository`);
  }

  lines.push(
    "\nNote: private repos and pushing require `gh auth login` (or configured git credentials). " +
      "Read-only public access works over https without auth."
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Side-effecting: clone
// ---------------------------------------------------------------------------

const cloneHandler: ToolHandler = async (args, ctx) => {
  const repo = firstString(args, "repo", "url", "repository");
  if (!repo) return "Error: github_clone requires a 'repo' (owner/name or a clone URL).";
  const cwd = resolveCwd(args, ctx);
  const dir = firstString(args, "dir", "directory", "path");
  const badClone = flagLike(repo, dir);
  if (badClone) return flagReject(badClone);
  const depth = asInt(args["depth"], 0);
  const timeoutMs = timeoutFor(args);

  const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(repo);
  const useGh = !isUrl && /^[\w.-]+\/[\w.-]+$/.test(repo) && (await hasGh(cwd));

  let bin: "git" | "gh";
  let argv: string[];
  if (useGh) {
    bin = "gh";
    argv = ["repo", "clone", repo];
    if (dir) argv.push(dir);
    if (depth > 0) argv.push("--", "--depth", String(depth));
  } else {
    bin = "git";
    argv = ["clone"];
    if (depth > 0) argv.push("--depth", String(depth));
    argv.push(repo);
    if (dir) argv.push(dir);
  }

  if (!(await ctx.approve({ tool: "github_clone", summary: summarize("Clone repository", `${repo}${dir ? ` -> ${dir}` : ""}`) }))) {
    return DENIED;
  }
  const outcome = await runCli(bin, argv, cwd, timeoutMs);
  return formatOutcome(`${bin} clone`, outcome);
};

// ---------------------------------------------------------------------------
// Read-only: status (structured)
// ---------------------------------------------------------------------------

const statusHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  const outcome = await runCli("git", ["status", "--porcelain", "--branch"], cwd, timeoutFor(args));
  if (outcome.exitCode !== 0) return formatOutcome("git status", outcome);

  const rows = outcome.output.split("\n").filter((l) => l.length > 0);
  const branchLine = rows.find((l) => l.startsWith("## "))?.slice(3) ?? "(unknown)";
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of rows) {
    if (line.startsWith("## ")) continue;
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);
    if (line.startsWith("??")) untracked.push(file);
    else {
      if (x !== " " && x !== "?") staged.push(file);
      if (y !== " " && y !== "?") modified.push(file);
    }
  }

  const out: string[] = [`Branch: ${branchLine}`];
  if (staged.length) out.push(`Staged (${staged.length}): ${staged.join(", ")}`);
  if (modified.length) out.push(`Modified/unstaged (${modified.length}): ${modified.join(", ")}`);
  if (untracked.length) out.push(`Untracked (${untracked.length}): ${untracked.join(", ")}`);
  if (!staged.length && !modified.length && !untracked.length) out.push("Working tree clean.");
  return out.join("\n");
};

// ---------------------------------------------------------------------------
// Read-only: log (structured)
// ---------------------------------------------------------------------------

const logHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  const max = asInt(args["max"] ?? args["count"], 20);
  const ref = firstString(args, "ref", "branch");
  const filePath = firstString(args, "path", "file");
  if (flagLike(ref)) return flagReject(ref);

  const SEP = "\x1f";
  const argv = ["log", `-n`, String(max), `--pretty=format:%h${SEP}%an${SEP}%ad${SEP}%s`, "--date=short"];
  if (ref) argv.push(ref);
  if (filePath) argv.push("--", filePath);

  const outcome = await runCli("git", argv, cwd, timeoutFor(args));
  if (outcome.exitCode !== 0) return formatOutcome("git log", outcome);

  const commits = outcome.output
    .split("\n")
    .filter((l) => l.includes(SEP))
    .map((l) => {
      const [hash, author, date, ...rest] = l.split(SEP);
      return `${hash}  ${date}  ${author}  ${rest.join(SEP)}`;
    });
  return commits.length ? commits.join("\n") : "No commits.";
};

// ---------------------------------------------------------------------------
// Read-only: diff
// ---------------------------------------------------------------------------

const diffHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  const argv = ["diff"];
  if (args["staged"] === true || args["cached"] === true) argv.push("--staged");
  if (args["stat"] === true) argv.push("--stat");
  const ref = firstString(args, "ref", "range");
  if (flagLike(ref)) return flagReject(ref);
  if (ref) argv.push(ref);
  const filePath = firstString(args, "path", "file");
  if (filePath) argv.push("--", filePath);

  const outcome = await runCli("git", argv, cwd, timeoutFor(args));
  const formatted = formatOutcome("git diff", outcome);
  return formatted.replace(/\nexit code: 0$/, "") || "No differences.";
};

// ---------------------------------------------------------------------------
// Side-effecting: commit
// ---------------------------------------------------------------------------

const commitHandler: ToolHandler = async (args, ctx) => {
  const message = firstString(args, "message", "msg");
  if (!message) return "Error: github_commit requires a commit 'message'.";
  const cwd = resolveCwd(args, ctx);
  const paths = stringList(args["paths"] ?? args["files"]);
  const all = args["all"] === true;
  const timeoutMs = timeoutFor(args);

  if (!(await ctx.approve({ tool: "github_commit", summary: summarize("Stage + commit", message) }))) {
    return DENIED;
  }

  // Stage: explicit paths > all (incl. new) > tracked changes only.
  const stageArgs = paths.length ? ["add", "--", ...paths] : all ? ["add", "-A"] : ["add", "-u"];
  const staged = await runCli("git", stageArgs, cwd, timeoutMs);
  if (staged.exitCode !== 0) return formatOutcome("git add", staged);

  const committed = await runCli("git", ["commit", "-m", message], cwd, timeoutMs);
  return formatOutcome("git commit", committed);
};

// ---------------------------------------------------------------------------
// branch (list = read-only; create/checkout/delete = side-effecting)
// ---------------------------------------------------------------------------

const branchHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  const op = (firstString(args, "op", "operation") || "list").toLowerCase();
  const name = firstString(args, "name", "branch");
  const base = firstString(args, "base", "from");
  const timeoutMs = timeoutFor(args);

  if (op === "list") {
    const outcome = await runCli("git", ["branch", "--all", "--verbose"], cwd, timeoutMs);
    return formatOutcome("git branch", outcome);
  }
  if (!name) return `Error: github_branch op="${op}" requires a 'name'.`;
  if (flagLike(name, base)) return flagReject(flagLike(name, base) as string);

  let argv: string[];
  let summaryText: string;
  if (op === "create") {
    argv = ["checkout", "-b", name, ...(base ? [base] : [])];
    summaryText = `Create + switch to branch ${name}${base ? ` from ${base}` : ""}`;
  } else if (op === "checkout" || op === "switch") {
    argv = ["checkout", name];
    summaryText = `Switch to branch ${name}`;
  } else if (op === "delete") {
    argv = ["branch", args["force"] === true ? "-D" : "-d", name];
    summaryText = `Delete branch ${name}`;
  } else {
    return `Error: github_branch op must be one of list|create|checkout|delete (got "${op}").`;
  }

  if (!(await ctx.approve({ tool: "github_branch", summary: summaryText }))) return DENIED;
  const outcome = await runCli("git", argv, cwd, timeoutMs);
  return formatOutcome(`git branch ${op}`, outcome);
};

// ---------------------------------------------------------------------------
// sync (fetch = read; pull/push = side-effecting)
// ---------------------------------------------------------------------------

const syncHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  const op = (firstString(args, "op", "operation") || "").toLowerCase();
  const remote = firstString(args, "remote") || "origin";
  const branch = firstString(args, "branch");
  if (flagLike(remote, branch)) return flagReject(flagLike(remote, branch) as string);
  const timeoutMs = timeoutFor(args);

  if (op === "fetch") {
    const outcome = await runCli("git", ["fetch", remote, ...(branch ? [branch] : [])], cwd, timeoutMs);
    return formatOutcome("git fetch", outcome);
  }
  if (op === "pull") {
    if (!(await ctx.approve({ tool: "github_sync", summary: `git pull ${remote}${branch ? ` ${branch}` : ""}` }))) {
      return DENIED;
    }
    const outcome = await runCli("git", ["pull", remote, ...(branch ? [branch] : [])], cwd, timeoutMs);
    return formatOutcome("git pull", outcome);
  }
  if (op === "push") {
    const setUpstream = args["setUpstream"] === true || args["set_upstream"] === true;
    const argv = ["push", ...(setUpstream ? ["-u"] : []), remote, ...(branch ? [branch] : ["HEAD"])];
    if (!(await ctx.approve({ tool: "github_sync", summary: `git ${argv.join(" ")}` }))) return DENIED;
    const outcome = await runCli("git", argv, cwd, timeoutMs);
    return formatOutcome("git push", outcome);
  }
  return `Error: github_sync op must be one of fetch|pull|push (got "${op}").`;
};

// ---------------------------------------------------------------------------
// pr — the PR viewer + part of the CI inspector (needs gh)
// ---------------------------------------------------------------------------

const prHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  if (!(await hasGh(cwd))) return GH_MISSING;
  const op = (firstString(args, "op", "operation") || "list").toLowerCase();
  const number = firstString(args, "number", "id", "pr");
  if (flagLike(number)) return flagReject(number);
  const timeoutMs = timeoutFor(args);

  if (op === "list") {
    const argv = ["pr", "list", "--limit", String(asInt(args["limit"], 20))];
    const state = firstString(args, "state");
    if (state) argv.push("--state", state);
    return formatOutcome("gh pr list", await runCli("gh", argv, cwd, timeoutMs));
  }
  if (op === "view") {
    if (!number) return 'Error: github_pr op="view" requires a PR "number".';
    const argv = ["pr", "view", number];
    if (args["comments"] === true) argv.push("--comments");
    return formatOutcome("gh pr view", await runCli("gh", argv, cwd, timeoutMs));
  }
  if (op === "diff") {
    if (!number) return 'Error: github_pr op="diff" requires a PR "number".';
    return formatOutcome("gh pr diff", await runCli("gh", ["pr", "diff", number], cwd, timeoutMs));
  }
  if (op === "checks") {
    if (!number) return 'Error: github_pr op="checks" requires a PR "number".';
    return formatOutcome("gh pr checks", await runCli("gh", ["pr", "checks", number], cwd, timeoutMs));
  }
  if (op === "create") {
    const title = firstString(args, "title");
    const body = firstString(args, "body");
    if (!title) return 'Error: github_pr op="create" requires a "title".';
    const argv = ["pr", "create", "--title", title, "--body", body || ""];
    const base = firstString(args, "base");
    const head = firstString(args, "head");
    if (base) argv.push("--base", base);
    if (head) argv.push("--head", head);
    if (args["draft"] === true) argv.push("--draft");
    if (!(await ctx.approve({ tool: "github_pr", summary: summarize("Open pull request", title) }))) return DENIED;
    return formatOutcome("gh pr create", await runCli("gh", argv, cwd, timeoutMs));
  }
  if (op === "comment") {
    const comment = firstString(args, "comment", "body");
    if (!number || !comment) return 'Error: github_pr op="comment" requires "number" and "comment".';
    if (!(await ctx.approve({ tool: "github_pr", summary: summarize(`Comment on PR #${number}`, comment) }))) {
      return DENIED;
    }
    return formatOutcome("gh pr comment", await runCli("gh", ["pr", "comment", number, "--body", comment], cwd, timeoutMs));
  }
  if (op === "checkout") {
    if (!number) return 'Error: github_pr op="checkout" requires a PR "number".';
    if (!(await ctx.approve({ tool: "github_pr", summary: `Check out PR #${number} locally` }))) return DENIED;
    return formatOutcome("gh pr checkout", await runCli("gh", ["pr", "checkout", number], cwd, timeoutMs));
  }
  return `Error: github_pr op must be one of list|view|diff|checks|create|comment|checkout (got "${op}").`;
};

// ---------------------------------------------------------------------------
// checks — the CI inspector (gh run list / view), read-only
// ---------------------------------------------------------------------------

const checksHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  if (!(await hasGh(cwd))) return GH_MISSING;
  const timeoutMs = timeoutFor(args);
  const runId = firstString(args, "runId", "run_id", "id");
  const branchArg = firstString(args, "branch", "ref");
  if (flagLike(runId, branchArg)) return flagReject(flagLike(runId, branchArg) as string);

  if (runId) {
    const argv = ["run", "view", runId];
    if (args["logFailed"] === true || args["log_failed"] === true) argv.push("--log-failed");
    return formatOutcome("gh run view", await runCli("gh", argv, cwd, timeoutMs));
  }
  const argv = ["run", "list", "--limit", String(asInt(args["limit"], 10))];
  const branch = firstString(args, "branch", "ref");
  if (branch) argv.push("--branch", branch);
  const workflow = firstString(args, "workflow");
  if (workflow) argv.push("--workflow", workflow);
  return formatOutcome("gh run list", await runCli("gh", argv, cwd, timeoutMs));
};

// ---------------------------------------------------------------------------
// issue (list/view = read; create/comment = side-effecting) — needs gh
// ---------------------------------------------------------------------------

const issueHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  if (!(await hasGh(cwd))) return GH_MISSING;
  const op = (firstString(args, "op", "operation") || "list").toLowerCase();
  const number = firstString(args, "number", "id", "issue");
  if (flagLike(number)) return flagReject(number);
  const timeoutMs = timeoutFor(args);

  if (op === "list") {
    const argv = ["issue", "list", "--limit", String(asInt(args["limit"], 20))];
    const state = firstString(args, "state");
    if (state) argv.push("--state", state);
    return formatOutcome("gh issue list", await runCli("gh", argv, cwd, timeoutMs));
  }
  if (op === "view") {
    if (!number) return 'Error: github_issue op="view" requires an issue "number".';
    const argv = ["issue", "view", number];
    if (args["comments"] === true) argv.push("--comments");
    return formatOutcome("gh issue view", await runCli("gh", argv, cwd, timeoutMs));
  }
  if (op === "create") {
    const title = firstString(args, "title");
    const body = firstString(args, "body");
    if (!title) return 'Error: github_issue op="create" requires a "title".';
    if (!(await ctx.approve({ tool: "github_issue", summary: summarize("Open issue", title) }))) return DENIED;
    return formatOutcome("gh issue create", await runCli("gh", ["issue", "create", "--title", title, "--body", body || ""], cwd, timeoutMs));
  }
  if (op === "comment") {
    const comment = firstString(args, "comment", "body");
    if (!number || !comment) return 'Error: github_issue op="comment" requires "number" and "comment".';
    if (!(await ctx.approve({ tool: "github_issue", summary: summarize(`Comment on issue #${number}`, comment) }))) {
      return DENIED;
    }
    return formatOutcome("gh issue comment", await runCli("gh", ["issue", "comment", number, "--body", comment], cwd, timeoutMs));
  }
  return `Error: github_issue op must be one of list|view|create|comment (got "${op}").`;
};

// ---------------------------------------------------------------------------
// api — generic gh api escape hatch (GET = read; mutations = side-effecting)
// ---------------------------------------------------------------------------

const apiHandler: ToolHandler = async (args, ctx) => {
  const cwd = resolveCwd(args, ctx);
  if (!(await hasGh(cwd))) return GH_MISSING;
  const endpoint = firstString(args, "endpoint", "path", "url");
  if (!endpoint) return "Error: github_api requires an 'endpoint' (e.g. repos/{owner}/{repo}/pulls).";
  if (flagLike(endpoint)) return flagReject(endpoint);
  const method = (firstString(args, "method") || "GET").toUpperCase();
  const timeoutMs = timeoutFor(args);

  const argv = ["api", endpoint];
  if (method !== "GET") argv.push("-X", method);
  const fields = args["fields"];
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      argv.push("-f", `${key}=${String(value)}`);
    }
  }

  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating) {
    if (!(await ctx.approve({ tool: "github_api", summary: `gh api ${method} ${endpoint}` }))) return DENIED;
  }
  return formatOutcome("gh api", await runCli("gh", argv, cwd, timeoutMs));
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const cwdProp = {
  cwd: { type: "string", description: "Absolute path to the target repository (defaults to the session cwd)." },
};
const timeoutProp = {
  timeoutSeconds: { type: "number", description: "Wall-clock timeout in seconds (default 60, max 600)." },
};

export const githubToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "github_auth_status",
      "Report what GitHub tooling is available: whether git and the GitHub CLI (gh) are installed, whether " +
        "gh is authenticated (and as whom), and the current repo's branch + remotes. Read-only. Call this first " +
        "to learn what you can do — private repos and pushing require gh auth or git credentials.",
      { ...cwdProp }
    ),
    defineTool(
      "github_clone",
      "Clone a GitHub repository. Accepts owner/name (uses gh for auth when available) or a full clone URL " +
        "(uses git). Side-effecting: requires approval.",
      {
        repo: { type: "string", description: "owner/name or a clone URL (https/ssh)." },
        dir: { type: "string", description: "Destination directory (optional)." },
        depth: { type: "number", description: "Shallow-clone depth (optional)." },
        ...cwdProp,
        ...timeoutProp,
      },
      ["repo"]
    ),
    defineTool(
      "github_status",
      "Show the working-tree status of a repo as a structured summary: current branch + upstream tracking, " +
        "and the staged / modified / untracked file lists. Read-only.",
      { ...cwdProp, ...timeoutProp }
    ),
    defineTool(
      "github_log",
      "Show recent commit history as a clean list (hash, date, author, subject). Read-only.",
      {
        max: { type: "number", description: "Number of commits to show (default 20)." },
        ref: { type: "string", description: "Branch/ref to log (optional; defaults to HEAD)." },
        path: { type: "string", description: "Limit history to a file/dir (optional)." },
        ...cwdProp,
        ...timeoutProp,
      }
    ),
    defineTool(
      "github_diff",
      "Show a diff. Defaults to unstaged working-tree changes; set staged for the index, pass a ref/range to " +
        "compare, a path to scope, or stat for a summary only. Read-only.",
      {
        staged: { type: "boolean", description: "Diff the staged index instead of the working tree." },
        ref: { type: "string", description: "A ref or range (e.g. main, HEAD~3, main..feature)." },
        path: { type: "string", description: "Limit the diff to a file/dir (optional)." },
        stat: { type: "boolean", description: "Show a diffstat summary instead of full patch." },
        ...cwdProp,
        ...timeoutProp,
      }
    ),
    defineTool(
      "github_commit",
      "Stage changes and create a commit. By default stages tracked changes (git add -u); pass paths to stage " +
        "specific files, or all:true to stage everything including new files. Side-effecting: requires approval.",
      {
        message: { type: "string", description: "Commit message." },
        paths: { type: "array", items: { type: "string" }, description: "Specific files/dirs to stage (optional)." },
        all: { type: "boolean", description: "Stage all changes including untracked (git add -A)." },
        ...cwdProp,
        ...timeoutProp,
      },
      ["message"]
    ),
    defineTool(
      "github_branch",
      "List branches (op=list, read-only) or create / checkout / delete a branch. Mutating ops require approval.",
      {
        op: {
          type: "string",
          enum: ["list", "create", "checkout", "switch", "delete"],
          description: "Branch operation (switch is an alias for checkout).",
        },
        name: { type: "string", description: "Branch name (required for create/checkout/delete)." },
        base: { type: "string", description: "Base ref for create (optional)." },
        force: { type: "boolean", description: "Force-delete an unmerged branch (delete only)." },
        ...cwdProp,
        ...timeoutProp,
      },
      ["op"]
    ),
    defineTool(
      "github_sync",
      "Synchronize with a remote: op=fetch (read-only), op=pull or op=push (side-effecting, require approval). " +
        "Push defaults to the current HEAD on origin; set setUpstream to add -u.",
      {
        op: { type: "string", enum: ["fetch", "pull", "push"], description: "Sync operation." },
        remote: { type: "string", description: "Remote name (default origin)." },
        branch: { type: "string", description: "Branch (optional)." },
        setUpstream: { type: "boolean", description: "Pass -u on push to set the upstream." },
        ...cwdProp,
        ...timeoutProp,
      },
      ["op"]
    ),
    defineTool(
      "github_pr",
      "Work with pull requests via the GitHub CLI — the PR viewer + inspector. op=list/view/diff/checks are " +
        "read-only; op=create/comment/checkout are side-effecting (require approval). view+comments includes the " +
        "discussion; checks shows that PR's CI status.",
      {
        op: {
          type: "string",
          enum: ["list", "view", "diff", "checks", "create", "comment", "checkout"],
          description: "PR operation.",
        },
        number: { type: "string", description: "PR number (required for view/diff/checks/comment/checkout)." },
        title: { type: "string", description: "PR title (create)." },
        body: { type: "string", description: "PR body (create)." },
        base: { type: "string", description: "Base branch (create)." },
        head: { type: "string", description: "Head branch (create)." },
        draft: { type: "boolean", description: "Create as a draft PR." },
        comment: { type: "string", description: "Comment text (comment)." },
        comments: { type: "boolean", description: "Include the discussion thread (view)." },
        state: { type: "string", description: "Filter by state for list: open|closed|merged|all." },
        limit: { type: "number", description: "Max rows for list (default 20)." },
        ...cwdProp,
        ...timeoutProp,
      },
      ["op"]
    ),
    defineTool(
      "github_checks",
      "Inspect CI / GitHub Actions runs (the CI inspector). With no runId, lists recent workflow runs and their " +
        "status/conclusion (optionally filtered by branch or workflow); with a runId, shows that run (set " +
        "logFailed for failed-step logs). Read-only. Requires gh.",
      {
        runId: { type: "string", description: "A specific run id to view (optional)." },
        branch: { type: "string", description: "Filter runs by branch (list mode)." },
        workflow: { type: "string", description: "Filter runs by workflow name/file (list mode)." },
        logFailed: { type: "boolean", description: "Include logs of failed steps (view mode)." },
        limit: { type: "number", description: "Max runs to list (default 10)." },
        ...cwdProp,
        ...timeoutProp,
      }
    ),
    defineTool(
      "github_issue",
      "Work with issues via the GitHub CLI. op=list/view are read-only; op=create/comment are side-effecting " +
        "(require approval). Requires gh.",
      {
        op: { type: "string", enum: ["list", "view", "create", "comment"], description: "Issue operation." },
        number: { type: "string", description: "Issue number (view/comment)." },
        title: { type: "string", description: "Issue title (create)." },
        body: { type: "string", description: "Issue body (create)." },
        comment: { type: "string", description: "Comment text (comment)." },
        comments: { type: "boolean", description: "Include the discussion thread (view)." },
        state: { type: "string", description: "Filter by state for list: open|closed|all." },
        limit: { type: "number", description: "Max rows for list (default 20)." },
        ...cwdProp,
        ...timeoutProp,
      },
      ["op"]
    ),
    defineTool(
      "github_api",
      "Call the GitHub REST/GraphQL API through `gh api` for anything the dedicated tools don't cover. GET " +
        "(default) is read-only; any other method is side-effecting and requires approval. Requires gh + auth.",
      {
        endpoint: { type: "string", description: "API endpoint, e.g. repos/{owner}/{repo}/pulls or /user." },
        method: { type: "string", description: "HTTP method (default GET). Non-GET requires approval." },
        fields: {
          type: "object",
          description: "Key/value fields sent with -f (query params for GET, body fields otherwise).",
          additionalProperties: true,
        },
        ...cwdProp,
        ...timeoutProp,
      },
      ["endpoint"]
    ),
  ],
  handlers: {
    github_auth_status: authStatusHandler,
    github_clone: cloneHandler,
    github_status: statusHandler,
    github_log: logHandler,
    github_diff: diffHandler,
    github_commit: commitHandler,
    github_branch: branchHandler,
    github_sync: syncHandler,
    github_pr: prHandler,
    github_checks: checksHandler,
    github_issue: issueHandler,
    github_api: apiHandler,
  },
};

/** Test seam: reset the cached `gh` availability probe. */
export function __resetGhProbe(): void {
  ghProbe = null;
}
