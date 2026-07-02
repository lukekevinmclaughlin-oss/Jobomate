import { describe, it, expect } from "vitest";
import { extraToolDefinitions, hasExtraTool, dispatchExtraTool } from "../electron/tools/dispatch";
import type { ToolContext } from "../electron/tools/types";

const ctx: ToolContext = { cwd: "/tmp", approve: async () => true, openSidecar: () => {} };

describe("dispatch catalog", () => {
  it("exposes the full ported tool set (github_* + describe_harness)", () => {
    const names = extraToolDefinitions().map((t) => t.function.name);
    for (const expected of [
      "describe_harness",
      "github_auth_status", "github_clone", "github_status", "github_log", "github_diff",
      "github_commit", "github_branch", "github_sync", "github_pr", "github_checks",
      "github_issue", "github_api",
    ]) {
      expect(names, `missing ${expected}`).toContain(expected);
      expect(hasExtraTool(expected)).toBe(true);
    }
  });

  it("exposes the coding-harness core (files / processes / task state)", () => {
    const names = extraToolDefinitions().map((t) => t.function.name);
    for (const expected of [
      "set_workspace", "get_workspace", "list_dir", "glob_files", "grep_search", "read_file",
      "file_info", "write_file", "edit_file", "make_dir", "move_path", "copy_path", "delete_path",
      "list_file_changes", "diff_file_change", "undo_file_change",
      "start_process", "process_output", "stop_process", "list_processes", "wait_for_server",
      "todo_write", "todo_update", "todo_read",
    ]) {
      expect(names, `missing ${expected}`).toContain(expected);
      expect(hasExtraTool(expected)).toBe(true);
    }
  });

  it("has no duplicate tool names across modules", () => {
    const names = extraToolDefinitions().map((t) => t.function.name);
    const dupes = names.filter((name, index) => names.indexOf(name) !== index);
    expect(dupes).toEqual([]);
  });

  it("hasExtraTool distinguishes extra tools from browser tools", () => {
    expect(hasExtraTool("describe_harness")).toBe(true);
    expect(hasExtraTool("github_pr")).toBe(true);
    expect(hasExtraTool("browser_click")).toBe(false);
    expect(hasExtraTool("nonexistent")).toBe(false);
  });

  it("every definition is a valid OpenAI function tool", () => {
    for (const def of extraToolDefinitions()) {
      expect(def.type).toBe("function");
      expect(typeof def.function.name).toBe("string");
      expect(typeof def.function.description).toBe("string");
      expect(def.function.parameters).toBeTypeOf("object");
    }
  });

  it("returns undefined for unknown tools (so the caller can fall through)", async () => {
    const r = await dispatchExtraTool("browser_click", {}, ctx);
    expect(r).toBeUndefined();
  });

  it("wraps handler errors as a string instead of throwing", async () => {
    // describe_harness with a bogus capability returns a string, never throws.
    const r = await dispatchExtraTool("describe_harness", { capability: "totally-bogus" }, ctx);
    expect(typeof r).toBe("string");
    expect(r).toContain("Unknown capability");
  });
});
