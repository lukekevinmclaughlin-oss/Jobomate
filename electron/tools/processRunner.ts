// Self-contained process-spawning + output-formatting helpers, extracted from MAOS's
// execTools.ts so the GitHub toolkit can spawn git/gh via argv without dragging in the
// full exec/run_python/run_node module (which this repo does not ship). Pure Node
// (child_process / path / os) — no Electron imports, so it stays unit-testable.

import * as childProcess from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolContext } from "./types";

/** Cap captured output per stream so a runaway process can't blow up memory. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB
/** The model only ever sees a truncated transcript. */
const MAX_RESULT_CHARS = 12_000;

export interface ProcessOutcome {
  /** Combined stdout + stderr, in arrival order, already capped at MAX_BUFFER_BYTES. */
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
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
