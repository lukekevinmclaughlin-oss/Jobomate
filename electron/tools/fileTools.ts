// Core coding-harness file toolkit: workspace, discovery, reading, editing,
// creation, diff awareness, and recovery. These are the "minimum harness"
// primitives that let the connected model actually build software instead of
// only describing it — everything else (exec, git, browser) already exists.
//
// Design rules, mirrored from the other tool modules:
//  - Pure Node (fs/path/os) — no Electron imports, so it stays unit-testable.
//  - Read-only tools run freely; every mutation clears ctx.approve first.
//  - Sensitive paths (~/.ssh, keychains, …) are refused via security/policy.
//  - Every mutation snapshots the previous file content into a session
//    checkpoint directory, so list_file_changes / undo_file_change give the
//    model (and the user) real diff awareness and one-step recovery.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSensitivePath } from "../security/policy";
import { defineTool, type ToolContext, type ToolHandler, type ToolModule } from "./types";

const DENIED = "Denied by user.";
/** Refuse to read files larger than this (the model can request ranges). */
const MAX_READ_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Cap any tool result so a giant file can't blow up the context window. */
const MAX_RESULT_CHARS = 24_000;
const DEFAULT_READ_LINES = 1_500;
/** Directories that are never worth walking for glob/grep. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "build",
  "out",
  "release",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "bin",
  "obj",
  ".cache",
  "DerivedData",
  "Pods",
  "target",
]);
/** Hard ceiling on files visited per walk so a stray "/" glob can't hang. */
const MAX_WALK_ENTRIES = 40_000;

// ---------------------------------------------------------------------------
// Workspace state (session-scoped)
// ---------------------------------------------------------------------------

let workspaceDir: string | null = null;

/** The active workspace folder, used by the host as the default tool cwd. */
export function getWorkspaceDir(): string | null {
  return workspaceDir;
}

/** Test hook + set_workspace implementation detail. */
export function setWorkspaceDirForTest(dir: string | null): void {
  workspaceDir = dir;
}

// ---------------------------------------------------------------------------
// Checkpoints + change journal (session-scoped)
// ---------------------------------------------------------------------------

export type ChangeKind = "create" | "edit" | "overwrite" | "delete" | "move" | "copy";

export interface FileChange {
  /** 1-based id, referenced by undo_file_change. */
  id: number;
  kind: ChangeKind;
  /** Absolute path the change applied to (destination for move/copy). */
  filePath: string;
  /** Absolute checkpoint copy of the PREVIOUS content (null when file was new). */
  checkpointPath: string | null;
  /** For move: the original source path (undo restores it there). */
  fromPath?: string;
  at: string;
  undone: boolean;
}

const changeJournal: FileChange[] = [];
let checkpointRoot: string | null = null;

function ensureCheckpointRoot(): string {
  if (!checkpointRoot) {
    checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jobomate-checkpoints-"));
  }
  return checkpointRoot;
}

/** Snapshot the current content of filePath (if it exists) into the checkpoint dir. */
function snapshotFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const dir = ensureCheckpointRoot();
    const name = `${changeJournal.length + 1}-${path.basename(filePath)}`;
    const dest = path.join(dir, name);
    fs.copyFileSync(filePath, dest);
    return dest;
  } catch {
    return null;
  }
}

function recordChange(kind: ChangeKind, filePath: string, checkpointPath: string | null, fromPath?: string): FileChange {
  const change: FileChange = {
    id: changeJournal.length + 1,
    kind,
    filePath,
    checkpointPath,
    fromPath,
    at: new Date().toISOString(),
    undone: false,
  };
  changeJournal.push(change);
  return change;
}

/** Test hook: reset journal + workspace between tests. */
export function resetFileToolStateForTest(): void {
  changeJournal.length = 0;
  workspaceDir = null;
  checkpointRoot = null;
}

// ---------------------------------------------------------------------------
// Path + formatting helpers
// ---------------------------------------------------------------------------

function resolveAgainst(ctx: ToolContext, raw: string): string {
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(workspaceDir || ctx.cwd || os.homedir(), expanded);
}

function requirePath(args: Record<string, unknown>, ctx: ToolContext, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return resolveAgainst(ctx, value.trim());
  }
  return null;
}

