// Shared offscreen HTML renderer. Uses a hidden Electron BrowserWindow to turn
// model-authored HTML/CSS into a full-fidelity PDF (printToPDF) or a raster PNG
// (capturePage). This is the single biggest document-quality lever in the
// harness: the LLM writes HTML (which models do extremely well) and we render it
// with a real browser engine instead of hand-laying primitives.
//
// Electron is required lazily (inside the functions) so this module — and the
// tool modules that use it — stay importable in unit tests without an Electron
// runtime.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface PdfRenderOptions {
  landscape?: boolean;
  /** Page size name understood by Electron (A4, Letter, Legal, Tabloid…). */
  pageSize?: string;
  printBackground?: boolean;
  marginsType?: number;
}

interface BrowserWindowLike {
  loadFile(p: string): Promise<void>;
  webContents: {
    printToPDF(opts: Record<string, unknown>): Promise<Buffer>;
    capturePage(): Promise<{ toPNG(): Buffer }>;
    setAudioMuted(muted: boolean): void;
  };
  destroy(): void;
  once(event: string, cb: () => void): void;
}

function loadElectron(): any {
  return require("electron");
}

async function withHiddenWindow<T>(
  width: number,
  height: number,
  html: string,
  fn: (win: BrowserWindowLike) => Promise<T>
): Promise<T> {
  const electron = loadElectron();
  const BrowserWindow = electron.BrowserWindow;
  if (!BrowserWindow) throw new Error("Electron BrowserWindow is unavailable (not running in the app).");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "maos-render-"));
  const htmlPath = path.join(tmpDir, "page.html");
  await fs.writeFile(htmlPath, html, "utf8");

  const win: BrowserWindowLike = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { offscreen: false, sandbox: true, javascript: true },
  });
  try {
    win.webContents.setAudioMuted(true);
    await win.loadFile(htmlPath);
    // Give web fonts / async scripts (e.g. charts) a beat to settle.
    await new Promise((r) => setTimeout(r, 350));
    return await fn(win);
  } finally {
    try {
      win.destroy();
    } catch {
      /* already gone */
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Render HTML to a PDF buffer using the browser engine's print pipeline. */
export async function renderHtmlToPdf(html: string, options: PdfRenderOptions = {}): Promise<Buffer> {
  return withHiddenWindow(1024, 1320, html, (win) =>
    win.webContents.printToPDF({
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? true,
      pageSize: options.pageSize ?? "A4",
    })
  );
}

/** Render HTML to a PNG buffer (used to rasterize charts/diagrams for embedding). */
export async function renderHtmlToPng(
  html: string,
  size: { width?: number; height?: number } = {}
): Promise<Buffer> {
  const width = Math.max(64, Math.min(Number(size.width) || 960, 4096));
  const height = Math.max(64, Math.min(Number(size.height) || 600, 4096));
  return withHiddenWindow(width, height, html, async (win) => {
    const image = await win.webContents.capturePage();
    return image.toPNG();
  });
}

/** True when an Electron BrowserWindow can be created in this process. */
export function canRenderHtml(): boolean {
  try {
    return Boolean(loadElectron()?.BrowserWindow);
  } catch {
    return false;
  }
}
