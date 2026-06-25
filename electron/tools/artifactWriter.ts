// Ported MAOS NativeArtifactWriter — produces real Office/PDF documents from model-supplied
// content using mature pure-JS libraries (pdf-lib / docx / pptxgenjs / exceljs). All outputs
// open in the Preview sidecar. Side-effecting → approval-gated.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { PDFDocument, StandardFonts, rgb, degrees, type PDFImage, type PDFPage } from "pdf-lib";
import { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun } from "docx";
import { defineTool, ToolContext, ToolModule } from "./types";

// pptxgenjs/exceljs declare an ESM `export default`/namespace but are CommonJS at runtime
// (module.exports IS the value). This repo builds with esModuleInterop:false, so a default
// import would resolve to `undefined` — require() to get the real constructor/namespace.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PptxGenJS: any = require("pptxgenjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ExcelJS: any = require("exceljs");

function resolvePath(ctx: ToolContext, p: string, ext: string): string {
  let out = p || `maos-document.${ext}`;
  if (out.startsWith("~")) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) out = path.resolve(ctx.cwd, out);
  if (!out.toLowerCase().endsWith(`.${ext}`)) out += `.${ext}`;
  return out;
}

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

/** A loaded raster image ready for embedding (pdf-lib / docx only handle PNG + JPG). */
interface LoadedImage {
  bytes: Buffer;
  type: "png" | "jpg";
  width: number;
  height: number;
  caption?: string;
}

/** Resolve an image reference (absolute/relative path or data: URL) to bytes. */
async function loadImage(ctx: ToolContext, ref: string, caption?: string): Promise<LoadedImage | null> {
  if (!ref) return null;
  let bytes: Buffer | null = null;
  if (/^data:image\//i.test(ref)) {
    const m = ref.match(/^data:image\/([a-z+]+);base64,(.+)$/i);
    if (!m) return null;
    bytes = Buffer.from(m[2], "base64");
  } else {
    let p = ref;
    if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) p = path.resolve(ctx.cwd, p);
    try {
      bytes = await fs.readFile(p);
    } catch {
      return null;
    }
  }
  if (!bytes || bytes.length < 8) return null;
  const type = sniffImageType(bytes);
  if (!type) return null; // SVG / unsupported — pdf-lib & docx can't embed these
  const dims = imageSize(bytes, type);
  return { bytes, type, width: dims.width, height: dims.height, caption };
}

function sniffImageType(bytes: Buffer): "png" | "jpg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

/** Read intrinsic pixel dimensions from PNG/JPEG headers (no native deps). */
function imageSize(bytes: Buffer, type: "png" | "jpg"): { width: number; height: number } {
  try {
    if (type === "png") {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    // JPEG: walk markers to the first Start-Of-Frame (SOF0–SOF15, excluding DHT/etc).
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const size = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + size;
    }
  } catch {
    /* fall through */
  }
  return { width: 1024, height: 1024 };
}

/** Pull an `images` argument that can be a string, array of strings, or array of {path,caption}. */
async function collectImages(ctx: ToolContext, args: Record<string, any>): Promise<LoadedImage[]> {
  const raw = args.images ?? args.image ?? args.pictures;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: LoadedImage[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      const img = await loadImage(ctx, entry);
      if (img) out.push(img);
    } else if (entry && typeof entry === "object") {
      const ref = String(entry.path ?? entry.src ?? entry.url ?? entry.file ?? "");
      const img = await loadImage(ctx, ref, entry.caption ? String(entry.caption) : undefined);
      if (img) out.push(img);
    }
  }
  return out;
}

/** Parse "#rrggbb" / "rrggbb" to pdf-lib rgb(); defaults to MAOS blue. */
function parseColor(value: string | undefined, fallback: [number, number, number] = [0.13, 0.4, 0.92]) {
  const hex = (value || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
  }
  return rgb(fallback[0], fallback[1], fallback[2]);
}