function guardSensitive(filePath: string): string | null {
  if (isSensitivePath(filePath)) {
    return `Refused: ${filePath} is inside a protected location (credentials/keychain).`;
  }
  return null;
}

function clip(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Convert a simple glob (`*`, `**`, `?`) into a RegExp over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (glob[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 2;
        } else {
          pattern += ".*";
          i += 1;
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (ch === "?") {
      pattern += "[^/]";
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

interface WalkOptions {
  includeIgnored?: boolean;
  maxEntries?: number;
}

/** Depth-first walk yielding relative file paths (forward slashes). */
function walkFiles(root: string, options: WalkOptions = {}): { files: string[]; capped: boolean } {
  const max = options.maxEntries ?? MAX_WALK_ENTRIES;
  const files: string[] = [];
  let visited = 0;
  let capped = false;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = rel ? path.join(root, rel) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > max) {
        capped = true;
        return { files, capped };
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!options.includeIgnored && (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("."))) continue;
        stack.push(childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  }
  return { files, capped };
}

// ---------------------------------------------------------------------------
// Minimal unified diff (LCS-based) for diff awareness without a dependency
// ---------------------------------------------------------------------------

export function unifiedDiff(before: string, after: string, label: string, context = 2): string {
  if (before === after) return "(no changes)";
  const a = before.split("\n");
  const b = after.split("\n");
  // Myers would be ideal; an LCS table is fine at these sizes. Guard the cost.
  if (a.length * b.length > 4_000_000) {
    return `--- ${label} (before)\n+++ ${label} (after)\n[diff too large to render; ${a.length} -> ${b.length} lines]`;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  type Op = { tag: " " | "-" | "+"; line: string; aIdx: number; bIdx: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i], aIdx: i, bIdx: j });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      ops.push({ tag: "-", line: a[i], aIdx: i, bIdx: j });
      i += 1;
    } else {
      ops.push({ tag: "+", line: b[j], aIdx: i, bIdx: j });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ tag: "-", line: a[i], aIdx: i, bIdx: j });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ tag: "+", line: b[j], aIdx: i, bIdx: j });
    j += 1;
  }

  // Group changed ops into hunks with `context` lines of surrounding equality.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k].tag !== " ") {
      for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c += 1) keep[c] = true;
    }
  }
  const lines: string[] = [`--- ${label} (before)`, `+++ ${label} (after)`];
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      k += 1;
      continue;
    }
    let end = k;
    while (end < ops.length && keep[end]) end += 1;
    const hunk = ops.slice(k, end);
    const aStart = (hunk.find((o) => o.tag !== "+")?.aIdx ?? hunk[0].aIdx) + 1;
    const bStart = (hunk.find((o) => o.tag !== "-")?.bIdx ?? hunk[0].bIdx) + 1;
    const aCount = hunk.filter((o) => o.tag !== "+").length;
    const bCount = hunk.filter((o) => o.tag !== "-").length;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) lines.push(`${op.tag}${op.line}`);
    k = end;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handlers — workspace + discovery + reading (no approval needed)
// ---------------------------------------------------------------------------

const setWorkspaceHandler: ToolHandler = async (args, ctx) => {
  const dir = requirePath(args, ctx, "path", "dir", "directory", "folder");
  if (!dir) return "Error: set_workspace requires a 'path'.";
  const sensitive = guardSensitive(dir);
  if (sensitive) return sensitive;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return `Error: ${dir} is not a directory.`;
  } catch {
    return `Error: directory does not exist: ${dir}`;
  }
  workspaceDir = dir;
  return `Workspace set to ${dir}. Relative paths in file/exec tools now resolve here.`;
};

const getWorkspaceHandler: ToolHandler = async (_args, ctx) => {
  const dir = workspaceDir || ctx.cwd || os.homedir();
  const note = workspaceDir ? "explicitly set" : "default (no workspace set yet — use set_workspace)";
  return `Current workspace: ${dir} (${note})`;
};

