// Self-verification / evaluation harness. verify_code runs a batch of checks
// (tests, lint, type-check, build) and reports a PASS/FAIL summary so the agent
// can confirm its own work instead of assuming success. verify_claims fact-checks
// statements against fresh web sources. Together these close the loop the repo's
// rules demand: verify correctness, don't just produce output.
import { defineTool, type ToolModule } from "./types";
import { runProcess, formatOutcome } from "./execTools";
import { runWebSearch, fetchReadable } from "./webTools";

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

function shellInvocation(command: string): { cmd: string; args: string[] } {
  if (process.platform === "win32") return { cmd: "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { cmd: "/bin/zsh", args: ["-lc", command] };
}

const PRESETS: Record<string, string> = {
  test: "npm test",
  lint: "npm run lint",
  typecheck: "npx tsc --noEmit",
  build: "npm run build",
};

export const verifyToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "verify_code",
      "Run verification checks and report PASS/FAIL for each. Provide `checks` (array of shell commands) " +
        "and/or `presets` (any of: test, lint, typecheck, build). Use after making code changes to " +
        "confirm they actually work. Side-effecting: requires approval.",
      {
        checks: { type: "array", items: { type: "string" }, description: "Shell commands to run as checks." },
        presets: { type: "array", items: { type: "string" }, description: "test | lint | typecheck | build." },
        cwd: { type: "string", description: "Working directory (defaults to session cwd)." },
      },
      []
    ),
    defineTool(
      "verify_claims",
      "Fact-check statements against fresh web sources. Provide `claims` (array of statements); each is " +
        "searched, a source is read, and the model judges Supported / Contradicted / Unclear with a " +
        "citation. Read-only.",
      { claims: { type: "array", items: { type: "string" } } },
      ["claims"]
    ),
  ],
  handlers: {
    verify_code: async (args, ctx) => {
      const checks: string[] = [];
      if (Array.isArray(args.presets)) {
        for (const p of args.presets) {
          const cmd = PRESETS[String(p).toLowerCase()];
          if (cmd) checks.push(cmd);
        }
      }
      if (Array.isArray(args.checks)) checks.push(...args.checks.map(String));
      if (!checks.length) return "verify_code needs `checks` and/or `presets` (test|lint|typecheck|build).";
      const cwd = str(args, "cwd") || ctx.cwd;
      if (!(await ctx.approve({ tool: "verify_code", summary: `Run ${checks.length} check(s): ${checks.join(", ").slice(0, 80)}` }))) return "Denied by user.";

      const lines: string[] = [];
      let allPass = true;
      for (const command of checks) {
        const { cmd, args: a } = shellInvocation(command);
        const outcome = await runProcess(cmd, a, { cwd, binDir: null, timeoutMs: 300_000 });
        const pass = !outcome.timedOut && outcome.exitCode === 0;
        if (!pass) allPass = false;
        const tail = formatOutcome("check", outcome).split("\n").slice(-6).join("\n");
        lines.push(`${pass ? "✅ PASS" : "❌ FAIL"}  ${command}\n${tail}`);
      }
      return `${allPass ? "All checks passed." : "Some checks FAILED."}\n\n${lines.join("\n\n")}`;
    },

    verify_claims: async (args, ctx) => {
      const claims: string[] = Array.isArray(args.claims) ? args.claims.map(String).filter(Boolean) : [];
      if (!claims.length) return "verify_claims needs a `claims` array.";
      const out: string[] = [];
      for (const claim of claims.slice(0, 8)) {
        const results = await runWebSearch(claim, 3).catch(() => []);
        if (!results.length) {
          out.push(`• Unclear — no sources found.\n  Claim: ${claim}`);
          continue;
        }
        const top = results[0];
        const text = await fetchReadable(top.url, 3000).catch(() => "");
        let verdict = "Unclear";
        if (ctx.llmComplete && text) {
          const judged = await ctx
            .llmComplete([
              { role: "system", content: "Judge whether the SOURCE supports the CLAIM. Reply with exactly one word: Supported, Contradicted, or Unclear, then a one-sentence reason." },
              { role: "user", content: `CLAIM: ${claim}\n\nSOURCE (${top.url}):\n${text}` },
            ])
            .catch(() => "");
          if (judged) verdict = judged.trim();
        }
        out.push(`• ${verdict}\n  Claim: ${claim}\n  Source: ${top.url}`);
      }
      return out.join("\n\n");
    },
  },
};
