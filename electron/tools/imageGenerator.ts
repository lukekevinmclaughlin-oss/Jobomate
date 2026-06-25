// MAOS image generation. Two tiers:
//   1. Frontier raster — when an image-capable provider/key is connected, calls the provider's
//      diffusion image API (OpenAI gpt-image-1, xAI grok-2-image, Together FLUX, Google Imagen)
//      through the host hook (ctx.generateImage) and writes a real .png/.jpg.
//   2. Procedural vector fallback — offline / no key: classifies the prompt to a subject and draws
//      a deterministic SVG so the feature still works with the local model.
// Output opens in the Preview sidecar (both raster and SVG render inline).
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, ToolContext, ToolModule } from "./types";

function resolvePath(ctx: ToolContext, p: string, ext: string): string {
  let out = p || `maos-image.${ext}`;
  if (out.startsWith("~")) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) out = path.resolve(ctx.cwd, out);
  // Normalize the extension to match what we actually produced.
  out = out.replace(/\.(png|jpe?g|webp|gif|svg)$/i, "");
  return `${out}.${ext}`;
}

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Subject drawers — each returns SVG markup centered around (200,180) on a 400×400 canvas.
const SUBJECTS: { keys: string[]; bg: [string, string]; draw: () => string }[] = [
  {
    keys: ["heart", "love", "valentine"],
    bg: ["#ffe3ec", "#ff8fab"],
    draw: () =>
      `<path d="M200 260 C 120 200, 110 120, 170 110 C 195 107, 200 130, 200 140 C 200 130, 205 107, 230 110 C 290 120, 280 200, 200 260 Z" fill="#e63946" stroke="#9d0208" stroke-width="4"/>`,
  },
  {
    keys: ["star"],
    bg: ["#0b1d3a", "#1d3557"],
    draw: () =>
      `<polygon points="200,90 222,158 293,158 236,200 257,268 200,226 143,268 164,200 107,158 178,158" fill="#ffd60a" stroke="#ffb703" stroke-width="3"/>`,
  },
  {
    keys: ["sun", "sunny", "summer"],
    bg: ["#fff3b0", "#ffd166"],
    draw: () => {
      const rays = Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6;
        const x1 = 200 + Math.cos(a) * 70, y1 = 180 + Math.sin(a) * 70;
        const x2 = 200 + Math.cos(a) * 100, y2 = 180 + Math.sin(a) * 100;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#f48c06" stroke-width="6" stroke-linecap="round"/>`;
      }).join("");
      return `${rays}<circle cx="200" cy="180" r="55" fill="#ffba08"/>`;
    },
  },
  {
    keys: ["moon", "night"],
    bg: ["#03045e", "#023e8a"],
    draw: () =>
      `<circle cx="200" cy="180" r="65" fill="#f1faee"/><circle cx="225" cy="165" r="58" fill="#023e8a"/>`,
  },
  {
    keys: ["tree", "forest", "nature"],
    bg: ["#d8f3dc", "#95d5b2"],
    draw: () =>
      `<rect x="188" y="200" width="24" height="70" fill="#6f4518"/><circle cx="200" cy="160" r="60" fill="#2d6a4f"/><circle cx="160" cy="185" r="40" fill="#40916c"/><circle cx="240" cy="185" r="40" fill="#40916c"/>`,
  },
  {
    keys: ["flower", "rose", "bloom"],
    bg: ["#fff0f6", "#ffccd5"],
    draw: () => {
      const petals = Array.from({ length: 6 }, (_, i) => {
        const a = (i * Math.PI) / 3;
        const x = 200 + Math.cos(a) * 45, y = 160 + Math.sin(a) * 45;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="28" fill="#ff5d8f"/>`;
      }).join("");
      return `<rect x="196" y="200" width="8" height="80" fill="#2d6a4f"/>${petals}<circle cx="200" cy="160" r="24" fill="#ffd166"/>`;
    },
  },
  {
    keys: ["house", "home", "building"],
    bg: ["#caf0f8", "#90e0ef"],
    draw: () =>
      `<rect x="150" y="170" width="100" height="90" fill="#e9c46a"/><polygon points="140,170 200,110 260,170" fill="#e76f51"/><rect x="185" y="210" width="30" height="50" fill="#6f4518"/><rect x="160" y="185" width="22" height="22" fill="#48cae4"/><rect x="218" y="185" width="22" height="22" fill="#48cae4"/>`,
  },
  {
    keys: ["smile", "face", "happy", "emoji"],
    bg: ["#fff9db", "#ffe066"],
    draw: () =>
      `<circle cx="200" cy="180" r="80" fill="#ffd43b" stroke="#f08c00" stroke-width="4"/><circle cx="175" cy="160" r="9" fill="#212529"/><circle cx="225" cy="160" r="9" fill="#212529"/><path d="M165 205 Q200 240 235 205" fill="none" stroke="#212529" stroke-width="7" stroke-linecap="round"/>`,
  },
  {
    keys: ["cat", "kitten"],
    bg: ["#ede0d4", "#e6ccb2"],
    draw: () =>
      `<polygon points="155,130 175,90 195,135" fill="#9c6644"/><polygon points="245,130 225,90 205,135" fill="#9c6644"/><circle cx="200" cy="185" r="65" fill="#b08968"/><circle cx="180" cy="175" r="8" fill="#212529"/><circle cx="220" cy="175" r="8" fill="#212529"/><polygon points="195,195 205,195 200,203" fill="#6f4518"/>`,
  },
  {
    keys: ["fish", "ocean", "sea"],
    bg: ["#caf0f8", "#0096c7"],
    draw: () =>
      `<ellipse cx="195" cy="180" rx="70" ry="42" fill="#ff9e00"/><polygon points="255,180 300,150 300,210" fill="#ff7b00"/><circle cx="165" cy="170" r="8" fill="#03045e"/>`,
  },
  {
    keys: ["car", "vehicle", "auto"],
    bg: ["#dee2e6", "#adb5bd"],
    draw: () =>
      `<rect x="130" y="180" width="140" height="40" rx="10" fill="#d00000"/><path d="M160 180 L180 150 L240 150 L260 180 Z" fill="#e85d04"/><circle cx="165" cy="225" r="18" fill="#212529"/><circle cx="235" cy="225" r="18" fill="#212529"/>`,
  },
  {
    keys: ["mountain", "landscape", "hill"],
    bg: ["#a2d2ff", "#cdb4db"],
    draw: () =>
      `<polygon points="100,260 190,120 250,260" fill="#6c757d"/><polygon points="170,260 270,140 330,260" fill="#495057"/><polygon points="170,168 190,120 215,170" fill="#f8f9fa"/>`,
  },
];

function pickSubject(prompt: string) {
  const p = prompt.toLowerCase();
  for (const s of SUBJECTS) if (s.keys.some((k) => p.includes(k))) return s;
  return null;
}

function abstract(prompt: string): { bg: [string, string]; draw: () => string } {
  // Deterministic palette from the prompt so the same request looks the same.
  let h = 0;
  for (let i = 0; i < prompt.length; i++) h = (h * 31 + prompt.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const c = (offset: number) => `hsl(${(hue + offset) % 360} 70% 60%)`;
  return {
    bg: [`hsl(${hue} 60% 92%)`, `hsl(${(hue + 40) % 360} 60% 78%)`],
    draw: () =>
      `<circle cx="160" cy="160" r="70" fill="${c(0)}" opacity="0.85"/>` +
      `<rect x="190" y="150" width="110" height="110" rx="18" fill="${c(120)}" opacity="0.8"/>` +
      `<polygon points="200,90 250,200 150,200" fill="${c(220)}" opacity="0.8"/>`,
  };
}

function buildSvg(prompt: string, width: number, height: number): string {
  const subject = pickSubject(prompt) ?? abstract(prompt);
  const [c1, c2] = subject.bg;
  const caption = prompt.length > 70 ? prompt.slice(0, 67) + "…" : prompt;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 400 400">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="400" height="400" fill="url(#bg)"/>
  ${subject.draw()}
  <rect x="0" y="330" width="400" height="70" fill="rgba(0,0,0,0.45)"/>
  <text x="200" y="372" font-family="Inter, Helvetica, Arial, sans-serif" font-size="20" fill="#ffffff" text-anchor="middle">${esc(caption)}</text>
</svg>`;
}

export const imageGeneratorModule: ToolModule = {
  definitions: [
    defineTool(
      "generate_image",
      "Generate an image from a text prompt. When an image-capable provider is connected " +
        "(OpenAI gpt-image-1, xAI grok-2-image, Together FLUX, Google Imagen) this produces a real " +
        "photorealistic/diffusion raster (.png). Offline or without a key, it falls back to a " +
        "procedural vector (.svg) for common subjects. Use this to create artwork, illustrations, " +
        "icons, concept art, or images to embed into documents (pass the returned path to write_pdf/" +
        "write_docx/edit_pdf via their `images` argument).",
      {
        path: { type: "string", description: "Output path (extension is set automatically)." },
        prompt: { type: "string", description: "Detailed description of the image to create." },
        style: {
          type: "string",
          description: "Optional style hint, e.g. 'photorealistic', 'watercolor', 'flat vector', 'cinematic'.",
        },
        model: { type: "string", description: "Optional explicit image model override." },
        width: { type: "number", description: "Desired width in px (used to pick aspect ratio)." },
        height: { type: "number", description: "Desired height in px (used to pick aspect ratio)." },
      },
      ["prompt"]
    ),
  ],
  handlers: {
    generate_image: async (args, ctx) => {
      const prompt = str(args, "prompt", "description", "text");
      if (!prompt) return "No prompt provided.";
      const style = str(args, "style");
      const model = str(args, "model");
      const width = Number(args.width) > 0 ? Math.min(Number(args.width), 4096) : 1024;
      const height = Number(args.height) > 0 ? Math.min(Number(args.height), 4096) : 1024;

      if (
        !(await ctx.approve({
          tool: "generate_image",
          summary: `Generate image for "${prompt.slice(0, 60)}"`,
        }))
      )
        return "Denied by user.";

      // Tier 1: frontier raster via the connected provider.
      if (ctx.generateImage) {
        try {
          const raster = await ctx.generateImage({ prompt, width, height, style, model });
          if (raster && raster.data?.length) {
            const filePath = resolvePath(ctx, str(args, "path", "file", "filename"), raster.ext || "png");
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, raster.data);
            ctx.openSidecar("preview", { filePath });
            return `Generated image ${filePath} (${raster.model} via connected provider).`;
          }
        } catch (err) {
          // fall through to procedural fallback
          console.warn("[generate_image] frontier path failed:", (err as Error)?.message ?? err);
        }
      }

      // Tier 2: procedural vector fallback (offline-friendly).
      const filePath = resolvePath(ctx, str(args, "path", "file", "filename"), "svg");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, buildSvg(prompt, width, height), "utf8");
      ctx.openSidecar("preview", { filePath });
      const matched = pickSubject(prompt);
      return (
        `Generated procedural SVG ${filePath} (no image-capable provider connected — connect ` +
        `OpenAI/xAI/Together/Google in Settings for photorealistic output).` +
        (matched ? "" : " abstract composition — no specific subject recognized.")
      );
    },
  },
};