const listDirHandler: ToolHandler = async (args, ctx) => {
  const dir = requirePath(args, ctx, "path", "dir", "directory") || workspaceDir || ctx.cwd || os.homedir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return `Error: cannot list ${dir}: ${(error as Error).message}`;
  }
  const rows = entries
    .slice(0, 500)
    .map((entry) => {
      const full = path.join(dir, entry.name);
      let size = "";
      let mtime = "";
      try {
        const stat = fs.statSync(full);
        size = entry.isFile() ? formatBytes(stat.size) : "";
        mtime = stat.mtime.toISOString().slice(0, 16).replace("T", " ");
      } catch {
        // stat failures (dangling symlink etc.) leave the columns blank
      }
      const kind = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
      return `${kind}  ${entry.name}${size ? `  (${size})` : ""}${mtime ? `  ${mtime}` : ""}`;
    });
  const capped = entries.length > 500 ? `\n...[${entries.length - 500} more entries]` : "";
  return clip(`${dir}:\n${rows.join("\n") || "(empty)"}${capped}`);
};

const globHandler: ToolHandler = async (args, ctx) => {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) return "Error: glob_files requires a 'pattern' (e.g. src/**/*.ts).";
  const root = requirePath(args, ctx, "path", "root", "dir") || workspaceDir || ctx.cwd || os.homedir();
  const re = globToRegExp(pattern.replace(/\\/g, "/"));
  const { files, capped } = walkFiles(root);
  const matches = files.filter((f) => re.test(f));
  // Newest-first so the model sees recently-touched files at the top.
  const withTimes = matches
    .map((f) => {
      let t = 0;
      try {
        t = fs.statSync(path.join(root, f)).mtimeMs;
      } catch {
        // unreadable entries sort last
      }
      return { f, t };
    })
    .sort((x, y) => y.t - x.t)
    .map((e) => e.f);
  const shown = withTimes.slice(0, 400);
  const suffix =
    (withTimes.length > shown.length ? `\n...[${withTimes.length - shown.length} more matches]` : "") +
    (capped ? "\n[walk stopped early — directory tree is very large]" : "");
  return clip(`${withTimes.length} match(es) for ${pattern} under ${root}:\n${shown.join("\n") || "(none)"}${suffix}`);
};

const grepHandler: ToolHandler = async (args, ctx) => {
  const rawPattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!rawPattern) return "Error: grep_search requires a 'pattern' (regular expression).";
  const root = requirePath(args, ctx, "path", "root", "dir") || workspaceDir || ctx.cwd || os.homedir();
  const fileGlob = typeof args.include === "string" && args.include.trim() ? globToRegExp(args.include.trim()) : null;
  const caseInsensitive = args.case_insensitive !== false; // default on: models rarely know exact casing
  let re: RegExp;
  try {
    re = new RegExp(rawPattern, caseInsensitive ? "i" : "");
  } catch (error) {
    return `Error: invalid regex: ${(error as Error).message}`;
  }
  const maxResults = 200;
  const { files, capped } = walkFiles(root);
  const hits: string[] = [];
  let filesWithHits = 0;
  for (const rel of files) {
    if (fileGlob && !fileGlob.test(rel)) continue;
    const abs = path.join(root, rel);
    let buffer: Buffer;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_READ_BYTES) continue;
      buffer = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split("\n");
    let hitInFile = false;
    for (let ln = 0; ln < lines.length; ln += 1) {
      if (re.test(lines[ln])) {
        hitInFile = true;
        hits.push(`${rel}:${ln + 1}: ${lines[ln].trim().slice(0, 240)}`);
        if (hits.length >= maxResults) break;
      }
    }
    if (hitInFile) filesWithHits += 1;
    if (hits.length >= maxResults) break;
  }
  const suffix =
    (hits.length >= maxResults ? `\n...[stopped at ${maxResults} matches]` : "") +
    (capped ? "\n[walk stopped early — directory tree is very large]" : "");
  return clip(
    `${hits.length} match(es) in ${filesWithHits} file(s) for /${rawPattern}/ under ${root}:\n${hits.join("\n") || "(none)"}${suffix}`
  );
};

const readFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = requirePath(args, ctx, "path", "file", "file_path");
  if (!filePath) return "Error: read_file requires a 'path'.";
  const sensitive = guardSensitive(filePath);
  if (sensitive) return sensitive;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return `Error: file not found: ${filePath}`;
  }
  if (stat.isDirectory()) return `Error: ${filePath} is a directory — use list_dir.`;
  if (stat.size > MAX_READ_BYTES) {
    return `Error: file is ${formatBytes(stat.size)} (limit ${formatBytes(MAX_READ_BYTES)}). Use offset/limit to read a range, or grep_search to locate the relevant part.`;
  }
  const buffer = fs.readFileSync(filePath);
  if (looksBinary(buffer)) {
    return `Binary file: ${filePath} (${formatBytes(stat.size)}). Not showing raw bytes — use a dedicated tool (read_pdf, ocr_image, …) if applicable.`;
  }
  const lines = buffer.toString("utf8").split("\n");
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.max(1, Math.min(Number(args.limit) || DEFAULT_READ_LINES, 5000));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((line, idx) => `${String(offset + idx).padStart(5)}\t${line}`);
  const more = offset - 1 + limit < lines.length ? `\n...[${lines.length - (offset - 1 + limit)} more lines — call read_file with offset=${offset + limit}]` : "";
  return clip(`${filePath} (${lines.length} lines):\n${numbered.join("\n")}${more}`);
};

const fileInfoHandler: ToolHandler = async (args, ctx) => {
  const filePath = requirePath(args, ctx, "path", "file", "file_path");
  if (!filePath) return "Error: file_info requires a 'path'.";
  try {
    const stat = fs.statSync(filePath);
    const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    return [
      `path: ${filePath}`,
      `type: ${kind}`,
      `size: ${formatBytes(stat.size)}`,
      `modified: ${stat.mtime.toISOString()}`,
      `created: ${stat.birthtime.toISOString()}`,
      `mode: ${(stat.mode & 0o777).toString(8)}`,
    ].join("\n");
  } catch {
    return `Not found: ${filePath}`;
  }
};

// ---------------------------------------------------------------------------
// Handlers — mutations (approval-gated, checkpointed)
// ---------------------------------------------------------------------------

const writeFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = requirePath(args, ctx, "path", "file", "file_path");
  if (!filePath) return "Error: write_file requires a 'path'.";
  const content = typeof args.content === "string" ? args.content : null;
  if (content === null) return "Error: write_file requires string 'content'.";
  const sensitive = guardSensitive(filePath);
  if (sensitive) return sensitive;

  const exists = fs.existsSync(filePath);
  const verb = exists ? "Overwrite" : "Create";
  if (!(await ctx.approve({ tool: "write_file", summary: `${verb} ${filePath} (${formatBytes(Buffer.byteLength(content))})` }))) {
    return DENIED;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const checkpoint = exists ? snapshotFile(filePath) : null;
    fs.writeFileSync(filePath, content, "utf8");
    const change = recordChange(exists ? "overwrite" : "create", filePath, checkpoint);
    return `${verb === "Create" ? "Created" : "Overwrote"} ${filePath} (${content.split("\n").length} lines). Change #${change.id} recorded — undo_file_change can revert it.`;
  } catch (error) {
    return `Error writing ${filePath}: ${(error as Error).message}`;
  }
};

const editFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = requirePath(args, ctx, "path", "file", "file_path");
  if (!filePath) return "Error: edit_file requires a 'path'.";
  const oldText = typeof args.old_text === "string" ? args.old_text : typeof args.old_string === "string" ? args.old_string : "";
  const newText = typeof args.new_text === "string" ? args.new_text : typeof args.new_string === "string" ? args.new_string : "";
  if (!oldText) return "Error: edit_file requires 'old_text' (the exact text to replace).";
  const replaceAll = args.replace_all === true;
  const sensitive = guardSensitive(filePath);
  if (sensitive) return sensitive;

  let before: string;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_READ_BYTES) return `Error: file too large to edit in place (${formatBytes(stat.size)}).`;
    const buffer = fs.readFileSync(filePath);
    if (looksBinary(buffer)) return `Error: ${filePath} looks binary — refusing a text edit.`;
    before = buffer.toString("utf8");
  } catch {
    return `Error: file not found: ${filePath}`;
  }

  const occurrences = before.split(oldText).length - 1;
  if (occurrences === 0) {
    return `Error: old_text not found in ${filePath}. Read the file again — the exact text (including whitespace) must match.`;
  }
  if (occurrences > 1 && !replaceAll) {
    return `Error: old_text appears ${occurrences} times in ${filePath}. Add more surrounding context to make it unique, or pass replace_all=true.`;
  }

  const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
  const summaryDiff = unifiedDiff(before, after, path.basename(filePath));
  if (
    !(await ctx.approve({
      tool: "edit_file",
      summary: `Edit ${filePath}: replace ${occurrences > 1 ? `${occurrences} occurrences` : "1 occurrence"} (${oldText.length} -> ${newText.length} chars)`,
    }))
  ) {
    return DENIED;
  }
  try {
    const checkpoint = snapshotFile(filePath);
    fs.writeFileSync(filePath, after, "utf8");
    const change = recordChange("edit", filePath, checkpoint);
    return clip(`Edited ${filePath} (change #${change.id}).\n${summaryDiff}`);
  } catch (error) {
    return `Error editing ${filePath}: ${(error as Error).message}`;
  }
};

const mkdirHandler: ToolHandler = async (args, ctx) => {
  const dir = requirePath(args, ctx, "path", "dir", "directory");
  if (!dir) return "Error: make_dir requires a 'path'.";
  const sensitive = guardSensitive(dir);
  if (sensitive) return sensitive;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return `Created directory ${dir} (with parents).`;
  } catch (error) {
    return `Error creating ${dir}: ${(error as Error).message}`;
  }
};

const movePathHandler: ToolHandler = async (args, ctx) => {
  const from = requirePath(args, ctx, "from", "source", "src");
  const to = requirePath(args, ctx, "to", "destination", "dest");
  if (!from || !to) return "Error: move_path requires 'from' and 'to'.";
  const sensitive = guardSensitive(from) || guardSensitive(to);
  if (sensitive) return sensitive;
  if (!fs.existsSync(from)) return `Error: source not found: ${from}`;
  if (!(await ctx.approve({ tool: "move_path", summary: `Move ${from} -> ${to}` }))) return DENIED;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const checkpoint = snapshotFile(to); // moving over an existing file keeps its old content recoverable
    fs.renameSync(from, to);
    const change = recordChange("move", to, checkpoint, from);
    return `Moved ${from} -> ${to} (change #${change.id}).`;
  } catch (error) {
    return `Error moving: ${(error as Error).message}`;
  }
};

const copyPathHandler: ToolHandler = async (args, ctx) => {
  const from = requirePath(args, ctx, "from", "source", "src");
  const to = requirePath(args, ctx, "to", "destination", "dest");
  if (!from || !to) return "Error: copy_path requires 'from' and 'to'.";
  const sensitive = guardSensitive(from) || guardSensitive(to);
  if (sensitive) return sensitive;
  if (!fs.existsSync(from)) return `Error: source not found: ${from}`;
  if (!(await ctx.approve({ tool: "copy_path", summary: `Copy ${from} -> ${to}` }))) return DENIED;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const checkpoint = snapshotFile(to);
    fs.cpSync(from, to, { recursive: true });
    const change = recordChange("copy", to, checkpoint);
    return `Copied ${from} -> ${to} (change #${change.id}).`;
  } catch (error) {
    return `Error copying: ${(error as Error).message}`;
  }
};

const deletePathHandler: ToolHandler = async (args, ctx) => {
  const target = requirePath(args, ctx, "path", "file", "file_path");
  if (!target) return "Error: delete_path requires a 'path'.";
  const sensitive = guardSensitive(target);
  if (sensitive) return sensitive;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return `Error: not found: ${target}`;
  }
  if (stat.isDirectory()) {
    // Directories are deleted without a checkpoint (snapshotting a tree can be
    // huge); make that explicit in the approval prompt.
    if (!(await ctx.approve({ tool: "delete_path", summary: `Delete DIRECTORY ${target} recursively (NOT undoable)` }))) {
      return DENIED;
    }
    try {
      fs.rmSync(target, { recursive: true });
      return `Deleted directory ${target}. This was not checkpointed and cannot be undone by undo_file_change.`;
    } catch (error) {
      return `Error deleting ${target}: ${(error as Error).message}`;
    }
  }
  if (!(await ctx.approve({ tool: "delete_path", summary: `Delete file ${target}` }))) return DENIED;
  try {
    const checkpoint = snapshotFile(target);
    fs.rmSync(target);
    const change = recordChange("delete", target, checkpoint);
    return `Deleted ${target} (change #${change.id} — undo_file_change restores it).`;
  } catch (error) {
    return `Error deleting ${target}: ${(error as Error).message}`;
  }
};