/** Split a content blob into paragraphs (blank-line separated). */
function paragraphs(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Word-wrap a single line to a max width using a pdf-lib font metric. */
function wrap(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = trial;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Parse rows for a spreadsheet from `rows` (2D array) or CSV-ish `content`. */
function tableRows(args: Record<string, any>): string[][] {
  if (Array.isArray(args.rows)) {
    return args.rows.map((r: any) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [String(r ?? "")]));
  }
  const content = str(args, "content", "csv", "data");
  if (!content) return [];
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.length)
    .map((l) => l.split(",").map((c) => c.trim()));
}

/** Parse slides from `slides` array or split `content` into one slide per paragraph. */
function slideSpecs(args: Record<string, any>): { title: string; bullets: string[] }[] {
  if (Array.isArray(args.slides)) {
    return args.slides.map((s: any, i: number) => {
      if (typeof s === "string") return { title: `Slide ${i + 1}`, bullets: [s] };
      const bullets = Array.isArray(s.bullets)
        ? s.bullets.map((b: any) => String(b))
        : typeof s.content === "string"
        ? s.content.split("\n").map((b: string) => b.trim()).filter(Boolean)
        : [];
      return { title: String(s.title ?? `Slide ${i + 1}`), bullets };
    });
  }
  const content = str(args, "content", "body");
  return paragraphs(content).map((p, i) => {
    const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
    return { title: lines[0] ?? `Slide ${i + 1}`, bullets: lines.slice(1) };
  });
}

async function embedImage(doc: PDFDocument, img: LoadedImage): Promise<PDFImage> {
  return img.type === "png" ? doc.embedPng(img.bytes) : doc.embedJpg(img.bytes);
}

async function makePdf(
  filePath: string,
  title: string,
  content: string,
  options: { images?: LoadedImage[]; accent?: string } = {}
): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const accent = parseColor(options.accent);
  const pageW = 612;
  const pageH = 792;
  const margin = 56;
  const maxW = pageW - margin * 2;
  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;

  const newPage = () => {
    page = doc.addPage([pageW, pageH]);
    y = pageH - margin;
  };

  const draw = (text: string, size: number, useBold: boolean, gap: number, color = rgb(0.1, 0.1, 0.12)) => {
    const f = useBold ? bold : font;
    for (const line of wrap(text, f, size, maxW)) {
      if (y < margin + size) newPage();
      page.drawText(line, { x: margin, y, size, font: f, color });
      y -= size + 4;
    }
    y -= gap;
  };

  // Designed title band across the top of the first page.
  if (title) {
    page.drawRectangle({ x: 0, y: pageH - 96, width: pageW, height: 96, color: accent });
    for (const line of wrap(title, bold, 24, maxW)) {
      page.drawText(line, { x: margin, y: pageH - 58, size: 24, font: bold, color: rgb(1, 1, 1) });
    }
    page.drawRectangle({ x: margin, y: pageH - 108, width: maxW, height: 3, color: accent });
    y = pageH - 140;
  }

  for (const p of paragraphs(content)) draw(p, 12, false, 10);

  // Embed images (scaled to the content width), each with an optional caption.
  for (const img of options.images ?? []) {
    const embedded = await embedImage(doc, img);
    const scale = Math.min(1, maxW / embedded.width);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    if (y - h < margin) newPage();
    y -= h;
    page.drawImage(embedded, { x: margin, y, width: w, height: h });
    y -= 8;
    if (img.caption) draw(img.caption, 10, false, 10, rgb(0.4, 0.4, 0.45));
    else y -= 8;
  }

  const bytes = await doc.save();
  await fs.writeFile(filePath, bytes);
}

async function makeDocx(
  filePath: string,
  title: string,
  content: string,
  images: LoadedImage[] = []
): Promise<void> {
  const children: Paragraph[] = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  for (const p of paragraphs(content)) {
    children.push(new Paragraph({ children: [new TextRun(p)] }));
    children.push(new Paragraph({ text: "" }));
  }
  for (const img of images) {
    const maxW = 600; // ~ content width in px at 96dpi for a default page
    const scale = Math.min(1, maxW / img.width);
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            data: img.bytes,
            type: img.type === "jpg" ? "jpg" : "png",
            transformation: { width: Math.round(img.width * scale), height: Math.round(img.height * scale) },
          } as ConstructorParameters<typeof ImageRun>[0]),
        ],
      })
    );
    if (img.caption) children.push(new Paragraph({ children: [new TextRun({ text: img.caption, italics: true, size: 18 })] }));
    children.push(new Paragraph({ text: "" }));
  }
  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(filePath, buffer);
}

