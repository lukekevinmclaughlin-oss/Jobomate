import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  fileToolsModule,
  globToRegExp,
  unifiedDiff,
  getWorkspaceDir,
  resetFileToolStateForTest,
} from "../electron/tools/fileTools";
import type { ToolContext } from "../electron/tools/types";

let tmp: string;
let approved: string[];
let denyNext = false;

const ctx = (): ToolContext => ({
  cwd: tmp,
  approve: async (req) => {
    approved.push(req.tool);
    if (denyNext) {
      denyNext = false;
      return false;
    }
    return true;
  },
  openSidecar: () => {},
});

const run = (name: string, args: Record<string, unknown>) =>
  fileToolsModule.handlers[name](args, ctx());

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "filetools-test-"));
  approved = [];
  denyNext = false;
  resetFileToolStateForTest();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("globToRegExp", () => {
  it("matches simple and recursive patterns", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("dir/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("deep/nested/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true); // `**/` matches zero dirs
    expect(globToRegExp("src/**/*.test.*").test("src/x/y/z.test.tsx")).toBe(true);
    expect(globToRegExp("a?c.md").test("abc.md")).toBe(true);
    expect(globToRegExp("a?c.md").test("a/c.md")).toBe(false);
  });
});

describe("unifiedDiff", () => {
  it("reports no changes for identical inputs", () => {
    expect(unifiedDiff("a\nb", "a\nb", "x")).toBe("(no changes)");
  });

  it("produces hunks with +/- lines", () => {
    const diff = unifiedDiff("one\ntwo\nthree\nfour", "one\n2\nthree\nfour", "f.txt");
    expect(diff).toContain("-two");
    expect(diff).toContain("+2");
    expect(diff).toContain("@@");
  });
});

describe("workspace", () => {
  it("set_workspace validates and get_workspace reflects it", async () => {
    expect(getWorkspaceDir()).toBeNull();
    const bad = await run("set_workspace", { path: path.join(tmp, "missing") });
    expect(bad).toContain("does not exist");
    const good = await run("set_workspace", { path: tmp });
    expect(good).toContain(tmp);
    expect(getWorkspaceDir()).toBe(tmp);
    expect(await run("get_workspace", {})).toContain("explicitly set");
  });

  it("refuses sensitive workspaces", async () => {
    const result = await run("set_workspace", { path: path.join(os.homedir(), ".ssh") });
    expect(result).toContain("protected location");
  });
});

describe("read/write/edit round trip", () => {
  it("write_file creates (with parents), read_file shows numbered lines", async () => {
    const file = path.join(tmp, "deep", "nested", "hello.txt");
    const write = await run("write_file", { path: file, content: "alpha\nbeta\ngamma" });
    expect(write).toContain("Created");
    expect(approved).toContain("write_file");
    const read = await run("read_file", { path: file });
    expect(read).toContain("1\talpha");
    expect(read).toContain("3\tgamma");
  });

  it("read_file supports offset/limit ranges", async () => {
    const file = path.join(tmp, "range.txt");
    fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n"));
    const read = (await run("read_file", { path: file, offset: 50, limit: 2 })) as string;
    expect(read).toContain("line-50");
    expect(read).toContain("line-51");
    expect(read).not.toContain("line-52\n");
    expect(read).toContain("more lines");
  });

  it("edit_file replaces a unique snippet and returns a diff", async () => {
    const file = path.join(tmp, "code.ts");
    fs.writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    const result = (await run("edit_file", { path: file, old_text: "const b = 2;", new_text: "const b = 42;" })) as string;
    expect(result).toContain("+const b = 42;");
    expect(fs.readFileSync(file, "utf8")).toContain("42");
  });

  it("edit_file demands uniqueness unless replace_all", async () => {
    const file = path.join(tmp, "dup.txt");
    fs.writeFileSync(file, "x\nx\n");
    const ambiguous = (await run("edit_file", { path: file, old_text: "x", new_text: "y" })) as string;
    expect(ambiguous).toContain("appears");
    const all = (await run("edit_file", { path: file, old_text: "x", new_text: "y", replace_all: true })) as string;
    expect(all).toContain("Edited");
    expect(fs.readFileSync(file, "utf8")).toBe("y\ny\n");
  });

  it("denied approval blocks the write", async () => {
    denyNext = true;
    const file = path.join(tmp, "never.txt");
    const result = await run("write_file", { path: file, content: "nope" });
    expect(result).toBe("Denied by user.");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses writes into sensitive paths", async () => {
    const result = await run("write_file", { path: "~/.ssh/config", content: "x" });
    expect(result).toContain("protected location");
  });
});

describe("discovery", () => {
  it("glob_files finds files and skips node_modules", async () => {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "a.ts"), "x");
    fs.writeFileSync(path.join(tmp, "node_modules", "pkg", "b.ts"), "x");
    const result = (await run("glob_files", { pattern: "**/*.ts", path: tmp })) as string;
    expect(result).toContain("src/a.ts");
    expect(result).not.toContain("node_modules");
  });

  it("grep_search returns file:line hits with include filter", async () => {
    fs.writeFileSync(path.join(tmp, "one.ts"), "const needle = true;\n");
    fs.writeFileSync(path.join(tmp, "two.md"), "needle here too\n");
    const result = (await run("grep_search", { pattern: "needle", path: tmp, include: "**/*.ts" })) as string;
    expect(result).toContain("one.ts:1");
    expect(result).not.toContain("two.md");
  });

  it("list_dir shows entries with kinds", async () => {
    fs.mkdirSync(path.join(tmp, "sub"));
    fs.writeFileSync(path.join(tmp, "f.txt"), "hi");
    const result = (await run("list_dir", { path: tmp })) as string;
    expect(result).toContain("dir ");
    expect(result).toContain("sub");
    expect(result).toContain("f.txt");
  });
});

describe("diff awareness + recovery", () => {
  it("journals changes, diffs them, and undoes an edit", async () => {
    const file = path.join(tmp, "undo.txt");
    fs.writeFileSync(file, "original\n");
    await run("edit_file", { path: file, old_text: "original", new_text: "modified" });
    const list = (await run("list_file_changes", {})) as string;
    expect(list).toContain("#1 edit");
    const diff = (await run("diff_file_change", { id: 1 })) as string;
    expect(diff).toContain("-original");
    expect(diff).toContain("+modified");
    const undo = (await run("undo_file_change", { id: 1 })) as string;
    expect(undo).toContain("Undid change #1");
    expect(fs.readFileSync(file, "utf8")).toBe("original\n");
  });

  it("undo of a create removes the file; delete restores from checkpoint", async () => {
    const created = path.join(tmp, "created.txt");
    await run("write_file", { path: created, content: "new" });
    await run("undo_file_change", { id: 1 });
    expect(fs.existsSync(created)).toBe(false);

    const victim = path.join(tmp, "victim.txt");
    fs.writeFileSync(victim, "precious");
    await run("delete_path", { path: victim });
    expect(fs.existsSync(victim)).toBe(false);
    const list = (await run("list_file_changes", {})) as string;
    const deleteId = Number((list.match(/#(\d+) delete/) || [])[1]);
    await run("undo_file_change", { id: deleteId });
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
  });

  it("move_path is undoable back to the source", async () => {
    const from = path.join(tmp, "a.txt");
    const to = path.join(tmp, "b.txt");
    fs.writeFileSync(from, "content");
    await run("move_path", { from, to });
    expect(fs.existsSync(to)).toBe(true);
    await run("undo_file_change", { id: 1 });
    expect(fs.existsSync(from)).toBe(true);
    expect(fs.existsSync(to)).toBe(false);
  });
});