// ---------------------------------------------------------------------------
// Handlers — diff awareness + recovery
// ---------------------------------------------------------------------------

const listChangesHandler: ToolHandler = async () => {
  if (changeJournal.length === 0) return "No file changes recorded this session.";
  const rows = changeJournal.map((c) => {
    const undo = c.undone ? " [undone]" : "";
    const from = c.fromPath ? ` (from ${c.fromPath})` : "";
    return `#${c.id} ${c.kind} ${c.filePath}${from} at ${c.at}${undo}`;
  });
  return clip(`Session file changes (undo_file_change with the #id to revert):\n${rows.join("\n")}`);
};

const diffChangeHandler: ToolHandler = async (args) => {
  const id = Number(args.id);
  const change = changeJournal.find((c) => c.id === id);
  if (!change) return `Error: no change #${args.id}. Call list_file_changes first.`;
  const beforeText = change.checkpointPath && fs.existsSync(change.checkpointPath)
    ? fs.readFileSync(change.checkpointPath, "utf8")
    : "";
  let afterText = "";
  try {
    const buffer = fs.readFileSync(change.filePath);
    afterText = looksBinary(buffer) ? "[binary]" : buffer.toString("utf8");
  } catch {
    afterText = "";
  }
  return clip(unifiedDiff(beforeText, afterText, path.basename(change.filePath)));
};

const undoChangeHandler: ToolHandler = async (args, ctx) => {
  const id = Number(args.id);
  const change = changeJournal.find((c) => c.id === id);
  if (!change) return `Error: no change #${args.id}. Call list_file_changes first.`;
  if (change.undone) return `Change #${id} was already undone.`;
  if (!(await ctx.approve({ tool: "undo_file_change", summary: `Undo change #${id} (${change.kind} ${change.filePath})` }))) {
    return DENIED;
  }
  try {
    if (change.kind === "create") {
      if (fs.existsSync(change.filePath)) fs.rmSync(change.filePath);
    } else if (change.kind === "move" && change.fromPath) {
      fs.renameSync(change.filePath, change.fromPath);
      if (change.checkpointPath && fs.existsSync(change.checkpointPath)) {
        fs.copyFileSync(change.checkpointPath, change.filePath);
      }
    } else if (change.checkpointPath && fs.existsSync(change.checkpointPath)) {
      fs.mkdirSync(path.dirname(change.filePath), { recursive: true });
      fs.copyFileSync(change.checkpointPath, change.filePath);
    } else {
      return `Error: no checkpoint stored for change #${id}; cannot undo.`;
    }
    change.undone = true;
    return `Undid change #${id}: ${change.kind} ${change.filePath}.`;
  } catch (error) {
    return `Error undoing change #${id}: ${(error as Error).message}`;
  }
};

// ---------------------------------------------------------------------------
// Definitions + module
// ---------------------------------------------------------------------------

const pathProp = (description: string) => ({ type: "string", description });

