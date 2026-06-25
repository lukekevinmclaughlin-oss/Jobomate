// Desktop / computer-use tools (macOS). Lets the agent operate the whole machine,
// not just the in-app browser: capture the screen, type/keystroke into the
// frontmost app, launch apps, and (when `cliclick` is installed) move/click the
// mouse. Built on macOS built-ins — screencapture, osascript/System Events, open
// — with graceful messages where an optional helper is missing. All actions are
// sensitive and approval-gated.
import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type ToolModule } from "./types";

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    childProcess.execFile(cmd, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "") + (stderr || "") });
    });
  });
}

function osa(script: string): Promise<{ ok: boolean; out: string }> {
  return run("osascript", ["-e", script]);
}

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

function isMac(): boolean {
  return process.platform === "darwin";
}

async function hasCliclick(): Promise<boolean> {
  const r = await run("which", ["cliclick"]);
  return r.ok && r.out.trim().length > 0;
}

export const desktopToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "screen_capture",
      "Capture the screen to a PNG so you can see the desktop and reason about what's on it. macOS only.",
      { path: { type: "string", description: "Output .png path (default in the session dir)." } },
      []
    ),
    defineTool(
      "screen_size",
      "Get the main display's pixel dimensions (for planning mouse/coordinate actions). macOS only.",
      {},
      []
    ),
    defineTool(
      "open_app",
      "Launch (or focus) a native application by name, optionally opening a file/URL with it. macOS only.",
      { app: { type: "string", description: "Application name, e.g. 'Safari', 'Notes', 'Finder'." }, target: { type: "string", description: "Optional file path or URL to open." } },
      ["app"]
    ),
    defineTool(
      "type_text",
      "Type text into the frontmost application (System Events keystroke). macOS only.",
      { text: { type: "string", description: "The text to type." } },
      ["text"]
    ),
    defineTool(
      "press_keys",
      "Press a key or shortcut in the frontmost app, e.g. 'return', 'tab', 'cmd+s', 'cmd+shift+4'. macOS only.",
      { keys: { type: "string", description: "Key or modifier+key combo." } },
      ["keys"]
    ),
    defineTool(
      "mouse_click",
      "Move the mouse to (x, y) and click. Requires the 'cliclick' helper (brew install cliclick). macOS only.",
      { x: { type: "number" }, y: { type: "number" }, button: { type: "string", description: "left (default) | right | double." } },
      ["x", "y"]
    ),
  ],
  handlers: {
    screen_capture: async (args, ctx) => {
      if (!isMac()) return "screen_capture is macOS-only.";
      let out = str(args, "path", "file") || path.join(ctx.cwd, `maos-screenshot-${Date.now()}.png`);
      if (out.startsWith("~")) out = path.join(os.homedir(), out.slice(1));
      if (!path.isAbsolute(out)) out = path.resolve(ctx.cwd, out);
      if (!/\.png$/i.test(out)) out += ".png";
      if (!(await ctx.approve({ tool: "screen_capture", summary: `Capture the screen to ${out}` }))) return "Denied by user.";
      const r = await run("screencapture", ["-x", out]);
      if (!r.ok) return `screencapture failed (grant Screen Recording permission to the app in System Settings → Privacy). ${r.out}`.trim();
      ctx.openSidecar("preview", { filePath: out });
      return `Captured screen to ${out}.`;
    },

    screen_size: async () => {
      if (!isMac()) return "screen_size is macOS-only.";
      const r = await osa('tell application "Finder" to get bounds of window of desktop');
      const nums = (r.out.match(/-?\d+/g) || []).map(Number);
      if (nums.length >= 4) return `Main display: ${nums[2]}×${nums[3]} px.`;
      return `Could not read display size. ${r.out}`.trim();
    },

    open_app: async (args, ctx) => {
      if (!isMac()) return "open_app is macOS-only.";
      const app = str(args, "app", "name");
      if (!app) return "open_app needs an `app` name.";
      const target = str(args, "target", "file", "url");
      if (!(await ctx.approve({ tool: "open_app", summary: `Open ${app}${target ? ` with ${target}` : ""}` }))) return "Denied by user.";
      const cmdArgs = target ? ["-a", app, target] : ["-a", app];
      const r = await run("open", cmdArgs);
      return r.ok ? `Opened ${app}.` : `Could not open ${app}: ${r.out}`.trim();
    },

    type_text: async (args, ctx) => {
      if (!isMac()) return "type_text is macOS-only.";
      const text = str(args, "text", "value");
      if (!text) return "type_text needs `text`.";
      if (!(await ctx.approve({ tool: "type_text", summary: `Type "${text.slice(0, 60)}" into the frontmost app` }))) return "Denied by user.";
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const r = await osa(`tell application "System Events" to keystroke "${escaped}"`);
      return r.ok ? `Typed ${text.length} character(s).` : `Failed to type (grant Accessibility permission). ${r.out}`.trim();
    },

    press_keys: async (args, ctx) => {
      if (!isMac()) return "press_keys is macOS-only.";
      const keys = str(args, "keys", "key", "combo").toLowerCase();
      if (!keys) return "press_keys needs `keys`.";
      if (!(await ctx.approve({ tool: "press_keys", summary: `Press ${keys}` }))) return "Denied by user.";
      const parts = keys.split("+").map((p) => p.trim());
      const mods: string[] = [];
      let main = "";
      for (const p of parts) {
        if (["cmd", "command"].includes(p)) mods.push("command down");
        else if (["opt", "option", "alt"].includes(p)) mods.push("option down");
        else if (["ctrl", "control"].includes(p)) mods.push("control down");
        else if (["shift"].includes(p)) mods.push("shift down");
        else main = p;
      }
      const specials: Record<string, number> = { return: 36, enter: 36, tab: 48, space: 49, delete: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126 };
      const using = mods.length ? ` using {${mods.join(", ")}}` : "";
      let script: string;
      if (specials[main] !== undefined) script = `tell application "System Events" to key code ${specials[main]}${using}`;
      else script = `tell application "System Events" to keystroke "${main}"${using}`;
      const r = await osa(script);
      return r.ok ? `Pressed ${keys}.` : `Failed (grant Accessibility permission). ${r.out}`.trim();
    },

    mouse_click: async (args, ctx) => {
      if (!isMac()) return "mouse_click is macOS-only.";
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "mouse_click needs numeric `x` and `y`.";
      if (!(await hasCliclick())) return "mouse_click needs the 'cliclick' helper: install with `brew install cliclick`.";
      if (!(await ctx.approve({ tool: "mouse_click", summary: `Click at (${x}, ${y})` }))) return "Denied by user.";
      const button = str(args, "button") || "left";
      const verb = button === "right" ? "rc" : button === "double" ? "dc" : "c";
      const r = await run("cliclick", [`${verb}:${Math.round(x)},${Math.round(y)}`]);
      return r.ok ? `Clicked at (${Math.round(x)}, ${Math.round(y)}).` : `Click failed: ${r.out}`.trim();
    },
  },
};
