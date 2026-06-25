// Stateful Python kernel — a persistent "code interpreter". Unlike run_python
// (one-shot), this keeps a live Python process whose variables/imports/dataframes
// survive across calls, so the agent can do iterative data analysis. Each cell's
// code runs in a shared namespace; stdout (and tracebacks) are captured.
import * as childProcess from "node:child_process";
import { defineTool, type ToolModule } from "./types";

const END = "<<<MAOS_CELL_END>>>";
const RESULT = "<<<MAOS_CELL_RESULT>>>";
const MAX_OUT = 12_000;

const DRIVER = `
import sys, io, traceback
ns = {"__name__": "__main__"}
buf = ""
while True:
    line = sys.stdin.readline()
    if not line:
        break
    if line.rstrip("\\n") == "${END}":
        code = buf
        buf = ""
        out = io.StringIO()
        old_o, old_e = sys.stdout, sys.stderr
        sys.stdout = out; sys.stderr = out
        try:
            exec(compile(code, "<cell>", "exec"), ns)
        except SystemExit:
            pass
        except Exception:
            traceback.print_exc(file=out)
        finally:
            sys.stdout = old_o; sys.stderr = old_e
        sys.__stdout__.write(out.getvalue())
        sys.__stdout__.write("\\n${RESULT}\\n")
        sys.__stdout__.flush()
    else:
        buf += line
`;

class PythonKernel {
  private proc: childProcess.ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private chain: Promise<unknown> = Promise.resolve();
  private alive = false;

  start(cwd: string): boolean {
    if (this.alive && this.proc) return true;
    const cmd = process.platform === "win32" ? "python" : "python3";
    try {
      this.proc = childProcess.spawn(cmd, ["-u", "-c", DRIVER], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return false;
    }
    this.alive = true;
    this.buffer = "";
    this.proc.stdout.on("data", (c: Buffer) => (this.buffer += c.toString("utf8")));
    this.proc.stderr.on("data", (c: Buffer) => (this.buffer += c.toString("utf8")));
    this.proc.on("exit", () => {
      this.alive = false;
      this.proc = null;
    });
    this.proc.on("error", () => {
      this.alive = false;
      this.proc = null;
    });
    return true;
  }

  isAlive(): boolean {
    return this.alive && !!this.proc;
  }

  stop(): void {
    try {
      this.proc?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    this.alive = false;
    this.proc = null;
  }

  run(code: string, timeoutMs: number): Promise<string> {
    // Serialize cells so a shared namespace stays consistent.
    const task = this.chain.then(() => this.execOne(code, timeoutMs));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private execOne(code: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      if (!this.proc || !this.alive) return resolve("Kernel is not running.");
      this.buffer = "";
      let done = false;
      const finish = (text: string) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(text);
      };
      const timer = setTimeout(() => {
        // A runaway cell can wedge the shared interpreter — restart it.
        this.stop();
        finish(`[cell timed out after ${Math.round(timeoutMs / 1000)}s — kernel restarted]`);
      }, timeoutMs);
      const poll = setInterval(() => {
        const idx = this.buffer.indexOf(RESULT);
        if (idx >= 0) {
          const output = this.buffer.slice(0, idx).replace(/\s+$/, "");
          this.buffer = this.buffer.slice(idx + RESULT.length);
          finish(output.length ? output : "(no output)");
        } else if (!this.alive) {
          finish(this.buffer.trim() || "[kernel exited]");
        }
      }, 25);
      try {
        this.proc.stdin.write(code + "\n" + END + "\n");
      } catch {
        finish("Failed to write to kernel.");
      }
    });
  }
}

const kernel = new PythonKernel();

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

export const kernelToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "python_session",
      "Run Python in a PERSISTENT kernel where variables, imports, and dataframes survive across calls " +
        "(a code interpreter for iterative data analysis). Use action:'run' with `code`, action:'reset' " +
        "to clear state, or action:'status'. Side-effecting: requires approval.",
      {
        action: { type: "string", description: "run (default) | reset | status." },
        code: { type: "string", description: "Python source to execute in the shared namespace." },
        timeoutSeconds: { type: "number", description: "Per-cell timeout (default 60, max 300)." },
      },
      []
    ),
  ],
  handlers: {
    python_session: async (args, ctx) => {
      const action = (str(args, "action") || "run").toLowerCase();
      if (action === "status") return kernel.isAlive() ? "Kernel is running." : "Kernel is not running.";
      if (action === "reset" || action === "stop") {
        kernel.stop();
        return "Kernel reset (state cleared).";
      }
      const code = str(args, "code", "source", "snippet");
      if (!code) return "python_session needs `code` (or action:'reset'/'status').";
      const timeoutMs = Math.max(1000, Math.min((Number(args.timeoutSeconds) || 60) * 1000, 300_000));
      if (!(await ctx.approve({ tool: "python_session", summary: `Run Python in kernel: ${code.slice(0, 80)}` }))) return "Denied by user.";
      if (!kernel.isAlive() && !kernel.start(ctx.cwd)) return "Could not start a Python kernel (is python3 installed?).";
      const out = await kernel.run(code, timeoutMs);
      return out.length > MAX_OUT ? out.slice(0, MAX_OUT) + "\n…[truncated]" : out;
    },
  },
};
