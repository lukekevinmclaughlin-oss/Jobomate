import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as electron from "electron";

/**
 * Spawns and supervises the headless Jobomate C# engine — the merged app's job-automation backend.
 * The engine exposes a localhost HTTP API on ENGINE_PORT that the React UI calls, and it drives the
 * in-app browser through the Electron control server on port 9222. One engine per app session.
 */
export const ENGINE_PORT = 9223;
let engineProc: ChildProcess | null = null;

function dotnetRoot(): string {
  return path.join(process.env.HOME || "", ".dotnet");
}

/** Locate the engine: a bundled self-contained binary in production, or the dev build in the repo. */
function findEngine(): { cmd: string; args: string[] } | null {
  const port = String(ENGINE_PORT);
  if (electron.app.isPackaged) {
    const bin = path.join(process.resourcesPath, "engine", "Jobomate");
    return fs.existsSync(bin) ? { cmd: bin, args: ["--engine", "--port", port] } : null;
  }
  const root = path.join(__dirname, ".."); // dist-electron/.. == repo root
  const nativeBin = path.join(root, "bin", "engine", "Jobomate");
  if (fs.existsSync(nativeBin)) return { cmd: nativeBin, args: ["--engine", "--port", port] };
  const dll = path.join(root, "Jobomate.App", "bin", "Debug", "net8.0", "Jobomate.dll");
  if (fs.existsSync(dll)) {
    const dotnet = path.join(dotnetRoot(), "dotnet");
    return { cmd: fs.existsSync(dotnet) ? dotnet : "dotnet", args: [dll, "--engine", "--port", port] };
  }
  return null;
}

/**
 * Start the engine. The optional `token` is a per-session shared secret: when provided it is passed
 * to the engine via JOBOMATE_ENGINE_TOKEN, and the engine then rejects any HTTP request that does
 * not present it in the X-Jobomate-Token header. This stops web pages loaded in the in-app browser
 * from reaching the loopback API cross-origin.
 */
export function startEngine(token?: string): void {
  if (engineProc) return;
  const found = findEngine();
  if (!found) {
    console.error("[jobomate-engine] engine binary not found (build it: scripts/build-engine.sh)");
    return;
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  const dr = dotnetRoot();
  if (fs.existsSync(dr)) {
    env.DOTNET_ROOT = dr;
    env.PATH = dr + ":" + (env.PATH || "");
  }
  if (token) env.JOBOMATE_ENGINE_TOKEN = token;
  console.log("[jobomate-engine] starting:", found.cmd, found.args.join(" "));
  engineProc = spawn(found.cmd, found.args, { env, stdio: ["ignore", "pipe", "pipe"] });
  engineProc.stdout?.on("data", (d) => console.log("[engine]", d.toString().trim()));
  engineProc.stderr?.on("data", (d) => console.error("[engine]", d.toString().trim()));
  engineProc.on("exit", (code) => {
    console.log("[jobomate-engine] exited", code);
    engineProc = null;
  });
}

export function stopEngine(): void {
  if (!engineProc) return;
  try { engineProc.kill("SIGTERM"); } catch { /* ignore */ }
  engineProc = null;
}
