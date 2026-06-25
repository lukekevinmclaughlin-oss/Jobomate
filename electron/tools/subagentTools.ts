// Subagent fan-out. Spawns several scoped worker completions in parallel (each
// with its own role/instructions), then optionally has a coordinator synthesize
// their outputs. This is map-reduce for reasoning: parallelize research, drafting,
// review, and analysis instead of doing everything in one serial turn.
import { defineTool, type ToolModule } from "./types";

interface SubTask {
  role: string;
  task: string;
}

function parseTasks(args: Record<string, any>): SubTask[] {
  const raw = args.tasks ?? args.subagents ?? args.workers;
  const out: SubTask[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((t: any, i: number) => {
      if (typeof t === "string") out.push({ role: `Agent ${i + 1}`, task: t });
      else if (t && typeof t === "object") out.push({ role: String(t.role ?? t.name ?? `Agent ${i + 1}`), task: String(t.task ?? t.prompt ?? t.goal ?? "") });
    });
  }
  return out.filter((t) => t.task.trim());
}

export const subagentToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "spawn_subagents",
      "Run multiple scoped subagents in parallel and aggregate their results. Provide `tasks` as an " +
        "array of strings or {role, task} objects. Set `synthesize:true` (default) to have a coordinator " +
        "merge the outputs into one answer. Great for parallel research, multi-perspective review, or " +
        "splitting a big job into independent pieces.",
      {
        tasks: { type: "array", description: "[{role, task}] or [task strings] to run in parallel.", items: { type: "object" } },
        goal: { type: "string", description: "Overall objective the coordinator should synthesize toward." },
        synthesize: { type: "boolean", description: "Merge results with a coordinator pass (default true)." },
      },
      ["tasks"]
    ),
  ],
  handlers: {
    spawn_subagents: async (args, ctx) => {
      if (!ctx.llmComplete) return "No model connected — subagents need an active LLM connection.";
      const tasks = parseTasks(args);
      if (!tasks.length) return "spawn_subagents needs a non-empty `tasks` array.";
      if (tasks.length > 8) tasks.length = 8;

      const results = await Promise.all(
        tasks.map(async (t) => {
          try {
            const out = await ctx.llmComplete!([
              {
                role: "system",
                content:
                  `You are a focused subagent with the role: ${t.role}. ` +
                  "Complete ONLY your assigned task thoroughly and concisely. Return just your result.",
              },
              { role: "user", content: t.task },
            ]);
            return { role: t.role, task: t.task, output: (out || "").trim() || "(no output)" };
          } catch (err) {
            return { role: t.role, task: t.task, output: `Error: ${String((err as Error)?.message ?? err)}` };
          }
        })
      );

      const combined = results.map((r) => `### ${r.role}\nTask: ${r.task}\n\n${r.output}`).join("\n\n---\n\n");

      const synthesize = args.synthesize !== false;
      if (!synthesize) return combined;

      const goal = typeof args.goal === "string" && args.goal.trim() ? args.goal.trim() : "Combine the subagent outputs into one coherent result.";
      try {
        const merged = await ctx.llmComplete([
          {
            role: "system",
            content:
              "You are a coordinator. Integrate the subagent outputs below into a single, coherent, " +
              "non-redundant result that satisfies the goal. Resolve conflicts and note them if material.",
          },
          { role: "user", content: `GOAL: ${goal}\n\nSUBAGENT OUTPUTS:\n\n${combined}` },
        ]);
        return (merged || "").trim() || combined;
      } catch {
        return combined;
      }
    },
  },
};
