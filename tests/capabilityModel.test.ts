import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CAPABILITIES,
  KNOWN_BROWSER_TOOLS,
  REASONING_ENGINE,
  HARNESS,
  HARNESS_MODEL_SUMMARY,
  getCapability,
  capabilitiesByStatus,
  declaredTools,
  capabilityCounts,
  harnessSystemPromptLine,
  renderHarnessOverview,
  renderCapability,
} from "../electron/harness/capabilityModel";
import { harnessToolsModule } from "../electron/tools/harnessTools";
import { extraToolDefinitions, hasExtraTool, dispatchExtraTool } from "../electron/tools/dispatch";
import type { ToolContext } from "../electron/tools/types";

const ctx: ToolContext = { cwd: "/tmp", approve: async () => true, openSidecar: () => {} };

// The set of tool names that actually exist in the harness today: the live
// dispatch registry plus the known browser tools (which live in
// llm-connection.ts and can't be imported here without Electron).
const realToolNames = new Set<string>([
  ...extraToolDefinitions().map((t) => t.function.name),
  ...KNOWN_BROWSER_TOOLS,
]);

describe("capability model — shape", () => {
  it("encodes the full canonical matrix with unique ids", () => {
    expect(CAPABILITIES.length).toBe(24);
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every row is fully populated and grounded in modules", () => {
    for (const c of CAPABILITIES) {
      expect(c.id).toMatch(/^[a-z][a-z-]+$/);
      expect(c.capability.length).toBeGreaterThan(0);
      expect(c.mechanism.length).toBeGreaterThan(0);
      expect(c.enables.length).toBeGreaterThan(0);
      expect(["implemented", "partial", "planned"]).toContain(c.status);
      expect(c.modules.length).toBeGreaterThan(0);
    }
  });

  it("describes both layers of the agent", () => {
    expect(REASONING_ENGINE.responsibilities.length).toBeGreaterThan(0);
    expect(HARNESS.responsibilities.length).toBeGreaterThan(0);
    expect(HARNESS_MODEL_SUMMARY).toContain("combination");
  });
});

describe("capability model — grounded in real code", () => {
  it("every referenced tool is a real harness tool (or a documented dynamic prefix)", () => {
    for (const c of CAPABILITIES) {
      for (const tool of c.tools) {
        // MCP tools are surfaced dynamically as mcp__<server>__<tool>.
        if (tool.startsWith("mcp__")) continue;
        expect(realToolNames.has(tool), `${c.id} references unknown tool "${tool}"`).toBe(true);
      }
    }
  });

  it("every referenced source module exists on disk", () => {
    const root = process.cwd();
    for (const c of CAPABILITIES) {
      for (const mod of c.modules) {
        expect(fs.existsSync(path.resolve(root, mod)), `${c.id} -> missing ${mod}`).toBe(true);
      }
    }
  });

  it("declaredTools/getCapability/counts are self-consistent", () => {
    expect(getCapability("browser-use")?.capability).toBe("Browser use");
    expect(getCapability("nope")).toBeUndefined();
    // Grounded to this repo: github_pr is a real declared tool (no write_pdf here).
    expect(declaredTools()).toContain("github_pr");
    const counts = capabilityCounts();
    expect(counts.implemented + counts.partial + counts.planned).toBe(CAPABILITIES.length);
    expect(capabilitiesByStatus("implemented").length).toBe(counts.implemented);
  });

  it("only claims 'implemented'/'partial' where a real tool or module backs it", () => {
    // Browser use and git workflows are the two fully implemented, tool-backed rows.
    expect(getCapability("browser-use")?.status).toBe("implemented");
    expect(getCapability("git-workflows")?.status).toBe("implemented");
    expect(getCapability("safety-controls")?.status).toBe("implemented");
    // This shell still ships no in-harness file editor, so that row stays planned.
    for (const id of ["file-editing"]) {
      expect(getCapability(id)?.status).toBe("planned");
      expect(getCapability(id)?.tools.length).toBe(0);
    }
    // These were planned in the base shell but are now backed by real tools.
    for (const id of ["software-execution", "document-creation"]) {
      expect(getCapability(id)?.status).toBe("implemented");
      expect(getCapability(id)?.tools.length).toBeGreaterThan(0);
    }
  });
});

describe("capability model — rendering", () => {
  it("renders an overview that names both layers and the matrix", () => {
    const md = renderHarnessOverview();
    expect(md.toLowerCase()).toContain("reasoning engine");
    expect(md.toLowerCase()).toContain("agent harness");
    expect(md).toContain("Capability matrix");
    expect(md).toContain("Browser use");
    expect(md).toContain(`${CAPABILITIES.length} capabilities`);
  });

  it("renders a single capability in detail", () => {
    const md = renderCapability("safety-controls");
    expect(md).toContain("Safety controls");
    expect(md).toContain("electron/tools/githubTools.ts");
    expect(renderCapability("bogus")).toContain("Unknown capability");
  });

  it("emits a terse, on-message system-prompt line", () => {
    const line = harnessSystemPromptLine();
    expect(line).toContain("reasoning engine");
    expect(line).toContain("describe_harness");
  });
});

describe("describe_harness tool", () => {
  it("is registered in the dispatch catalog", () => {
    expect(harnessToolsModule.definitions[0].function.name).toBe("describe_harness");
    expect(hasExtraTool("describe_harness")).toBe(true);
  });

  it("returns the overview with no args, and a detail view when filtered", async () => {
    const overview = await dispatchExtraTool("describe_harness", {}, ctx);
    expect(overview).toContain("Capability matrix");

    const detail = await dispatchExtraTool("describe_harness", { capability: "browser-use" }, ctx);
    expect(detail).toContain("Browser use");

    // Tolerates the human-facing name as well as the id.
    const byName = await dispatchExtraTool("describe_harness", { capability: "Safety controls" }, ctx);
    expect(byName).toContain("safety-controls");
  });
});
