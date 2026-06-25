// Connectors — turn the agent into a workplace operator. http_request makes
// authenticated REST calls (the substrate for Slack/Notion/Jira/any API),
// send_email and calendar_add drive native macOS Mail/Calendar via AppleScript,
// and sql_query runs queries against a SQLite database. Mutating actions are
// approval-gated; http_request is SSRF-guarded.
import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type ToolContext, type ToolModule } from "./types";
import { decideWebFetchUrl } from "../security/policy";

const MAX_OUT = 12_000;

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

function run(cmd: string, a: string[], input?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = childProcess.execFile(cmd, a, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "") + (stderr || "") });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

function osa(script: string): Promise<{ ok: boolean; out: string }> {
  return run("osascript", ["-e", script]);
}

function trunc(s: string): string {
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + "\n…[truncated]" : s;
}

async function loadOptional(name: string): Promise<any | null> {
  try {
    return await import(name);
  } catch {
    return null;
  }
}

export const connectorToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "http_request",
      "Make an authenticated HTTP request to any API (the building block for Slack, Notion, Jira, " +
        "GitHub REST, webhooks, internal services). Provide `url`, optional `method`, `headers`, and " +
        "`body` (string or JSON object). GET is read-only; other methods are approval-gated.",
      {
        url: { type: "string" },
        method: { type: "string", description: "GET (default) | POST | PUT | PATCH | DELETE." },
        headers: { type: "object", description: "Header map, e.g. {Authorization: 'Bearer …'}." },
        body: { type: "string", description: "Request body (string, or pass a JSON object)." },
      },
      ["url"]
    ),
    defineTool(
      "send_email",
      "Send an email via the native macOS Mail app. Provide `to`, `subject`, `body`. Approval-gated.",
      { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" } },
      ["to", "subject", "body"]
    ),
    defineTool(
      "calendar_add",
      "Create an event in the native macOS Calendar. Provide `title`, `start` and `end` (ISO datetimes), " +
        "optional `calendar` name and `notes`. Approval-gated. macOS only.",
      { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, calendar: { type: "string" }, notes: { type: "string" } },
      ["title", "start"]
    ),
    defineTool(
      "sql_query",
      "Run a SQL query against a SQLite database file. Provide `db` (path) and `query`. SELECTs return " +
        "rows; mutations are approval-gated. Uses better-sqlite3 if installed, else the sqlite3 CLI.",
      { db: { type: "string" }, query: { type: "string" } },
      ["db", "query"]
    ),
  ],
  handlers: {
    http_request: async (args, ctx) => {
      const url = str(args, "url");
      if (!url) return "http_request needs a `url`.";
      let target: URL;
      try {
        target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      } catch {
        return `Invalid URL: ${url}`;
      }
      const ssrf = await decideWebFetchUrl(target.toString());
      if (!ssrf.allow) return `Refused (${ssrf.reason}).`;
      const method = (str(args, "method") || "GET").toUpperCase();
      const headers: Record<string, string> = {};
      if (args.headers && typeof args.headers === "object") {
        for (const [k, v] of Object.entries(args.headers)) headers[k] = String(v);
      }
      let body: string | undefined;
      if (args.body != null && method !== "GET" && method !== "HEAD") {
        body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
        if (typeof args.body !== "string" && !headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
      }
      if (method !== "GET" && method !== "HEAD") {
        if (!(await ctx.approve({ tool: "http_request", summary: `${method} ${target.toString()}` }))) return "Denied by user.";
      }
      try {
        const res = await fetch(target.toString(), { method, headers, body });
        const text = await res.text();
        return trunc(`${method} ${target.toString()} → ${res.status} ${res.statusText}\n\n${text}`);
      } catch (err) {
        return `Request failed: ${String((err as Error)?.message ?? err)}`;
      }
    },

    send_email: async (args, ctx) => {
      if (process.platform !== "darwin") return "send_email currently supports macOS Mail.";
      const to = str(args, "to");
      const subject = str(args, "subject");
      const body = str(args, "body");
      const cc = str(args, "cc");
      if (!to || !subject || !body) return "send_email needs `to`, `subject`, and `body`.";
      if (!(await ctx.approve({ tool: "send_email", summary: `Email "${subject}" to ${to}` }))) return "Denied by user.";
      const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const ccLine = cc ? `\n    make new cc recipient at end of cc recipients with properties {address:"${q(cc)}"}` : "";
      const script = `tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"${q(subject)}", content:"${q(body)}", visible:false}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:"${q(to)}"}${ccLine}
  end tell
  send newMessage
end tell`;
      const r = await osa(script);
      return r.ok ? `Sent email to ${to}.` : `Failed to send (is Mail configured?). ${r.out}`.trim();
    },

    calendar_add: async (args, ctx) => {
      if (process.platform !== "darwin") return "calendar_add currently supports macOS Calendar.";
      const title = str(args, "title", "summary");
      const start = str(args, "start");
      if (!title || !start) return "calendar_add needs `title` and `start`.";
      const startDate = new Date(start);
      if (isNaN(startDate.getTime())) return "calendar_add `start` must be a valid date/time.";
      const endRaw = str(args, "end");
      const endDate = endRaw && !isNaN(new Date(endRaw).getTime()) ? new Date(endRaw) : new Date(startDate.getTime() + 3600_000);
      const calName = str(args, "calendar") || "";
      const notes = str(args, "notes");
      if (!(await ctx.approve({ tool: "calendar_add", summary: `Add event "${title}" on ${startDate.toLocaleString()}` }))) return "Denied by user.";
      const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const dstr = (d: Date) => `date "${d.toLocaleString("en-US")}"`;
      const calTarget = calName ? `calendar "${q(calName)}"` : "calendar 1";
      const script = `tell application "Calendar"
  tell ${calTarget}
    make new event with properties {summary:"${q(title)}", start date:${dstr(startDate)}, end date:${dstr(endDate)}${notes ? `, description:"${q(notes)}"` : ""}}
  end tell
end tell`;
      const r = await osa(script);
      return r.ok ? `Added "${title}" to Calendar.` : `Failed to add event. ${r.out}`.trim();
    },

    sql_query: async (args, ctx) => {
      let db = str(args, "db", "database", "path");
      const query = str(args, "query", "sql");
      if (!db || !query) return "sql_query needs `db` and `query`.";
      if (db.startsWith("~")) db = path.join(os.homedir(), db.slice(1));
      if (!path.isAbsolute(db)) db = path.resolve(ctx.cwd, db);
      const isWrite = /^\s*(insert|update|delete|drop|create|alter|replace)\b/i.test(query);
      if (isWrite && !(await ctx.approve({ tool: "sql_query", summary: `Mutating SQL on ${db}` }))) return "Denied by user.";

      const mod = await loadOptional("better-sqlite3");
      if (mod) {
        try {
          const Database = mod.default ?? mod;
          const conn = new Database(db);
          try {
            if (/^\s*select|^\s*pragma|^\s*with/i.test(query)) {
              const rows = conn.prepare(query).all();
              return trunc(`${rows.length} row(s):\n${JSON.stringify(rows, null, 2)}`);
            }
            const info = conn.prepare(query).run();
            return `OK (changes: ${info.changes}, lastInsertRowid: ${info.lastInsertRowid}).`;
          } finally {
            conn.close();
          }
        } catch (err) {
          return `SQL error: ${String((err as Error)?.message ?? err)}`;
        }
      }
      // Fall back to the sqlite3 CLI if present.
      const r = await run("sqlite3", ["-header", "-column", db, query]);
      if (!r.ok && /not found|No such file|ENOENT/i.test(r.out)) {
        return "No SQLite driver available. Install with `npm i better-sqlite3` or ensure the `sqlite3` CLI is on PATH.";
      }
      return trunc(r.out.trim() || "OK (no output).");
    },
  },
};
