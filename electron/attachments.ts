import * as fs from "fs/promises";
import * as path from "path";

// Files dropped into / picked from the AI Workbench composer arrive here as
// absolute paths (resolved in the renderer via webUtils.getPathForFile). We
// read them in the main process, turn each into plain text the connected LLM
// can reason over, and fold that text into the user's turn as context. Keeping
// the result a string means every provider/adapter (OpenAI, Anthropic, Google,
// the local ones) works unchanged — no multimodal content blocks required.

export interface AttachmentInput {
  path: string;
  name?: string;
  size?: number;
}

export type AttachmentKind = "text" | "pdf" | "docx" | "image" | "binary";

export interface ExtractedAttachment {
  name: string;
  kind: AttachmentKind;
  bytes: number;
  text: string;
  truncated: boolean;
  note?: string;
}

// Per-file and whole-turn caps so a big drop can't blow the model's context
// window. Generous enough for a long CV, contract, or source file.
export const PER_FILE_CHARS = 60_000;
export const TOTAL_CHARS = 180_000;
// Don't slurp an enormous file fully into memory; read at most this many bytes.
const MAX_READ_BYTES = 30 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".text", ".md", ".markdown", ".rst", ".log", ".csv", ".tsv",
  ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".conf", ".env", ".properties", ".xml", ".html", ".htm", ".svg",
  ".css", ".scss", ".less", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cpp",
  ".cc", ".hpp", ".cs", ".php", ".swift", ".m", ".mm", ".scala", ".sh",
  ".bash", ".zsh", ".fish", ".ps1", ".bat", ".sql", ".graphql", ".proto",
  ".dockerfile", ".makefile", ".gradle", ".lua", ".pl", ".r", ".dart",
  ".vue", ".svelte", ".astro", ".tex", ".bib", ".srt", ".vtt", ".ics",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
  ".heic", ".heif", ".avif", ".ico",
]);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}

// Heuristic: a binary file has NUL bytes or a high share of non-printable
// bytes. We only sample the head so this stays cheap on large files.
export function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  if (sample.length === 0) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    const printable =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128;
    if (!printable) suspicious += 1;
  }
  return suspicious / sample.length < 0.3;
}