async function makePptx(filePath: string, title: string, args: Record<string, any>): Promise<void> {
  const pptx = new PptxGenJS();
  if (title) {
    const cover = pptx.addSlide();
    cover.addText(title, { x: 0.5, y: 2.4, w: 9, h: 1.2, fontSize: 36, bold: true, align: "center" });
  }
  for (const s of slideSpecs(args)) {
    const slide = pptx.addSlide();
    slide.addText(s.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 26, bold: true });
    if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 16, breakLine: true } })),
        { x: 0.7, y: 1.4, w: 8.6, h: 5 }
      );
    }
  }
  await pptx.writeFile({ fileName: filePath });
}

/** Excel cell: a literal value, or a formula when the string starts with "=". */
function xlsxCell(value: string): string | number | { formula: string } {
  if (typeof value === "string" && value.startsWith("=") && value.length > 1) {
    return { formula: value.slice(1) };
  }
  const num = Number(value);
  return value !== "" && Number.isFinite(num) && String(num) === value.trim() ? num : value;
}

async function makeXlsx(filePath: string, sheetName: string, rows: string[][]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || "Sheet1");
  for (const r of rows) ws.addRow(r.map(xlsxCell));
  if (rows.length) {
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col: any) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: true }, (cell: any) => {
        max = Math.max(max, String(cell.value ?? "").length + 2);
      });
      col.width = Math.min(max, 60);
    });
  }
  await wb.xlsx.writeFile(filePath);
}

/** Resolve a reference to an existing file (no extension coercion). */
function resolveExisting(ctx: ToolContext, p: string): string {
  let out = p;
  if (out.startsWith("~")) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) out = path.resolve(ctx.cwd, out);
  return out;
}