export const fileToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "set_workspace",
      "Set the working folder for this session. Relative paths in every file tool and in exec/run_python/run_node resolve against it. Set this FIRST when working on a project.",
      { path: pathProp("Absolute path to the project folder (or ~ relative).") },
      ["path"]
    ),
    defineTool("get_workspace", "Show the current workspace folder used for relative paths.", {}),
    defineTool(
      "list_dir",
      "List a directory's entries with type, size and modified time. Defaults to the workspace.",
      { path: pathProp("Directory to list (defaults to the workspace).") }
    ),
    defineTool(
      "glob_files",
      "Find files matching a glob pattern (e.g. src/**/*.ts, **/*.test.*). Recursive; skips node_modules/.git/build dirs; newest first.",
      {
        pattern: pathProp("Glob pattern relative to the search root."),
        path: pathProp("Root directory to search (defaults to the workspace)."),
      },
      ["pattern"]
    ),
    defineTool(
      "grep_search",
      "Search file CONTENTS with a regular expression. Returns file:line: matched-text. Case-insensitive by default. Skips binaries and build dirs.",
      {
        pattern: pathProp("Regular expression to search for."),
        path: pathProp("Root directory to search (defaults to the workspace)."),
        include: pathProp("Optional filename glob filter, e.g. **/*.ts."),
        case_insensitive: { type: "boolean", description: "Default true; pass false for exact-case search." },
      },
      ["pattern"]
    ),
    defineTool(
      "read_file",
      "Read a text file with line numbers. Use offset/limit for big files. Binary files are refused with guidance.",
      {
        path: pathProp("File to read."),
        offset: { type: "number", description: "1-based first line to read (default 1)." },
        limit: { type: "number", description: `Max lines to return (default ${DEFAULT_READ_LINES}, max 5000).` },
      },
      ["path"]
    ),
    defineTool("file_info", "Stat a path: type, size, modified/created times, mode.", { path: pathProp("Path to stat.") }, ["path"]),
    defineTool(
      "write_file",
      "Create or overwrite a text file with the given content (parent dirs auto-created). Overwrites are checkpointed so undo_file_change can revert. Requires user approval.",
      {
        path: pathProp("File to write."),
        content: { type: "string", description: "Full new file content." },
      },
      ["path", "content"]
    ),
    defineTool(
      "edit_file",
      "Targeted in-place edit: replace an exact old_text snippet with new_text. old_text must match exactly (including whitespace) and be unique unless replace_all=true. Checkpointed + undoable. Requires user approval. Returns the resulting diff.",
      {
        path: pathProp("File to edit."),
        old_text: { type: "string", description: "Exact existing text to replace." },
        new_text: { type: "string", description: "Replacement text (empty string deletes old_text)." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      ["path", "old_text", "new_text"]
    ),
    defineTool("make_dir", "Create a directory (with parents).", { path: pathProp("Directory to create.") }, ["path"]),
    defineTool(
      "move_path",
      "Move/rename a file or directory. Requires user approval; overwritten files are checkpointed.",
      { from: pathProp("Source path."), to: pathProp("Destination path.") },
      ["from", "to"]
    ),
    defineTool(
      "copy_path",
      "Copy a file or directory (recursive). Requires user approval.",
      { from: pathProp("Source path."), to: pathProp("Destination path.") },
      ["from", "to"]
    ),
    defineTool(
      "delete_path",
      "Delete a file (checkpointed + undoable) or a directory (recursive, NOT undoable). Requires user approval.",
      { path: pathProp("Path to delete.") },
      ["path"]
    ),
    defineTool(
      "list_file_changes",
      "List every file mutation made this session (create/edit/overwrite/delete/move/copy) with ids for undo_file_change.",
      {}
    ),
    defineTool(
      "diff_file_change",
      "Show the unified diff for a recorded change id (before-checkpoint vs current content).",
      { id: { type: "number", description: "Change id from list_file_changes." } },
      ["id"]
    ),
    defineTool(
      "undo_file_change",
      "Revert a recorded change by id: restores the checkpointed content (or removes a created file, or reverses a move). Requires user approval.",
      { id: { type: "number", description: "Change id from list_file_changes." } },
      ["id"]
    ),
  ],
  handlers: {
    set_workspace: setWorkspaceHandler,
    get_workspace: getWorkspaceHandler,
    list_dir: listDirHandler,
    glob_files: globHandler,
    grep_search: grepHandler,
    read_file: readFileHandler,
    file_info: fileInfoHandler,
    write_file: writeFileHandler,
    edit_file: editFileHandler,
    make_dir: mkdirHandler,
    move_path: movePathHandler,
    copy_path: copyPathHandler,
    delete_path: deletePathHandler,
    list_file_changes: listChangesHandler,
    diff_file_change: diffChangeHandler,
    undo_file_change: undoChangeHandler,
  },
};
