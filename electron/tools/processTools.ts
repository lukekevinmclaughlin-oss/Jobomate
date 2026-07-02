// Long-running / background process control: dev servers, watchers, build
// daemons. `exec` (execTools.ts) is one-shot and blocks until exit; these tools
// let the model START a server, keep working, poll its LOG OUTPUT, wait for it
// to become reachable, and STOP it — the runtime-process-control leg of the
// harness. Pure Node so it stays unit-testable; the Electron host calls
// shutdownAllProcesses() on app quit so nothing leaks past the session.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { defineTool, type ToolContext, type ToolHandler, type ToolModule } from "./types";
import { firstString, resolveCwd, summarize } from "./processRunner";

const DENIED = "Denied by user.";
/** Ring buffer per process so a chatty server can't grow without bound. */
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_RESULT_CHARS = 12_000;
const MAX_PROCESSES = 16;

interface ManagedProcess {
  id: number;
  name: string;
  command: string;
  cwd: string;
  child: childProcess.ChildProcess;
  /** Interleaved stdout+stderr, trimmed from the front past MAX_LOG_BYTES. */
  log: Buffer[];
  logBytes: number;
  startedAt: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

const processes = new Map<number, ManagedProcess>();
let nextId = 1;

/** Pick a shell that actually exists on this machine (zsh is macOS-only). */
export function defaultShell(): { shell: string; args: (command: string) => string[] } {
  if (process.platform === "win32") {
    return { shell: "cmd.exe", args: (command) => ["/d", "/s", "/c", command] };
  }
  for (const candidate of [process.env.SHELL, "/bin/zsh", "/bin/bash"]) {
    if (candidate && fs.existsSync(candidate)) {
      return { shell: candidate, args: (command) => ["-lc", command] };
    }
  }
  return { shell: "/bin/sh", args: (command) => ["-c", command] };
}

function appendLog(proc: ManagedProcess, chunk: Buffer): void {
  proc.log.push(chunk);
  proc.logBytes += chunk.length;
  while (proc.logBytes > MAX_LOG_BYTES && proc.log.length > 1) {
    const dropped = proc.log.shift() as Buffer;
    proc.logBytes -= dropped.length;
  }
}

function logText(proc: ManagedProcess): string {
  return Buffer.concat(proc.log).toString("utf8");
}

function statusLine(proc: ManagedProcess): string {
  const state = proc.exited
    ? `exited (code ${proc.exitCode ?? "?"}${proc.exitSignal ? `, signal ${proc.exitSignal}` : ""})`
    : `running (pid ${proc.child.pid})`;
  return `#${proc.id} "${proc.name}" — ${state} — started ${proc.startedAt} — cmd: ${proc.command}`;
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `...[${text.length - maxChars} earlier chars trimmed]\n${text.slice(-maxChars)}`;
}

/**
 * Signal a managed process AND its descendants. The command runs in its own
 * process group (detached spawn), so a negative-pid kill reaches the whole
 * tree — stopping "npm run dev" must also stop the node server it spawned,
 * not orphan it holding the log pipes.
 */
function signalTree(proc: ManagedProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && proc.child.pid) {
      process.kill(-proc.child.pid, signal);
    } else {
      proc.child.kill(signal);
    }
  } catch {
    // already gone
  }
}

/** Kill every still-running managed process. Wired to Electron's will-quit. */
export function shutdownAllProcesses(): void {
  for (const proc of processes.values()) {
    if (!proc.exited) {
      signalTree(proc, "SIGTERM");
      setTimeout(() => {
        if (!proc.exited) signalTree(proc, "SIGKILL");
      }, 2000).unref?.();
    }
  }
}

