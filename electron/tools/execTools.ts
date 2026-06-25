// Exec / run_python / run_node tool module — the "code interpreter" half of the MAOS
// tool catalog. Ported from CodemonkeyAi's GatedExec + run_python/run_node handlers
// (AppServices.cs) and RuntimePathResolver. Every tool here SPAWNS a real process, so
// each one is side-effecting and must clear ctx.approve before running.
//
// Interpreter resolution mirrors RuntimePathResolver / RuntimePathExtras: prefer a
// relocatable runtime bundled under `<repoRoot>/runtimes/{python,node}/bin/...` (so the
// app can run code fully offline), and only fall back to the system `python3`/`node`
// on PATH when no bundle is present.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineTool, type ToolContext, type ToolHandler, type ToolModule } from "./types";

/** Hard wall-clock limit for any spawned process. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Cap captured output per stream so a runaway process can't blow up memory. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB
/** The model only ever sees a truncated transcript. */
const MAX_RESULT_CHARS = 12_000;

const DENIED = "Denied by user.";

export interface ProcessOutcome {
  /** Combined stdout + stderr, in arrival order, already capped at MAX_BUFFER_BYTES. */
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Runtime resolution
// ---------------------------------------------------------------------------

/**
 * Candidate roots that may contain a `runtimes/` directory. When packaged,
 * electron-builder copies the runtimes under process.resourcesPath; in dev we
 * walk up from this module's directory until we find the repo's `runtimes/`.
 */
function runtimeRootCandidates(): string[] {
  const roots: string[] = [];
  const resources = process.resourcesPath;
  if (typeof resources === "string" && resources.length > 0) {
    roots.push(resources);
    // Some packagers nest the unpacked tree one level deeper.
    roots.push(path.join(resources, "app"));
  }
  // Dev: walk up from __dirname looking for a sibling `runtimes/` folder.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    roots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // De-dupe while preserving order.
  return Array.from(new Set(roots));
}

/**
 * Resolve a bundled interpreter binary for `engine` ("python" | "node").
 * Returns the absolute path to the executable if a bundle exists, else null.
 */
function resolveBundledInterpreter(engine: "python" | "node"): string | null {
  const binNames =
    engine === "python"
      ? process.platform === "win32"
        ? ["python.exe", "python3.exe"]
        : ["python3", "python"]
      : process.platform === "win32"
      ? ["node.exe"]
      : ["node"];

  for (const root of runtimeRootCandidates()) {
    const binDir = path.join(root, "runtimes", engine, "bin");
    for (const name of binNames) {
      const candidate = path.join(binDir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not present here; keep scanning.
      }
    }
    // Windows python-build-standalone places python.exe at the runtime root.
    if (engine === "python" && process.platform === "win32") {
      const candidate = path.join(root, "runtimes", "python", "python.exe");
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Pick the interpreter to run: bundled if available, else the system one on PATH.
 * Also returns the bundle's `bin` dir (if any) so we can prepend it to PATH —
 * this lets a bundled python find its sibling `pip`, and a bundled node find `npm`.
 */
function resolveInterpreter(engine: "python" | "node"): { command: string; binDir: string | null } {
  const bundled = resolveBundledInterpreter(engine);
  if (bundled) return { command: bundled, binDir: path.dirname(bundled) };
  const fallback = engine === "python" ? (process.platform === "win32" ? "python" : "python3") : "node";
  return { command: fallback, binDir: null };
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

function clampTimeout(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  // Callers pass seconds; normalize to milliseconds and clamp.
  const ms = n * 1000;
  return Math.min(Math.max(ms, 1000), MAX_TIMEOUT_MS);
}

/**
 * Spawn a process, capturing stdout+stderr interleaved (in arrival order) up to
 * MAX_BUFFER_BYTES, enforcing a wall-clock timeout. Never rejects on a non-zero
 * exit — the caller formats exit codes for the model.
 */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; binDir: string | null; timeoutMs: number; stdin?: string }
): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.binDir) {
      const sep = path.delimiter;
      const existing = env.PATH ?? env.Path ?? "";
      const merged = existing ? `${options.binDir}${sep}${existing}` : options.binDir;
      env.PATH = merged;
      if (process.platform === "win32") env.Path = merged;
    }

    let child: childProcess.ChildProcessWithoutNullStreams;
    try {
      child = childProcess.spawn(command, args, {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        output: `Failed to start ${command}: ${(error as Error).message}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
      });
      return;
    }

    const chunks: Buffer[] = [];
    let collected = 0;
    let truncated = false;
    let settled = false;

    const collect = (chunk: Buffer): void => {
      if (truncated) return;
      const remaining = MAX_BUFFER_BYTES - collected;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        collected = MAX_BUFFER_BYTES;
        truncated = true;
        // Stop feeding the buffer; killing here avoids unbounded work.
        child.kill("SIGKILL");
      } else {
        chunks.push(chunk);
        collected += chunk.length;
      }
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode,
        signal,
        timedOut,
        truncated,
      });
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      collect(Buffer.from(`\n[spawn error] ${error.message}\n`));
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function truncateForModel(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const head = text.slice(0, MAX_RESULT_CHARS);
  const omitted = text.length - MAX_RESULT_CHARS;
  return `${head}\n...[output truncated, ${omitted} more chars]`;
}

export function formatOutcome(label: string, outcome: ProcessOutcome): string {
  const lines: string[] = [];
  const body = outcome.output.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (body.length > 0) lines.push(body);
  if (outcome.truncated) lines.push("[output buffer limit reached; remainder discarded]");

  if (outcome.timedOut) {
    lines.push(`[${label} timed out and was killed]`);
  } else if (outcome.signal) {
    lines.push(`[${label} killed by signal ${outcome.signal}]`);
  }
  const code = outcome.timedOut ? 124 : outcome.exitCode ?? -1;
  lines.push(`exit code: ${code}`);
  return truncateForModel(lines.join("\n").trim());
}

export function firstString(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export function resolveCwd(args: Record<string, unknown>, ctx: ToolContext): string {
  const requested = firstString(args, "cwd", "working_directory", "workingDirectory");
  const base = requested || ctx.cwd || os.homedir();
  return path.isAbsolute(base) ? base : path.resolve(ctx.cwd || os.homedir(), base);
}

export function summarize(prefix: string, detail: string): string {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
  return `${prefix}: ${clipped}`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const execHandler: ToolHandler = async (args, ctx) => {
  const command = firstString(args, "command", "cmd", "shell");
  if (!command) return "Error: exec requires a 'command' string.";

  const cwd = resolveCwd(args, ctx);
  const timeoutMs = clampTimeout(args["timeoutSeconds"] ?? args["timeout"]);

  if (!(await ctx.approve({ tool: "exec", summary: summarize("Run shell command", command) }))) {
    return DENIED;
  }

  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/zsh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  const outcome = await runProcess(shell, shellArgs, { cwd, binDir: null, timeoutMs });
  return formatOutcome("command", outcome);
};

/** Shared body for run_python / run_node: accept inline code or a script path. */
async function runScript(
  engine: "python" | "node",
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const code = firstString(args, "code", "script", "snippet", "source");
  const file = firstString(args, "file", "path", "file_path", "scriptPath");
  if (!code && !file) {
    return `Error: ${toolName} requires inline 'code' or a 'file' path.`;
  }

  const cwd = resolveCwd(args, ctx);
  const timeoutMs = clampTimeout(args["timeoutSeconds"] ?? args["timeout"]);
  const { command, binDir } = resolveInterpreter(engine);

  const interpreterArgs: string[] = [];
  let stdin: string | undefined;
  let detail: string;
  if (file) {
    const resolved = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    interpreterArgs.push(resolved);
    // Pass any extra script args through (positional args after the script).
    const extra = args["args"];
    if (Array.isArray(extra)) interpreterArgs.push(...extra.map((a) => String(a)));
    detail = `script ${resolved}`;
  } else {
    // Read code from stdin so we never touch the filesystem for an inline snippet.
    interpreterArgs.push(engine === "python" ? "-" : "-");
    stdin = code;
    detail = code;
  }

  const engineLabel = engine === "python" ? "Python" : "Node";
  if (
    !(await ctx.approve({
      tool: toolName,
      summary: summarize(`Run ${engineLabel} ${file ? "script" : "snippet"}`, detail),
    }))
  ) {
    return DENIED;
  }

  const outcome = await runProcess(command, interpreterArgs, { cwd, binDir, timeoutMs, stdin });
  return formatOutcome(`${engineLabel} process`, outcome);
}

const runPythonHandler: ToolHandler = (args, ctx) => runScript("python", "run_python", args, ctx);
const runNodeHandler: ToolHandler = (args, ctx) => runScript("node", "run_node", args, ctx);

// ---------------------------------------------------------------------------
// Definitions + module
// ---------------------------------------------------------------------------

const execDefinition = defineTool(
  "exec",
  "Run a shell command and capture its combined stdout/stderr and exit code. " +
    "Side-effecting: requires user approval. Use absolute paths and quote any path containing spaces.",
  {
    command: { type: "string", description: "The shell command line to execute." },
    cwd: { type: "string", description: "Absolute working directory (defaults to the session cwd)." },
    timeoutSeconds: {
      type: "number",
      description: `Wall-clock timeout in seconds (default ${DEFAULT_TIMEOUT_MS / 1000}, max ${
        MAX_TIMEOUT_MS / 1000
      }).`,
    },
  },
  ["command"]
);

const runPythonDefinition = defineTool(
  "run_python",
  "Run a Python script or inline snippet with the bundled CPython runtime (falls back to system python3). " +
    "Provide inline 'code' OR a 'file' path. Side-effecting: requires user approval. " +
    "Returns combined stdout/stderr and exit code.",
  {
    code: { type: "string", description: "Inline Python source to execute via stdin." },
    file: { type: "string", description: "Path to a .py script to run instead of inline code." },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Extra positional arguments passed to the script (file mode only).",
    },
    cwd: { type: "string", description: "Absolute working directory (defaults to the session cwd)." },
    timeoutSeconds: {
      type: "number",
      description: `Wall-clock timeout in seconds (default ${DEFAULT_TIMEOUT_MS / 1000}, max ${
        MAX_TIMEOUT_MS / 1000
      }).`,
    },
  }
);

const runNodeDefinition = defineTool(
  "run_node",
  "Run a Node.js script or inline snippet with the bundled Node runtime (falls back to system node). " +
    "Provide inline 'code' OR a 'file' path. Side-effecting: requires user approval. " +
    "Returns combined stdout/stderr and exit code.",
  {
    code: { type: "string", description: "Inline JavaScript source to execute via stdin." },
    file: { type: "string", description: "Path to a .js/.mjs script to run instead of inline code." },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Extra positional arguments passed to the script (file mode only).",
    },
    cwd: { type: "string", description: "Absolute working directory (defaults to the session cwd)." },
    timeoutSeconds: {
      type: "number",
      description: `Wall-clock timeout in seconds (default ${DEFAULT_TIMEOUT_MS / 1000}, max ${
        MAX_TIMEOUT_MS / 1000
      }).`,
    },
  }
);

export const execToolsModule: ToolModule = {
  definitions: [execDefinition, runPythonDefinition, runNodeDefinition],
  handlers: {
    exec: execHandler,
    run_python: runPythonHandler,
    run_node: runNodeHandler,
  },
};
