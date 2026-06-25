// Advanced document rendering: full-fidelity HTML→PDF, data-viz charts, diagrams,
// and template mail-merge. These turn the harness from "emits text PDFs" into
// "produces designed, web-quality documents with visuals".
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type ToolContext, type ToolModule } from "./types";
import { renderHtmlToPdf, renderHtmlToPng, canRenderHtml } from "./htmlRender";

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

function resolveOut(ctx: ToolContext, p: string, ext: string, fallback: string): string {
  let out = p || fallback;
  if (out.startsWith("~")) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) out = path.resolve(ctx.cwd, out);
  if (!new RegExp(`\\.${ext}$`, "i").test(out)) out = out.replace(/\.[a-z0-9]+$/i, "") + `.${ext}`;
  return out;
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Charts (deterministic SVG, no deps) -----------------------------------

interface ChartPoint {
  label: string;
  value: number;
}

function parseSeries(args: Record<string, any>): ChartPoint[] {
  const data = args.data ?? args.series ?? args.values;
  const points: ChartPoint[] = [];
  if (Array.isArray(data)) {
    data.forEach((d: any, i: number) => {
      if (typeof d === "number") points.push({ label: String(i + 1), value: d });
      else if (d && typeof d === "object")
        points.push({ label: String(d.label ?? d.name ?? d.x ?? i + 1), value: Number(d.value ?? d.y ?? 0) });
    });
  } else if (data && typeof data === "object") {
    for (const [label, value] of Object.entries(data)) points.push({ label, value: Number(value) });
  }
  return points.filter((p) => Number.isFinite(p.value));
}

const PALETTE = ["#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

function chartSvg(type: string, title: string, points: ChartPoint[]): string {
  const W = 720;
  const H = 460;
  const pad = 64;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const max = Math.max(1, ...points.map((p) => p.value));
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${title ? `<text x="${W / 2}" y="34" font-size="20" font-weight="700" text-anchor="middle" fill="#0f172a">${esc(title)}</text>` : ""}`;
  let body = "";

  if (type === "pie" || type === "doughnut") {
    const total = points.reduce((s, p) => s + p.value, 0) || 1;
    const cx = W / 2;
    const cy = H / 2 + 10;
    const r = Math.min(plotW, plotH) / 2;
    let a0 = -Math.PI / 2;
    points.forEach((p, i) => {
      const a1 = a0 + (p.value / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0);
      const y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1);
      const y1 = cy + r * Math.sin(a1);
      body += `<path d="M${cx} ${cy} L${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}"/>`;
      const mid = (a0 + a1) / 2;
      const lx = cx + r * 0.62 * Math.cos(mid);
      const ly = cy + r * 0.62 * Math.sin(mid);
      const pct = Math.round((p.value / total) * 100);
      if (pct >= 5) body += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="12" fill="#fff" text-anchor="middle">${pct}%</text>`;
      a0 = a1;
    });
    // legend
    points.forEach((p, i) => {
      const ly = 70 + i * 22;
      body += `<rect x="${W - 180}" y="${ly - 11}" width="12" height="12" fill="${PALETTE[i % PALETTE.length]}"/><text x="${W - 162}" y="${ly}" font-size="12" fill="#334155">${esc(p.label)}</text>`;
    });
  } else if (type === "line") {
    const stepX = points.length > 1 ? plotW / (points.length - 1) : plotW;
    const pts = points.map((p, i) => [pad + i * stepX, pad + plotH - (p.value / max) * plotH]);
    body += `<line x1="${pad}" y1="${pad + plotH}" x2="${pad + plotW}" y2="${pad + plotH}" stroke="#cbd5e1"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${pad + plotH}" stroke="#cbd5e1"/>`;
    body += `<polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="${PALETTE[0]}" stroke-width="3"/>`;
    pts.forEach((p, i) => {
      body += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${PALETTE[0]}"/>`;
      body += `<text x="${p[0].toFixed(1)}" y="${pad + plotH + 18}" font-size="11" text-anchor="middle" fill="#64748b">${esc(points[i].label)}</text>`;
    });
  } else {
    // bar (default)
    const bw = (plotW / points.length) * 0.6;
    const gap = (plotW / points.length) * 0.4;
    body += `<line x1="${pad}" y1="${pad + plotH}" x2="${pad + plotW}" y2="${pad + plotH}" stroke="#cbd5e1"/>`;
    points.forEach((p, i) => {
      const h = (p.value / max) * plotH;
      const x = pad + i * (bw + gap) + gap / 2;
      const y = pad + plotH - h;
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${PALETTE[i % PALETTE.length]}"/>`;
      body += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" text-anchor="middle" fill="#334155">${p.value}</text>`;
      body += `<text x="${(x + bw / 2).toFixed(1)}" y="${pad + plotH + 18}" font-size="11" text-anchor="middle" fill="#64748b">${esc(p.label)}</text>`;
    });
  }
  return `${head}${body}</svg>`;
}