/** Test hook. */
export function resetProcessStateForTest(): void {
  shutdownAllProcesses();
  processes.clear();
  nextId = 1;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const startProcessHandler: ToolHandler = async (args, ctx: ToolContext) => {
  const command = firstString(args, "command", "cmd");
  if (!command) return "Error: start_process requires a 'command'.";
  const running = [...processes.values()].filter((p) => !p.exited);
  if (running.length >= MAX_PROCESSES) {
    return `Error: ${MAX_PROCESSES} background processes are already running — stop one first (list_processes / stop_process).`;
  }
  const name = firstString(args, "name", "label") || command.split(/\s+/)[0];
  const cwd = resolveCwd(args, ctx);

  if (!(await ctx.approve({ tool: "start_process", summary: summarize(`Start background process "${name}"`, command) }))) {
    return DENIED;
  }

  const { shell, args: shellArgsFor } = defaultShell();
  let child: childProcess.ChildProcess;
  try {
    child = childProcess.spawn(shell, shellArgsFor(command), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so stop_process can signal the whole tree.
      detached: process.platform !== "win32",
    });
  } catch (error) {
    return `Failed to start: ${(error as Error).message}`;
  }

  const proc: ManagedProcess = {
    id: nextId++,
    name,
    command,
    cwd,
    child,
    log: [],
    logBytes: 0,
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    exitSignal: null,
  };
  processes.set(proc.id, proc);

  child.stdout?.on("data", (chunk: Buffer) => appendLog(proc, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendLog(proc, chunk));
  child.on("error", (error) => appendLog(proc, Buffer.from(`\n[spawn error] ${error.message}\n`)));
  // "exit" fires when the process terminates even if an orphaned grandchild
  // still holds the stdio pipes ("close" would wait for those).
  const markExited = (code: number | null, signal: NodeJS.Signals | null): void => {
    proc.exited = true;
    if (proc.exitCode === null) proc.exitCode = code;
    if (proc.exitSignal === null) proc.exitSignal = signal;
  };
  child.on("exit", markExited);
  child.on("close", markExited);

  // Give fast-failing commands a moment so the model sees the crash immediately
  // instead of a false "started".
  await new Promise((resolve) => setTimeout(resolve, 700));
  const startupLog = tail(logText(proc), 2000);
  if (proc.exited) {
    return `Process "${name}" exited immediately (code ${proc.exitCode ?? "?"}).\n${startupLog || "(no output)"}`;
  }
  return (
    `Started background process #${proc.id} "${name}" (pid ${child.pid}) in ${cwd}.\n` +
    `Poll it with process_output id=${proc.id}; stop it with stop_process. Early output:\n${startupLog || "(no output yet)"}`
  );
};

const processOutputHandler: ToolHandler = async (args) => {
  const id = Number(args.id);
  const proc = processes.get(id);
  if (!proc) return `Error: no process #${args.id}. Call list_processes.`;
  const maxChars = Math.max(500, Math.min(Number(args.max_chars) || 6000, MAX_RESULT_CHARS));
  const body = tail(logText(proc), maxChars);
  return `${statusLine(proc)}\n---\n${body || "(no output)"}`;
};

const stopProcessHandler: ToolHandler = async (args, ctx) => {
  const id = Number(args.id);
  const proc = processes.get(id);
  if (!proc) return `Error: no process #${args.id}. Call list_processes.`;
  if (proc.exited) return `Process #${id} "${proc.name}" already exited (code ${proc.exitCode ?? "?"}).`;
  if (!(await ctx.approve({ tool: "stop_process", summary: `Stop background process #${id} "${proc.name}"` }))) {
    return DENIED;
  }
  signalTree(proc, "SIGTERM");
  // Escalate if it ignores SIGTERM.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!proc.exited) {
    signalTree(proc, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return proc.exited
    ? `Stopped process #${id} "${proc.name}" (code ${proc.exitCode ?? "killed"}).`
    : `Sent kill signals to process #${id}; it may take a moment to exit.`;
};

const listProcessesHandler: ToolHandler = async () => {
  if (processes.size === 0) return "No background processes this session.";
  return [...processes.values()].map(statusLine).join("\n");
};

const waitForServerHandler: ToolHandler = async (args) => {
  const rawUrl = firstString(args, "url", "endpoint");
  const port = Number(args.port) || 0;
  if (!rawUrl && !port) return "Error: wait_for_server requires a 'url' (http…) or a 'port' number.";
  const timeoutMs = Math.max(1000, Math.min((Number(args.timeoutSeconds) || 30) * 1000, 180_000));
  const deadline = Date.now() + timeoutMs;

  const probeHttp = async (url: string): Promise<{ up: boolean; detail: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return { up: true, detail: `HTTP ${res.status}` };
    } catch {
      return { up: false, detail: "no response" };
    } finally {
      clearTimeout(timer);
    }
  };
  const probePort = (p: number): Promise<{ up: boolean; detail: string }> =>
    new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: p, timeout: 2000 });
      socket.once("connect", () => {
        socket.destroy();
        resolve({ up: true, detail: `port ${p} accepting connections` });
      });
      const fail = () => {
        socket.destroy();
        resolve({ up: false, detail: "connection refused" });
      };
      socket.once("error", fail);
      socket.once("timeout", fail);
    });

  while (Date.now() < deadline) {
    const result = rawUrl ? await probeHttp(rawUrl) : await probePort(port);
    if (result.up) return `Server is up: ${rawUrl || `127.0.0.1:${port}`} (${result.detail}).`;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${rawUrl || `port ${port}`}. Check process_output for startup errors.`;
};

// ---------------------------------------------------------------------------
// Definitions + module
// ---------------------------------------------------------------------------

export const processToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "start_process",
      "Start a LONG-RUNNING background process (dev server, watcher, daemon) that keeps running while you continue working. Use exec for one-shot commands instead. Output is buffered — poll it with process_output. Requires user approval.",
      {
        command: { type: "string", description: "Shell command to run, e.g. 'npm run dev'." },
        name: { type: "string", description: "Short label for the process (shown in listings)." },
        cwd: { type: "string", description: "Working directory (defaults to the workspace)." },
      },
      ["command"]
    ),
    defineTool(
      "process_output",
      "Read the buffered stdout/stderr of a background process (most recent output; the buffer is a 2 MiB ring).",
      {
        id: { type: "number", description: "Process id from start_process/list_processes." },
        max_chars: { type: "number", description: "Max characters of tail to return (default 6000)." },
      },
      ["id"]
    ),
    defineTool(
      "stop_process",
      "Stop a background process (SIGTERM, escalating to SIGKILL). Requires user approval.",
      { id: { type: "number", description: "Process id to stop." } },
      ["id"]
    ),
    defineTool("list_processes", "List background processes started this session with their status.", {}),
    defineTool(
      "wait_for_server",
      "Poll until an HTTP URL responds or a local TCP port accepts connections (readiness check after start_process). Not side-effecting.",
      {
        url: { type: "string", description: "HTTP URL to poll, e.g. http://localhost:5173." },
        port: { type: "number", description: "Alternative: a local TCP port to poll." },
        timeoutSeconds: { type: "number", description: "Give up after this many seconds (default 30, max 180)." },
      }
    ),
  ],
  handlers: {
    start_process: startProcessHandler,
    process_output: processOutputHandler,
    stop_process: stopProcessHandler,
    list_processes: listProcessesHandler,
    wait_for_server: waitForServerHandler,
  },
};