export function decodeTextBuffer(buffer: Buffer): { text: string; truncated: boolean } {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  if (text.length > PER_FILE_CHARS) {
    return { text: text.slice(0, PER_FILE_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

// Optional document parsers. Loaded lazily so the feature ships and works for
// text/code/data even when these deps aren't installed; PDFs and DOCX light up
// automatically once they are. Variable specifier keeps it out of static
// module resolution.
async function loadOptional(moduleName: string): Promise<unknown | null> {
  try {
    const mod = await import(moduleName);
    return mod;
  } catch {
    return null;
  }
}

function callable<T>(mod: unknown): T | null {
  if (!mod) return null;
  const maybe = (mod as { default?: unknown }).default ?? mod;
  return maybe as T;
}

async function extractPdf(buffer: Buffer): Promise<{ text: string; note?: string }> {
  const mod = await loadOptional("pdf-parse");
  const pdfParse = callable<(data: Buffer) => Promise<{ text: string }>>(mod);
  if (!pdfParse) {
    return { text: "", note: "PDF text extraction is unavailable (install the 'pdf-parse' dependency)." };
  }
  try {
    const result = await pdfParse(buffer);
    const text = (result.text || "").trim();
    return text
      ? { text }
      : { text: "", note: "No selectable text found in this PDF (it may be scanned/image-only)." };
  } catch (error) {
    return { text: "", note: `PDF could not be parsed: ${errorText(error)}` };
  }
}

async function extractDocx(buffer: Buffer): Promise<{ text: string; note?: string }> {
  const mod = await loadOptional("mammoth");
  const mammoth = callable<{ extractRawText: (i: { buffer: Buffer }) => Promise<{ value: string }> }>(mod);
  if (!mammoth || typeof mammoth.extractRawText !== "function") {
    return { text: "", note: "DOCX text extraction is unavailable (install the 'mammoth' dependency)." };
  }
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value || "").trim();
    return text ? { text } : { text: "", note: "No text content found in this DOCX." };
  } catch (error) {
    return { text: "", note: `DOCX could not be parsed: ${errorText(error)}` };
  }
}

async function readCapped(filePath: string, bytes: number): Promise<Buffer> {
  if (bytes <= MAX_READ_BYTES) return fs.readFile(filePath);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function extractOne(input: AttachmentInput): Promise<ExtractedAttachment> {
  const filePath = (input.path || "").trim();
  const name = input.name || (filePath ? path.basename(filePath) : "attachment");
  const ext = path.extname(name).toLowerCase();
  const base: ExtractedAttachment = { name, kind: "binary", bytes: input.size || 0, text: "", truncated: false };

  if (!filePath) {
    return { ...base, note: "Attachment had no readable path." };
  }

  let stat: { size: number };
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    return { ...base, note: `Could not read file: ${errorText(error)}` };
  }
  base.bytes = stat.size;

  try {
    if (ext === ".pdf") {
      const buffer = await readCapped(filePath, stat.size);
      const { text, note } = await extractPdf(buffer);
      const capped = text.length > PER_FILE_CHARS;
      return { ...base, kind: "pdf", text: capped ? text.slice(0, PER_FILE_CHARS) : text, truncated: capped, note };
    }

    if (ext === ".docx") {
      const buffer = await readCapped(filePath, stat.size);
      const { text, note } = await extractDocx(buffer);
      const capped = text.length > PER_FILE_CHARS;
      return { ...base, kind: "docx", text: capped ? text.slice(0, PER_FILE_CHARS) : text, truncated: capped, note };
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      return {
        ...base,
        kind: "image",
        note:
          "Image file attached. The connected text model can't read images directly — " +
          "switch to a vision-capable provider (OpenAI, Anthropic, or Google) to analyze image content.",
      };
    }

    const buffer = await readCapped(filePath, stat.size);
    if (TEXT_EXTENSIONS.has(ext) || looksLikeText(buffer)) {
      const { text, truncated } = decodeTextBuffer(buffer);
      return { ...base, kind: "text", text, truncated };
    }

    return {
      ...base,
      note: `Binary file (${ext || "no extension"}) — no text could be extracted.`,
    };
  } catch (error) {
    return { ...base, note: `Could not process file: ${errorText(error)}` };
  }
}

export async function extractAttachments(inputs: AttachmentInput[]): Promise<ExtractedAttachment[]> {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  return Promise.all(inputs.slice(0, 20).map((input) => extractOne(input)));
}

// Render extracted attachments into a single context block prepended to the
// user's message. Enforces a whole-turn character budget across files.
export function buildAttachmentContext(items: ExtractedAttachment[]): string {
  if (!items.length) return "";
  const total = items.length;
  const blocks: string[] = [];
  let used = 0;

  items.forEach((item, index) => {
    const headerKind = item.kind === "text" ? "" : `, ${item.kind}`;
    const header = `----- FILE ${index + 1}/${total}: ${item.name} (${formatBytes(item.bytes)}${headerKind}) -----`;
    const footer = `----- END FILE ${index + 1}/${total} -----`;
    let body: string;
    if (item.text) {
      const remaining = Math.max(0, TOTAL_CHARS - used);
      if (remaining <= 0) {
        body = "[Omitted: attachment budget for this turn was reached.]";
      } else if (item.text.length > remaining) {
        body = `${item.text.slice(0, remaining)}\n[...truncated to fit the attachment budget for this turn.]`;
        used = TOTAL_CHARS;
      } else {
        body = item.truncated ? `${item.text}\n[...truncated at ${PER_FILE_CHARS} characters.]` : item.text;
        used += item.text.length;
      }
    } else {
      body = `[${item.note || "No text content."}]`;
    }
    blocks.push(`${header}\n${body}\n${footer}`);
  });

  const intro =
    total === 1
      ? "The user attached 1 file. Treat its content below as authoritative reference material for the request."
      : `The user attached ${total} files. Treat their content below as authoritative reference material for the request.`;

  return `${intro}\n\n${blocks.join("\n\n")}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