function fillTemplate(template: string, values: Record<string, any>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = values?.[key];
    return v == null ? "" : String(v);
  });
}

export const documentRenderModule: ToolModule = {
  definitions: [
    defineTool(
      "render_html_pdf",
      "Render model-authored HTML/CSS into a full-fidelity, web-quality PDF using the browser engine " +
        "(real layout, fonts, colors, tables, columns). Best tool for designed documents: brochures, " +
        "reports, invoices, resumes, newsletters. Provide `html` (full document or fragment) or an " +
        "`htmlPath` to a file.",
      {
        path: { type: "string", description: "Output .pdf path." },
        html: { type: "string", description: "The HTML document/fragment to render." },
        htmlPath: { type: "string", description: "Path to an .html file to render instead of inline html." },
        landscape: { type: "boolean" },
        pageSize: { type: "string", description: "A4 | Letter | Legal | Tabloid (default A4)." },
      },
      []
    ),
    defineTool(
      "generate_chart",
      "Create a chart (bar | line | pie) from data as an SVG (or PNG with format:'png' for embedding " +
        "into raster PDFs/Word docs). Provide `data` as [{label,value}], a number array, or a " +
        "{label:value} object.",
      {
        path: { type: "string" },
        type: { type: "string", description: "bar | line | pie (default bar)." },
        title: { type: "string" },
        data: { type: "array", description: "[{label, value}] | [numbers] | {label: value}." },
        format: { type: "string", description: "svg (default) | png." },
      },
      ["data"]
    ),
    defineTool(
      "generate_diagram",
      "Render a Mermaid diagram (flowchart, sequence, gantt, class, ER, mindmap…) to PNG/SVG using the " +
        "browser engine. Provide Mermaid source in `code`. Requires network access to load Mermaid.",
      {
        path: { type: "string" },
        code: { type: "string", description: "Mermaid diagram source." },
        format: { type: "string", description: "png (default) | pdf." },
      },
      ["code"]
    ),
    defineTool(
      "merge_template",
      "Mail-merge: fill {{placeholders}} in a template with `values` and write the result. With " +
        "`render:true` (and HTML content) the filled template is rendered to PDF. Use `rows` to produce " +
        "one output per record (batch personalization).",
      {
        template: { type: "string", description: "Template text/HTML with {{placeholders}}." },
        templatePath: { type: "string", description: "Path to a template file." },
        values: { type: "object", description: "Key→value map for a single document." },
        rows: { type: "array", description: "Array of value maps for batch output." },
        path: { type: "string", description: "Output path (or basename for batch)." },
        render: { type: "boolean", description: "Render the filled HTML to PDF." },
      },
      []
    ),
  ],
  handlers: {
    render_html_pdf: async (args, ctx) => {
      let html = str(args, "html", "content", "body");
      const htmlPath = str(args, "htmlPath", "input");
      if (!html && htmlPath) html = await fs.readFile(resolveOut(ctx, htmlPath, "html", "in.html"), "utf8").catch(() => "");
      if (!html) return "render_html_pdf needs `html` or `htmlPath`.";
      if (!canRenderHtml()) return "HTML rendering is unavailable (no Electron browser engine in this process).";
      const out = resolveOut(ctx, str(args, "path", "file"), "pdf", "document.pdf");
      if (!(await ctx.approve({ tool: "render_html_pdf", summary: `Render PDF ${out}` }))) return "Denied by user.";
      const doc = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Inter,Helvetica,Arial,sans-serif;margin:40px;color:#0f172a;line-height:1.5}</style></head><body>${html}</body></html>`;
      const pdf = await renderHtmlToPdf(doc, { landscape: Boolean(args.landscape), pageSize: str(args, "pageSize") || "A4" });
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, pdf);
      ctx.openSidecar("preview", { filePath: out });
      return `Rendered HTML to PDF ${out} (${pdf.length} bytes).`;
    },

    generate_chart: async (args, ctx) => {
      const points = parseSeries(args);
      if (!points.length) return "generate_chart needs `data` ([{label,value}] / numbers / {label:value}).";
      const type = (str(args, "type") || "bar").toLowerCase();
      const svg = chartSvg(type, str(args, "title"), points);
      const wantPng = (str(args, "format") || "svg").toLowerCase() === "png";
      if (!(await ctx.approve({ tool: "generate_chart", summary: `Create ${type} chart` }))) return "Denied by user.";
      if (wantPng && canRenderHtml()) {
        const out = resolveOut(ctx, str(args, "path", "file"), "png", "chart.png");
        const png = await renderHtmlToPng(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { width: 720, height: 460 });
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, png);
        ctx.openSidecar("preview", { filePath: out });
        return `Created ${type} chart ${out} (PNG, embeddable into PDFs/Word docs).`;
      }
      const out = resolveOut(ctx, str(args, "path", "file"), "svg", "chart.svg");
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, svg, "utf8");
      ctx.openSidecar("preview", { filePath: out });
      return `Created ${type} chart ${out} (SVG).`;
    },

    generate_diagram: async (args, ctx) => {
      const code = str(args, "code", "diagram", "mermaid");
      if (!code) return "generate_diagram needs Mermaid `code`.";
      if (!canRenderHtml()) return "Diagram rendering is unavailable (no browser engine in this process).";
      const fmt = (str(args, "format") || "png").toLowerCase();
      if (!(await ctx.approve({ tool: "generate_diagram", summary: `Render Mermaid diagram` }))) return "Denied by user.";
      const html = `<!doctype html><html><head><meta charset="utf-8">
        <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></head>
        <body style="margin:0;padding:16px;background:#fff">
        <pre class="mermaid">${esc(code)}</pre>
        <script>mermaid.initialize({startOnLoad:true});</script></body></html>`;
      if (fmt === "pdf") {
        const out = resolveOut(ctx, str(args, "path", "file"), "pdf", "diagram.pdf");
        const pdf = await renderHtmlToPdf(html);
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, pdf);
        ctx.openSidecar("preview", { filePath: out });
        return `Rendered Mermaid diagram to ${out}.`;
      }
      const out = resolveOut(ctx, str(args, "path", "file"), "png", "diagram.png");
      const png = await renderHtmlToPng(html, { width: 1000, height: 700 });
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, png);
      ctx.openSidecar("preview", { filePath: out });
      return `Rendered Mermaid diagram to ${out}. If empty, check network access for the Mermaid CDN.`;
    },

    merge_template: async (args, ctx) => {
      let template = str(args, "template", "content");
      const tplPath = str(args, "templatePath", "templateFile");
      if (!template && tplPath) template = await fs.readFile(resolveOut(ctx, tplPath, "txt", "tpl.txt"), "utf8").catch(() => "");
      if (!template) return "merge_template needs `template` or `templatePath`.";
      const render = Boolean(args.render) && /<[a-z]/i.test(template);
      const rows: Record<string, any>[] = Array.isArray(args.rows)
        ? args.rows
        : [args.values && typeof args.values === "object" ? args.values : {}];
      if (!(await ctx.approve({ tool: "merge_template", summary: `Fill template (${rows.length} record(s))` }))) return "Denied by user.";
      const ext = render ? "pdf" : /<[a-z]/i.test(template) ? "html" : "txt";
      const base = resolveOut(ctx, str(args, "path", "file"), ext, `merged.${ext}`);
      const outputs: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const filled = fillTemplate(template, rows[i]);
        const out = rows.length > 1 ? base.replace(new RegExp(`\\.${ext}$`), `-${i + 1}.${ext}`) : base;
        await fs.mkdir(path.dirname(out), { recursive: true });
        if (render && canRenderHtml()) await fs.writeFile(out, await renderHtmlToPdf(filled));
        else await fs.writeFile(out, filled, "utf8");
        outputs.push(out);
      }
      ctx.openSidecar("preview", { filePath: outputs[0] });
      return `Wrote ${outputs.length} document(s): ${outputs.map((o) => path.basename(o)).join(", ")}`;
    },
  },
};
