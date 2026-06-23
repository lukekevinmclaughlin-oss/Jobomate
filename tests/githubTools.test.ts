import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { extraToolDefinitions, hasExtraTool, dispatchExtraTool } from "../electron/tools/dispatch";
import { __resetGhProbe } from "../electron/tools/githubTools";
import type { ToolContext } from "../electron/tools/types";

const GITHUB_TOOLS = [
  "github_auth_status",
  "github_clone",
  "github_status",
  "github_log",
  "github_diff",
  "github_commit",
  "github_branch",
  "github_sync",
  "github_pr",
  "github_checks",
  "github_issue",
  "github_api",
];

let dir: string;
let approvals: Array<{ tool: string; summary: string }> = [];

const ctx = (approve = true): ToolContext => ({
  cwd: dir,
  approve: async (req) => {
    approvals.push(req);
    return approve;
  },
  openSidecar: () => {},
});

const call = (name: string, args: Record<string, unknown>, approve = true) =>
  dispatchExtraTool(name, args, ctx(approve)) as Promise<string>;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobomate-gh-"));
  git("init", "-q");
  git("config", "user.email", "test@jobomate.local");
  git("config", "user.name", "Jobomate Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial commit");
  __resetGhProbe();
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("github tool catalog", () => {
  it("registers all 12 purpose-built GitHub tools as dispatchable functions", () => {
    const names = extraToolDefinitions().map((t) => t.function.name);
    for (const tool of GITHUB_TOOLS) {
      expect(names, `missing ${tool}`).toContain(tool);
      expect(hasExtraTool(tool)).toBe(true);
    }
  });

  it("every github tool definition is a valid OpenAI function tool", () => {
    const defs = extraToolDefinitions().filter((t) => GITHUB_TOOLS.includes(t.function.name));
    expect(defs).toHaveLength(GITHUB_TOOLS.length);
    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(typeof def.function.description).toBe("string");
      expect(def.function.parameters).toBeTypeOf("object");
    }
  });
});

describe("git-backed tools (real temp repo)", () => {
  it("github_auth_status reports git + repo context", async () => {
    const out = await call("github_auth_status", {});
    expect(out).toMatch(/git:/);
    expect(out).toMatch(/repo: yes/);
  });

  it("github_status shows a clean tree, then surfaces an edit", async () => {
    const clean = await call("github_status", {});
    expect(clean).toMatch(/Branch:/);
    expect(clean).toMatch(/Working tree clean/);

    fs.writeFileSync(path.join(dir, "README.md"), "# hello\nmore\n");
    const dirty = await call("github_status", {});
    expect(dirty).toMatch(/Modified\/unstaged \(1\): README\.md/);

    const untrackedFile = path.join(dir, "new.txt");
    fs.writeFileSync(untrackedFile, "x");
    const withUntracked = await call("github_status", {});
    expect(withUntracked).toMatch(/Untracked \(1\): new\.txt/);
    fs.rmSync(untrackedFile);
  });

  it("github_diff shows the working-tree change", async () => {
    const diff = await call("github_diff", {});
    expect(diff).toMatch(/README\.md/);
    expect(diff).toMatch(/\+more/);
  });

  it("github_log lists commits as a clean line", async () => {
    const log = await call("github_log", { max: 5 });
    expect(log).toMatch(/initial commit/);
    // hash  date  author  subject
    expect(log).toMatch(/^[0-9a-f]{7,}\s+\d{4}-\d{2}-\d{2}\s+Jobomate Test\s+initial commit/m);
  });

  it("github_commit stages + commits when approved, and is gated when denied", async () => {
    approvals = [];
    const denied = await call("github_commit", { message: "should not land" }, false);
    expect(denied).toBe("Denied by user.");
    expect(approvals).toHaveLength(1);
    const afterDeny = await call("github_log", { max: 10 });
    expect(afterDeny).not.toMatch(/should not land/);

    approvals = [];
    const committed = await call("github_commit", { message: "tweak readme", all: true }, true);
    expect(approvals[0].tool).toBe("github_commit");
    expect(committed).toMatch(/exit code: 0/);
    const afterCommit = await call("github_log", { max: 10 });
    expect(afterCommit).toMatch(/tweak readme/);
  });

  it("github_branch lists, then creates + switches when approved", async () => {
    const list = await call("github_branch", { op: "list" });
    expect(list).toMatch(/exit code: 0/);

    approvals = [];
    const created = await call("github_branch", { op: "create", name: "feature/jobomate-test" }, true);
    expect(approvals[0].summary).toMatch(/Create \+ switch to branch feature\/jobomate-test/);
    expect(created).toMatch(/exit code: 0/);
    const status = await call("github_status", {});
    expect(status).toMatch(/Branch: feature\/jobomate-test/);
  });

  it("github_sync rejects an unknown op without throwing", async () => {
    const out = await call("github_sync", { op: "bogus" });
    expect(out).toMatch(/op must be one of fetch\|pull\|push/);
  });
});

describe("argument-injection guard", () => {
  it("rejects positional values that begin with '-' before running anything", async () => {
    const branch = await call("github_branch", { op: "checkout", name: "--upload-pack=evil" });
    expect(branch).toMatch(/refusing the value/);
    const log = await call("github_log", { ref: "-evil" });
    expect(log).toMatch(/refusing the value/);
    const pr = await call("github_pr", { op: "view", number: "--flag" });
    // gh-missing notice OR the flag guard — both are non-executing strings.
    expect(typeof pr).toBe("string");
    // a normal branch name is NOT rejected
    const ok = await call("github_log", { ref: "HEAD" });
    expect(ok).not.toMatch(/refusing the value/);
  });
});

describe("gh-backed tools degrade gracefully", () => {
  it("github_pr returns a string (gh output, gh error, or the gh-missing notice) — never throws", async () => {
    const out = await call("github_pr", { op: "list" });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("github_api requires an endpoint argument", async () => {
    // If gh is absent we get the gh-missing notice; if present, the endpoint guard fires.
    const out = await call("github_api", {});
    expect(out).toMatch(/requires an 'endpoint'|gh\) is not available/);
  });
});
