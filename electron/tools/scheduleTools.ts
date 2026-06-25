// Scheduling & triggers. Lets the agent set up future or recurring work: "run
// this prompt in 10 minutes", "every hour". Fired jobs run a scoped completion
// against the connected model and append the result to ~/.maos/schedule-runs.log,
// giving long-horizon, time-based autonomy. Timers live in-process; metadata is
// persisted so jobs are visible across the session.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type ToolModule } from "./types";

const DIR = path.join(process.env.MAOS_HOME || os.homedir(), ".maos");
const STORE = path.join(DIR, "schedules.json");
const LOG = path.join(DIR, "schedule-runs.log");

type Runner = (messages: { role: string; content: string }[]) => Promise<string>;

interface Schedule {
  id: string;
  prompt: string;
  intervalMs: number | null;
  nextAt: number;
  createdAt: number;
  runs: number;
  lastResult?: string;
}

class ScheduleManager {
  private timers = new Map<string, NodeJS.Timeout>();
  private items = new Map<string, Schedule>();
  private runner: Runner | null = null;
  private loaded = false;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(STORE, "utf8");
      const arr: Schedule[] = JSON.parse(raw);
      for (const s of arr) this.items.set(s.id, s);
    } catch {
      /* fresh */
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(STORE, JSON.stringify([...this.items.values()]), "utf8");
    } catch {
      /* ignore */
    }
  }

  setRunner(runner: Runner | null): void {
    if (runner) this.runner = runner;
  }

  add(prompt: string, delayMs: number, intervalMs: number | null): Schedule {
    this.load();
    const id = crypto.randomUUID().slice(0, 8);
    const sched: Schedule = {
      id,
      prompt,
      intervalMs,
      nextAt: Date.now() + delayMs,
      createdAt: Date.now(),
      runs: 0,
    };
    this.items.set(id, sched);
    this.arm(sched, delayMs);
    this.persist();
    return sched;
  }

  private arm(sched: Schedule, delayMs: number): void {
    const fire = async () => {
      sched.runs++;
      sched.nextAt = sched.intervalMs ? Date.now() + sched.intervalMs : 0;
      let result = "(no model connected at fire time)";
      if (this.runner) {
        try {
          result = (await this.runner([
            { role: "system", content: "You are a scheduled background agent. Complete the task concisely." },
            { role: "user", content: sched.prompt },
          ])) || "(empty)";
        } catch (err) {
          result = `Error: ${String((err as Error)?.message ?? err)}`;
        }
      }
      sched.lastResult = result.slice(0, 500);
      try {
        await fsp.mkdir(DIR, { recursive: true });
        await fsp.appendFile(LOG, `\n[${new Date().toISOString()}] schedule ${sched.id} (run ${sched.runs})\nPROMPT: ${sched.prompt}\nRESULT: ${result}\n`, "utf8");
      } catch {
        /* ignore */
      }
      if (sched.intervalMs) this.arm(sched, sched.intervalMs);
      else this.items.delete(sched.id);
      this.persist();
    };
    const timer = setTimeout(fire, Math.max(0, delayMs));
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(sched.id, timer);
  }

  cancel(id: string): boolean {
    this.load();
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const had = this.items.delete(id);
    this.persist();
    return had;
  }

  list(): Schedule[] {
    this.load();
    return [...this.items.values()].sort((a, b) => a.nextAt - b.nextAt);
  }
}

const manager = new ScheduleManager();

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

export const scheduleToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "schedule_task",
      "Schedule a prompt to run later or repeatedly. Provide `prompt` plus either `delaySeconds` " +
        "(one-shot) or `intervalSeconds` (recurring). Results are logged to ~/.maos/schedule-runs.log. " +
        "Timers run while the app is open.",
      {
        prompt: { type: "string", description: "What the scheduled agent should do." },
        delaySeconds: { type: "number", description: "Run once after this many seconds." },
        intervalSeconds: { type: "number", description: "Run repeatedly every N seconds." },
      },
      ["prompt"]
    ),
    defineTool("list_schedules", "List active scheduled tasks.", {}, []),
    defineTool("cancel_schedule", "Cancel a scheduled task by id.", { id: { type: "string" } }, ["id"]),
  ],
  handlers: {
    schedule_task: async (args, ctx) => {
      const prompt = str(args, "prompt", "task");
      if (!prompt) return "schedule_task needs a `prompt`.";
      const interval = Number(args.intervalSeconds) > 0 ? Number(args.intervalSeconds) * 1000 : null;
      const delay = Number(args.delaySeconds) > 0 ? Number(args.delaySeconds) * 1000 : interval ?? 0;
      if (!interval && !(Number(args.delaySeconds) > 0)) return "Provide `delaySeconds` or `intervalSeconds`.";
      if (!(await ctx.approve({ tool: "schedule_task", summary: `Schedule: ${prompt.slice(0, 60)}` }))) return "Denied by user.";
      manager.setRunner(ctx.llmComplete ?? null);
      const sched = manager.add(prompt, interval ?? delay, interval);
      const when = interval ? `every ${interval / 1000}s` : `in ${(delay / 1000) || 0}s`;
      return `Scheduled task ${sched.id} (${when}). Results log to ~/.maos/schedule-runs.log.`;
    },

    list_schedules: async () => {
      const items = manager.list();
      if (!items.length) return "No active schedules.";
      return items
        .map((s) => {
          const eta = s.nextAt ? `next in ${Math.max(0, Math.round((s.nextAt - Date.now()) / 1000))}s` : "done";
          return `• [${s.id}] ${s.intervalMs ? `every ${s.intervalMs / 1000}s` : "once"} — ${eta} — runs:${s.runs}\n  "${s.prompt.slice(0, 70)}"`;
        })
        .join("\n");
    },

    cancel_schedule: async (args) => {
      const id = str(args, "id");
      if (!id) return "cancel_schedule needs an `id`.";
      return manager.cancel(id) ? `Cancelled schedule ${id}.` : `No schedule with id ${id}.`;
    },
  },
};
