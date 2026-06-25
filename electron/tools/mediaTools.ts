// Multimodal media tools: text-to-speech (macOS `say`, always available), OCR of
// images/scanned docs, and audio transcription. OCR/transcription use optional
// engines loaded lazily — if they aren't installed the tool returns an honest
// "install X" note rather than failing, matching the repo's offline-first style.
import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type ToolContext, type ToolModule } from "./types";

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    childProcess.execFile(cmd, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "") + (stderr || "") });
    });
  });
}

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

function resolveFile(ctx: ToolContext, p: string): string {
  let r = p;
  if (r.startsWith("~")) r = path.join(os.homedir(), r.slice(1));
  if (!path.isAbsolute(r)) r = path.resolve(ctx.cwd, r);
  return r;
}

async function loadOptional(name: string): Promise<any | null> {
  try {
    return await import(name);
  } catch {
    return null;
  }
}

export const mediaToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "text_to_speech",
      "Convert text to spoken audio. With a `path` it saves an audio file (.aiff); otherwise it speaks " +
        "aloud through the speakers. macOS `say` (built-in). Optional `voice` (e.g. 'Samantha').",
      { text: { type: "string" }, path: { type: "string" }, voice: { type: "string" } },
      ["text"]
    ),
    defineTool(
      "ocr_image",
      "Extract text from an image or screenshot (OCR). Uses the optional 'tesseract.js' engine; if it " +
        "isn't installed, returns guidance to add it.",
      { path: { type: "string", description: "Path to the image file." }, lang: { type: "string", description: "OCR language (default eng)." } },
      ["path"]
    ),
    defineTool(
      "transcribe_audio",
      "Transcribe speech from an audio file to text. Uses an optional local Whisper engine " +
        "('nodejs-whisper'); if unavailable, returns guidance to add it.",
      { path: { type: "string" } },
      ["path"]
    ),
  ],
  handlers: {
    text_to_speech: async (args, ctx) => {
      if (process.platform !== "darwin") return "text_to_speech currently supports macOS (`say`).";
      const text = str(args, "text", "content");
      if (!text) return "text_to_speech needs `text`.";
      const voice = str(args, "voice");
      const outArg = str(args, "path", "file");
      const sayArgs: string[] = [];
      if (voice) sayArgs.push("-v", voice);
      if (outArg) {
        let out = resolveFile(ctx, outArg);
        if (!/\.(aiff|aif|m4a|wav)$/i.test(out)) out += ".aiff";
        if (!(await ctx.approve({ tool: "text_to_speech", summary: `Save speech to ${out}` }))) return "Denied by user.";
        sayArgs.push("-o", out, text);
        const r = await run("say", sayArgs);
        if (!r.ok) return `say failed: ${r.out}`.trim();
        ctx.openSidecar("preview", { filePath: out });
        return `Saved spoken audio to ${out}.`;
      }
      if (!(await ctx.approve({ tool: "text_to_speech", summary: `Speak aloud: "${text.slice(0, 60)}"` }))) return "Denied by user.";
      sayArgs.push(text);
      const r = await run("say", sayArgs);
      return r.ok ? "Spoke the text aloud." : `say failed: ${r.out}`.trim();
    },

    ocr_image: async (args, ctx) => {
      const file = resolveFile(ctx, str(args, "path", "file", "image"));
      if (!file) return "ocr_image needs an image `path`.";
      const lang = str(args, "lang") || "eng";
      const mod = await loadOptional("tesseract.js");
      if (!mod) {
        // Best-effort macOS fallback via the Vision-backed `shortcuts` is not guaranteed; be honest.
        return "OCR engine unavailable. Install it with `npm i tesseract.js` to enable ocr_image.";
      }
      try {
        const tesseract = mod.default ?? mod;
        const { data } = await tesseract.recognize(file, lang);
        const text = String(data?.text || "").trim();
        return text ? `OCR (${file}):\n\n${text.slice(0, 12_000)}` : "No text detected in the image.";
      } catch (err) {
        return `OCR failed: ${String((err as Error)?.message ?? err)}`;
      }
    },

    transcribe_audio: async (args, ctx) => {
      const file = resolveFile(ctx, str(args, "path", "file", "audio"));
      if (!file) return "transcribe_audio needs an audio `path`.";
      const mod = await loadOptional("nodejs-whisper");
      if (!mod) {
        return "Speech-to-text engine unavailable. Install it with `npm i nodejs-whisper` to enable transcribe_audio.";
      }
      try {
        const nodewhisper = mod.nodewhisper ?? mod.default ?? mod;
        const out = await nodewhisper(file, { modelName: "base.en" });
        const text = String(out || "").trim();
        return text ? `Transcript (${file}):\n\n${text.slice(0, 12_000)}` : "No speech detected.";
      } catch (err) {
        return `Transcription failed: ${String((err as Error)?.message ?? err)}`;
      }
    },
  },
};
