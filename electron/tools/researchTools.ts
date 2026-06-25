// Deep Research orchestrator. Turns a single question into a multi-step research
// loop: plan sub-queries → search the web in parallel → fetch & extract the top
// sources → synthesize a cited report via the connected model → write it to a
// document. This is the "research analyst" capability: not one lookup, but an
// iterative, sourced investigation.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type ToolContext, type ToolModule } from "./types";
import { runWebSearch, fetchReadable } from "./webTools";

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

interface Source {
  n: number;
  title: string;
  url: string;
  text: string;
}

/** Ask the model for N focused sub-queries; fall back to the raw question. */
async function planQueries(ctx: ToolContext, question: string, depth: number): Promise<string[]> {
  const fallback = [question];
  if (!ctx.llmComplete) return fallback;
  try {
    const out = await ctx.llmComplete([
      {
        role: "system",
        content:
          "You are a research planner. Given a question, output up to " +
          depth +
          " distinct web search queries that together cover it. One query per line, no numbering, no commentary.",
      },
      { role: "user", content: question },
    ]);
    const queries = out
      .split("\n")
      .map((l) => l.replace(/^[\s\-*\d.]+/, "").trim())
      .filter(Boolean)
      .slice(0, depth);
    return queries.length ? queries : fallback;
  } catch {
    return fallback;
  }
}

export const researchToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "deep_research",
      "Conduct deep, multi-source web research on a question: plans sub-queries, searches and reads " +
        "multiple sources, then synthesizes a structured, cited answer (with a numbered source list). " +
        "Optionally writes the report to a file. Read-only web access; no approval needed to research, " +
        "but writing a report file is approval-gated.",
      {
        question: { type: "string", description: "The research question or topic." },
        depth: { type: "number", description: "How many sub-queries to run (1–6, default 3)." },
        maxSources: { type: "number", description: "Max sources to read (default 8)." },
        output: { type: "string", description: "Optional path to save the report (.md/.txt/.pdf)." },
      },
      ["question"]
    ),
  ],
  handlers: {
    deep_research: async (args, ctx) => {
      const question = str(args, "question", "query", "topic");
      if (!question) return "deep_research needs a `question`.";
      const depth = Math.max(1, Math.min(Number(args.depth) || 3, 6));
      const maxSources = Math.max(2, Math.min(Number(args.maxSources) || 8, 15));

      const queries = await planQueries(ctx, question, depth);

      // Search all sub-queries in parallel, then dedupe results by URL.
      const resultLists = await Promise.all(queries.map((q) => runWebSearch(q, 6).catch(() => [])));
      const seen = new Set<string>();
      const ranked: { title: string; url: string; snippet: string }[] = [];
      for (const list of resultLists) {
        for (const r of list) {
          if (seen.has(r.url)) continue;
          seen.add(r.url);
          ranked.push(r);
        }
      }
      if (!ranked.length) return `No web results found for "${question}". The search endpoint may be blocked.`;

      // Fetch the top sources in parallel.
      const top = ranked.slice(0, maxSources);
      const fetched = await Promise.all(top.map((r) => fetchReadable(r.url, 4000).catch(() => "")));
      const sources: Source[] = [];
      top.forEach((r, i) => {
        const text = fetched[i];
        if (text && text.length > 120) sources.push({ n: sources.length + 1, title: r.title, url: r.url, text });
      });
      if (!sources.length) return `Found ${ranked.length} links but none were readable for "${question}".`;

      const sourceList = sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n");

      // Synthesize a cited report with the connected model.
      let report = "";
      if (ctx.llmComplete) {
        const corpus = sources
          .map((s) => `SOURCE [${s.n}] ${s.title} (${s.url})\n${s.text.slice(0, 3000)}`)
          .join("\n\n---\n\n");
        report = await ctx.llmComplete([
          {
            role: "system",
            content:
              "You are a meticulous research analyst. Using ONLY the provided sources, write a clear, " +
              "well-structured report that answers the question. Cite claims inline with [n] referring to " +
              "the source numbers. Note disagreements between sources. End with a 'Sources' section listing " +
              "each [n] title and URL. Do not invent facts not present in the sources.",
          },
          { role: "user", content: `QUESTION: ${question}\n\nSOURCES:\n\n${corpus}` },
        ]).catch(() => "");
      }
      if (!report) {
        report =
          `# Research: ${question}\n\n(No model connected for synthesis — raw findings below.)\n\n` +
          sources.map((s) => `## [${s.n}] ${s.title}\n${s.url}\n\n${s.text.slice(0, 800)}…`).join("\n\n");
      }
      if (!/sources/i.test(report.slice(-400))) report += `\n\n## Sources\n${sourceList}`;

      // Optionally persist the report.
      const outArg = str(args, "output", "path", "file");
      if (outArg) {
        let out = outArg;
        if (out.startsWith("~")) out = path.join(os.homedir(), out.slice(1));
        if (!path.isAbsolute(out)) out = path.resolve(ctx.cwd, out);
        if (!/\.(md|txt|pdf)$/i.test(out)) out += ".md";
        if (await ctx.approve({ tool: "deep_research", summary: `Save research report ${out}` })) {
          await fs.mkdir(path.dirname(out), { recursive: true });
          await fs.writeFile(out, report, "utf8");
          ctx.openSidecar("preview", { filePath: out });
          return `Researched "${question}" across ${sources.length} sources → saved ${out}.\n\n${report.slice(0, 1500)}`;
        }
      }

      return `Researched "${question}" across ${sources.length} sources.\n\n${report}`;
    },
  },
};
