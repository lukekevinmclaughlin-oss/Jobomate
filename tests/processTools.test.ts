import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { processToolsModule, resetProcessStateForTest } from "../electron/tools/processTools";
import { taskToolsModule, resetTaskStateForTest } from "../electron/tools/taskTools";
import type { ToolContext } from "../electron/tools/types";

const ctx: ToolContext = { cwd: "/tmp", approve: async () => true, openSidecar: () => {} };
const denyCtx: ToolContext = { cwd: "/tmp", approve: async () => false, openSidecar: () => {} };

const run = (name: string, args: Record<string, unknown>, c: ToolContext = ctx) =>
  processToolsModule.handlers[name](args, c);

beforeEach(() => resetProcessStateForTest());
afterEach(() => resetProcessStateForTest());

describe("process tools", () => {
  it("start_process launches, buffers output, and stop_process kills it", async () => {
    const started = (await run("start_process", {
      command: "echo hello-from-server && sleep 30",
      name: "fake-server",
    })) as string;
    expect(started).toContain("Started background process #1");
    expect(started).toContain("hello-from-server");

    const output = (await run("process_output", { id: 1 })) as string;
    expect(output).toContain("running");
    expect(output).toContain("hello-from-server");

    const stopped = (await run("stop_process", { id: 1 })) as string;
    expect(stopped.toLowerCase()).toContain("stop");
    const list = (await run("list_processes", {})) as string;
    expect(list).toContain("exited");
  }, 15000);

  it("reports immediate exits with their output", async () => {
    const result = (await run("start_process", { command: "echo boom && exit 3", name: "crasher" })) as string;
    expect(result).toContain("exited immediately");
    expect(result).toContain("boom");
    expect(result).toContain("code 3");
  });

  it("denied approval blocks the spawn", async () => {
    const result = await run("start_process", { command: "sleep 5" }, denyCtx);
    expect(result).toBe("Denied by user.");
    expect(await run("list_processes", {})).toBe("No background processes this session.");
  });

  it("process_output errors cleanly on unknown ids", async () => {
    const result = (await run("process_output", { id: 99 })) as string;
    expect(result).toContain("no process #99");
  });

  it("wait_for_server times out fast on a dead port", async () => {
    const result = (await run("wait_for_server", { port: 59998, timeoutSeconds: 1 })) as string;
    expect(result).toContain("Timed out");
  }, 10000);
});

describe("task tools", () => {
  beforeEach(() => resetTaskStateForTest());

  const task = (name: string, args: Record<string, unknown>) =>
    taskToolsModule.handlers[name](args, ctx);

  it("todo_write replaces the list and renders statuses", async () => {
    const result = (await task("todo_write", {
      items: [
        { text: "explore repo", status: "completed" },
        { text: "write feature", status: "in_progress" },
        { text: "run tests" },
      ],
    })) as string;
    expect(result).toContain("(1/3 done)");
    expect(result).toContain("[x] #1 explore repo");
    expect(result).toContain("[~] #2 write feature");
    expect(result).toContain("[ ] #3 run tests");
  });

  it("todo_update flips a status; todo_read persists across calls", async () => {
    await task("todo_write", { items: [{ text: "a" }, { text: "b" }] });
    const updated = (await task("todo_update", { id: 2, status: "done" })) as string;
    expect(updated).toContain("[x] #2 b");
    const read = (await task("todo_read", {})) as string;
    expect(read).toContain("(1/2 done)");
  });

  it("accepts plain-string items and rejects non-arrays", async () => {
    const bad = (await task("todo_write", { items: "nope" })) as string;
    expect(bad).toContain("Error");
    const ok = (await task("todo_write", { items: ["just a string"] })) as string;
    expect(ok).toContain("#1 just a string");
  });
});
