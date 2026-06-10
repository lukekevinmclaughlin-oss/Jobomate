import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CONTROL_API_METHODS, LLMBrowserServer } from "../electron/llm-server";
import type { BrowserController } from "../electron/llm-server";

// Parity guard: every `case "browser.x":` in LLMBrowserServer.dispatch() must have
// exactly one entry in CONTROL_API_METHODS (the source of listTools()), and vice
// versa, so the advertised catalog can never drift from what is dispatchable.

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "electron", "llm-server.ts"),
  "utf8"
);

function dispatchSwitchCases(): string[] {
  // Limit the scan to the dispatch() method body so CONTROL_API_METHODS entries
  // (object literals, not case labels) are not picked up.
  const start = SOURCE.indexOf("private async dispatch(");
  const end = SOURCE.indexOf("private async submitForm(");
  const body = SOURCE.slice(start, end);
  const cases = [...body.matchAll(/case "(browser\.[a-z_]+)":/g)].map((m) => m[1]);
  return cases;
}

const dummyController = {} as BrowserController;

describe("Control API parity (dispatch ⇄ listTools)", () => {
  it("dispatch() implements exactly the methods CONTROL_API_METHODS declares", () => {
    const cases = dispatchSwitchCases();
    const declared = CONTROL_API_METHODS.map((m) => m.name);
    expect(new Set(cases).size).toBe(cases.length); // no duplicate cases
    expect(new Set(declared).size).toBe(declared.length); // no duplicate entries
    expect([...cases].sort()).toEqual([...declared].sort());
  });

  it("covers all 33 methods", () => {
    expect(CONTROL_API_METHODS.length).toBe(33);
  });

  it("listTools() is generated from CONTROL_API_METHODS", () => {
    const server = new LLMBrowserServer(dummyController, 9224);
    const { tools } = (server as unknown as { listTools: () => { tools: Array<{ name: string; description: string }> } }).listTools();
    expect(tools.map((t) => t.name)).toEqual(CONTROL_API_METHODS.map((m) => m.name));
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("browser.list_tools dispatch returns the full catalog", async () => {
    const server = new LLMBrowserServer(dummyController, 9224);
    const result = await (server as unknown as {
      dispatch: (m: string, p: Record<string, unknown>) => Promise<{ tools: Array<{ name: string }> }>;
    }).dispatch("browser.list_tools", {});
    expect(result.tools.length).toBe(33);
  });

  it("marks upload_file as not yet supported", () => {
    const upload = CONTROL_API_METHODS.find((m) => m.name === "browser.upload_file");
    expect(upload).toBeDefined();
    expect(upload!.description.toLowerCase()).toContain("not yet supported");
    expect(upload!.description).toContain("uploadSupported:false");
  });
});