/** Parse a page spec (1-based) into 0-based indices within [0, total). */
function parsePages(spec: unknown, total: number): number[] {
  const all = Array.from({ length: total }, (_, i) => i);
  if (spec == null || spec === "" || spec === "all") return all;
  if (spec === "first") return total ? [0] : [];
  if (spec === "last") return total ? [total - 1] : [];
  const tokens: string[] = Array.isArray(spec)
    ? spec.map((s) => String(s))
    : String(spec).split(/[,\s]+/);
  const out = new Set<number>();
  for (const tok of tokens) {
    if (!tok) continue;
    const range = tok.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) if (n >= 1 && n <= total) out.add(n - 1);
    } else {
      const n = parseInt(tok, 10);
      if (n >= 1 && n <= total) out.add(n - 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Compute an x/y placement for an element of size w×h on a page given a keyword. */
function placement(
  position: string,
  pageW: number,
  pageH: number,
  w: number,
  h: number,
  margin = 36
): { x: number; y: number } {
  const pos = (position || "center").toLowerCase();
  const left = margin;
  const right = pageW - w - margin;
  const cx = (pageW - w) / 2;
  const bottom = margin;
  const top = pageH - h - margin;
  const cy = (pageH - h) / 2;
  const map: Record<string, { x: number; y: number }> = {
    center: { x: cx, y: cy },
    top: { x: cx, y: top },
    bottom: { x: cx, y: bottom },
    left: { x: left, y: cy },
    right: { x: right, y: cy },
    "top-left": { x: left, y: top },
    "top-right": { x: right, y: top },
    "bottom-left": { x: left, y: bottom },
    "bottom-right": { x: right, y: bottom },
  };
  return map[pos] || map.center;
}

/** Run a single editing operation against one or more existing PDFs. */
async function editPdf(
  ctx: ToolContext,
  operation: string,
  source: string,
  output: string,
  args: Record<string, any>
): Promise<string> {
  const op = operation.toLowerCase().replace(/[\s-]+/g, "_");

  if (op === "merge") {
    const sources: string[] = Array.isArray(args.sources)
      ? args.sources.map((s: any) => String(s))
      : [source, ...(Array.isArray(args.append) ? args.append.map(String) : [])].filter(Boolean);
    if (sources.length < 2) return "merge needs at least two PDFs in `sources`.";
    const merged = await PDFDocument.create();
    for (const src of sources) {
      const bytes = await fs.readFile(resolveExisting(ctx, src));
      const doc = await PDFDocument.load(bytes);
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      copied.forEach((pg) => merged.addPage(pg));
    }
    await fs.writeFile(output, await merged.save());
    return `Merged ${sources.length} PDFs into ${output} (${merged.getPageCount()} pages).`;
  }

  const srcBytes = await fs.readFile(resolveExisting(ctx, source));
  const doc = await PDFDocument.load(srcBytes);
  const total = doc.getPageCount();
  const pages = doc.getPages();

  if (op === "stamp_text" || op === "watermark") {
    const text = str(args, "text", "content");
    if (!text) return "stamp_text needs `text`.";
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const size = Number(args.fontSize) > 0 ? Number(args.fontSize) : op === "watermark" ? 60 : 18;
    const color = parseColor(str(args, "color"), [0.6, 0.6, 0.62]);
    const opacity = Number(args.opacity) >= 0 && Number(args.opacity) <= 1 ? Number(args.opacity) : op === "watermark" ? 0.18 : 1;
    const rotation = op === "watermark" ? 45 : Number(args.rotate) || 0;
    for (const idx of parsePages(args.pages, total)) {
      const pg: PDFPage = pages[idx];
      const w = font.widthOfTextAtSize(text, size);
      const where =
        op === "watermark"
          ? { x: (pg.getWidth() - w * 0.7) / 2, y: pg.getHeight() / 2 }
          : placement(str(args, "position") || "bottom-right", pg.getWidth(), pg.getHeight(), w, size);
      pg.drawText(text, { x: where.x, y: where.y, size, font, color, opacity, rotate: degrees(rotation) });
    }
    await fs.writeFile(output, await doc.save());
    return `Stamped "${text.slice(0, 40)}" onto ${output}.`;
  }

  if (op === "add_image" || op === "stamp_image") {
    const img = await loadImage(ctx, str(args, "image", "path", "src", "file"));
    if (!img) return "add_image needs an `image` (PNG/JPG path or data URL).";
    const embedded = await embedImage(doc, img);
    for (const idx of parsePages(args.pages, total)) {
      const pg: PDFPage = pages[idx];
      const targetW = Number(args.width) > 0 ? Number(args.width) : Math.min(embedded.width, pg.getWidth() - 72);
      const scale = targetW / embedded.width;
      const w = embedded.width * scale;
      const h = embedded.height * scale;
      const where =
        typeof args.x === "number" && typeof args.y === "number"
          ? { x: Number(args.x), y: Number(args.y) }
          : placement(str(args, "position") || "center", pg.getWidth(), pg.getHeight(), w, h);
      pg.drawImage(embedded, { x: where.x, y: where.y, width: w, height: h, opacity: Number(args.opacity) || 1 });
    }
    await fs.writeFile(output, await doc.save());
    return `Placed image onto ${output}.`;
  }

  if (op === "delete_pages" || op === "remove_pages") {
    const drop = new Set(parsePages(args.pages, total));
    if (!drop.size) return "delete_pages needs `pages` to remove.";
    // Remove from the end so indices stay valid.
    [...drop].sort((a, b) => b - a).forEach((idx) => doc.removePage(idx));
    await fs.writeFile(output, await doc.save());
    return `Removed ${drop.size} page(s); ${doc.getPageCount()} remain in ${output}.`;
  }

  if (op === "extract" || op === "split" || op === "keep_pages") {
    const keep = parsePages(args.pages, total);
    if (!keep.length) return "extract needs `pages` to keep.";
    const out = await PDFDocument.create();
    const copied = await out.copyPages(doc, keep);
    copied.forEach((pg) => out.addPage(pg));
    await fs.writeFile(output, await out.save());
    return `Extracted ${keep.length} page(s) into ${output}.`;
  }

  if (op === "rotate") {
    const deg = Number(args.degrees ?? args.angle) || 90;
    for (const idx of parsePages(args.pages, total)) {
      const pg = pages[idx];
      const current = pg.getRotation().angle;
      pg.setRotation(degrees((current + deg) % 360));
    }
    await fs.writeFile(output, await doc.save());
    return `Rotated pages by ${deg}° in ${output}.`;
  }

  return `Unknown edit_pdf operation "${operation}". Use merge, stamp_text, watermark, add_image, delete_pages, extract, or rotate.`;
}

async function readPdfText(ctx: ToolContext, source: string, maxChars: number): Promise<string> {
  const pdfParse: any = require("pdf-parse");
  const bytes = await fs.readFile(resolveExisting(ctx, source));
  const data = await pdfParse(bytes);
  const text = String(data?.text || "").trim();
  if (!text) return "No extractable text (the PDF may be scanned/image-only).";
  const head = `PDF: ${source} — ${data?.numpages ?? "?"} page(s), ${text.length} chars.\n\n`;
  return head + (text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text);
}

export const artifactWriterModule: ToolModule = {
  definitions: [
    defineTool(
      "write_pdf",
      "Create a designed PDF from a title + text content (blank lines separate paragraphs). Supports " +
        "an accent-colored title band and embedded images. Pass `images` (PNG/JPG file paths or data " +
        "URLs — e.g. output from generate_image) to place pictures after the text, each with an " +
        "optional caption.",
      {
        path: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        accent: { type: "string", description: "Hex accent color for the title band, e.g. '#2563eb'." },
        images: {
          type: "array",
          description: "Images to embed: strings (path/data URL) or {path, caption} objects.",
          items: { type: "object" },
        },
      },
      ["content"]
    ),
    defineTool(
      "write_docx",
      "Create a Microsoft Word (.docx) document from a title and text content. Pass `images` " +
        "(PNG/JPG file paths or data URLs) to embed pictures, each with an optional caption.",
      {
        path: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        images: {
          type: "array",
          description: "Images to embed: strings (path/data URL) or {path, caption} objects.",
          items: { type: "object" },
        },
      },
      ["content"]
    ),
    defineTool(
      "edit_pdf",
      "Edit / manipulate an existing PDF. `operation` is one of: merge (combine `sources` PDFs), " +
        "stamp_text (overlay text), watermark (large diagonal text), add_image (place a PNG/JPG), " +
        "delete_pages, extract (keep only `pages`), rotate. `pages` accepts 'all'|'first'|'last', a " +
        "number, a list [1,3], or ranges like '2-4' (1-based). Writes to `output` (defaults to the " +
        "source with an '-edited' suffix).",
      {
        operation: {
          type: "string",
          description: "merge | stamp_text | watermark | add_image | delete_pages | extract | rotate",
        },
        source: { type: "string", description: "Path to the source PDF." },
        output: { type: "string", description: "Output path (optional)." },
        sources: { type: "array", description: "For merge: ordered list of PDF paths.", items: { type: "string" } },
        pages: { type: "string", description: "Target pages: 'all'|'first'|'last'|'1,3'|'2-4'." },
        text: { type: "string", description: "Text for stamp_text/watermark." },
        image: { type: "string", description: "Image (path/data URL) for add_image." },
        position: { type: "string", description: "center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right." },
        width: { type: "number", description: "Image width in points (add_image)." },
        degrees: { type: "number", description: "Rotation degrees (rotate)." },
        color: { type: "string", description: "Hex text color for stamps." },
        opacity: { type: "number", description: "0–1 opacity for stamps/images." },
      },
      ["operation", "source"]
    ),
    defineTool(
      "read_pdf",
      "Extract the text content of an existing PDF so you can read, summarize, or rewrite it.",
      { source: { type: "string" }, maxChars: { type: "number", description: "Truncation limit (default 20000)." } },
      ["source"]
    ),
    defineTool(
      "write_pptx",
      "Create a PowerPoint (.pptx) deck. Provide `slides` (array of {title,bullets[]}) or `content` (one slide per paragraph).",
      {
        path: { type: "string" },
        title: { type: "string", description: "Optional cover-slide title." },
        slides: { type: "array", items: { type: "object" }, description: "[{title, bullets:[...]}]" },
        content: { type: "string" },
      },
      []
    ),
    defineTool(
      "write_xlsx",
      "Create an Excel (.xlsx) workbook. Provide `rows` (2D array; first row = headers) or CSV `content`. " +
        "Numeric-looking cells become numbers; a cell that starts with '=' becomes a live formula " +
        "(e.g. '=SUM(B2:B4)').",
      {
        path: { type: "string" },
        sheet: { type: "string" },
        rows: { type: "array", items: { type: "array" } },
        content: { type: "string", description: "CSV rows, one per line." },
      },
      []
    ),
  ],
  handlers: {
    write_pdf: async (args, ctx) => {
      const filePath = resolvePath(ctx, str(args, "path", "file", "filename"), "pdf");
      if (!(await ctx.approve({ tool: "write_pdf", summary: `Create PDF ${filePath}` }))) return "Denied by user.";
      const images = await collectImages(ctx, args);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await makePdf(filePath, str(args, "title"), str(args, "content", "body", "text"), {
        images,
        accent: str(args, "accent", "color"),
      });
      ctx.openSidecar("preview", { filePath });
      return `Created PDF ${filePath}${images.length ? ` with ${images.length} image(s)` : ""}`;
    },

    write_docx: async (args, ctx) => {
      const filePath = resolvePath(ctx, str(args, "path", "file", "filename"), "docx");
      if (!(await ctx.approve({ tool: "write_docx", summary: `Create Word doc ${filePath}` }))) return "Denied by user.";
      const images = await collectImages(ctx, args);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await makeDocx(filePath, str(args, "title"), str(args, "content", "body", "text"), images);
      ctx.openSidecar("preview", { filePath });
      return `Created Word document ${filePath}${images.length ? ` with ${images.length} image(s)` : ""}`;
    },

    edit_pdf: async (args, ctx) => {
      const operation = str(args, "operation", "op");
      const source = str(args, "source", "path", "input", "file");
      if (!operation || !source) return "edit_pdf needs `operation` and `source`.";
      const defaultOut = resolveExisting(ctx, source).replace(/\.pdf$/i, "") + "-edited.pdf";
      const output = str(args, "output", "out", "dest") ? resolvePath(ctx, str(args, "output", "out", "dest"), "pdf") : defaultOut;
      if (!(await ctx.approve({ tool: "edit_pdf", summary: `${operation} → ${output}` }))) return "Denied by user.";
      await fs.mkdir(path.dirname(output), { recursive: true });
      const result = await editPdf(ctx, operation, source, output, args);
      if (!/^(merge|stamp|placed|removed|extracted|rotated)/i.test(result)) return result; // error string
      ctx.openSidecar("preview", { filePath: output });
      return result;
    },

    read_pdf: async (args, ctx) => {
      const source = str(args, "source", "path", "file", "input");
      if (!source) return "read_pdf needs `source`.";
      const maxChars = Number(args.maxChars) > 0 ? Number(args.maxChars) : 20000;
      try {
        return await readPdfText(ctx, source, maxChars);
      } catch (err) {
        return `Could not read PDF: ${String((err as Error)?.message ?? err)}`;
      }
    },

    write_pptx: async (args, ctx) => {
      const filePath = resolvePath(ctx, str(args, "path", "file", "filename"), "pptx");
      if (!(await ctx.approve({ tool: "write_pptx", summary: `Create PowerPoint ${filePath}` }))) return "Denied by user.";
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await makePptx(filePath, str(args, "title"), args);
      ctx.openSidecar("preview", { filePath });
      return `Created PowerPoint ${filePath}`;
    },

    write_xlsx: async (args, ctx) => {
      const filePath = resolvePath(ctx, str(args, "path", "file", "filename"), "xlsx");
      const rows = tableRows(args);
      if (!rows.length) return "No rows provided. Supply `rows` (2D array) or CSV `content`.";
      if (!(await ctx.approve({ tool: "write_xlsx", summary: `Create Excel workbook ${filePath}` }))) return "Denied by user.";
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await makeXlsx(filePath, str(args, "sheet", "sheetName"), rows);
      ctx.openSidecar("preview", { filePath });
      return `Created Excel workbook ${filePath} (${rows.length} rows)`;
    },
  },
};
