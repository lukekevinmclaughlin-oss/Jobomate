// Web tools for the MAOS electron tool dispatcher.
//
// Ports the read-only web_fetch / web_search behaviour from the Avalonia/.NET
// shell (AppServices.cs HostActions.WebFetch + AppServices.Tooling.cs
// RunWebSearchAsync/ParseSearchResults, and AgentIntegrations/WebGrounding.cs's
// HTML cleaning) onto Node 18+'s global fetch.
//
// Both tools are observational (no filesystem/process side effects), so neither
// calls ctx.approve — they need no user approval.
//
// Uses only Node.js built-ins (global fetch, URLSearchParams). No npm deps.

import { defineTool, type ToolModule, type ToolHandler } from "./types";
import { decideWebFetchUrl } from "../security/policy";

/** Cap on the string handed back to the model, per the dispatcher contract. */
const MAX_OUTPUT = 12_000;
/** Default search-engine host we route web_search through. */
const DDG_HTML = "https://duckduckgo.com/html/";
/** Browser-ish UA: the DDG HTML endpoint and many sites reject empty/library UAs. */
const USER_AGENT = "Mozilla/5.0 (compatible; MultiAgentOS/1.0)";
const FETCH_TIMEOUT_MS = 30_000;

/** A single parsed search hit. */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Hard-truncate with a visible marker so the model knows output was clipped. */
function truncate(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated: ${text.length - limit} more chars]`;
}

/** Decode the small set of HTML entities that survive tag-stripping. */
function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;|&#x0*27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0*38;|&amp;/gi, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      safeFromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      safeFromCodePoint(parseInt(dec, 10)),
    );
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Collapse runs of whitespace into single spaces and trim. */
function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * Strip an HTML document to readable plain text:
 * drop script/style/noscript/head blocks and comments, turn block-level tags
 * into line breaks, remove all remaining tags, decode entities, and tidy
 * whitespace so the model reads prose rather than markup.
 */
function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|header|footer|li|tr|h[1-6]|ul|ol|table|blockquote)>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  // Normalise whitespace: collapse intra-line runs, drop blank-line spam.
  return text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line, idx, all) => line.length > 0 || all[idx - 1]?.length > 0)
    .join("\n")
    .trim();
}

/** GET a URL with a UA header and a wall-clock timeout via AbortController. */
async function fetchUrl(
  url: string,
  accept: string,
): Promise<{ ok: boolean; status: number; statusText: string; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: accept },
    });
    const body = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DuckDuckGo's redirector wraps the real destination in a `uddg=` param
 * (e.g. /l/?uddg=https%3A%2F%2Fexample.com). Unwrap it and reject any URL that
 * still points back at duckduckgo.com.
 */
function normalizeResultUrl(href: string): string {
  if (!href) return "";
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    /* keep raw on malformed escapes */
  }
  const uddg = /[?&]uddg=([^&]+)/i.exec(decoded);
  if (uddg) {
    try {
      decoded = decodeURIComponent(uddg[1]);
    } catch {
      decoded = uddg[1];
    }
  }
  if (decoded.startsWith("//")) decoded = `https:${decoded}`;
  try {
    const u = new URL(decoded);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return "";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * Parse the DuckDuckGo HTML SERP into ranked results. Primary pass keys off the
 * `result__a` anchors (and the sibling `result__snippet`); a loose `uddg=`
 * fallback recovers links if the markup shifts. De-dupes by URL, preserving the
 * page's own ranking order.
 */
function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const anchorRe =
    /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<(?:div|td)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|td)>/gi;

  // Snippets, in document order, to pair positionally with the anchors.
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push(
      collapseWhitespace(
        decodeEntities((m[1] ?? m[2] ?? "").replace(/<[^>]+>/g, " ")),
      ),
    );
  }

  let idx = 0;
  for (let m = anchorRe.exec(html); m !== null; m = anchorRe.exec(html)) {
    const url = normalizeResultUrl(decodeEntities(m[1]));
    if (!url || seen.has(url)) {
      idx++;
      continue;
    }
    seen.add(url);
    const title = collapseWhitespace(
      decodeEntities(m[2].replace(/<[^>]+>/g, " ")),
    );
    results.push({ title: title || url, url, snippet: snippets[idx] ?? "" });
    idx++;
  }

  if (results.length > 0) return results;

  // Fallback: scrape any uddg-wrapped or bare external link.
  const looseRe = /uddg=([^&"']+)|href="(https?:\/\/[^"'#]+)"/gi;
  for (let m = looseRe.exec(html); m !== null; m = looseRe.exec(html)) {
    const raw = m[1] ?? m[2] ?? "";
    const url = normalizeResultUrl(decodeEntities(raw));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      results.push({ title: new URL(url).hostname, url, snippet: "" });
    } catch {
      /* skip unparseable */
    }
  }
  return results;
}

/** Reusable: run a web search and return parsed results (used by deep_research). */
export async function runWebSearch(query: string, max = 8): Promise<SearchResult[]> {
  const searchUrl = `${DDG_HTML}?${new URLSearchParams({ q: query }).toString()}`;
  const resp = await fetchUrl(searchUrl, "text/html");
  if (!resp.ok) return [];
  return parseSearchResults(resp.body).slice(0, Math.max(1, Math.min(max, 15)));
}

/** Reusable: fetch a URL and return readable text (SSRF-guarded, capped). */
export async function fetchReadable(url: string, limit = MAX_OUTPUT): Promise<string> {
  let target: URL;
  try {
    target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return "";
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return "";
  const ssrf = await decideWebFetchUrl(target.toString());
  if (!ssrf.allow) return "";
  try {
    const resp = await fetchUrl(target.toString(), "text/html,*/*");
    if (!resp.ok) return "";
    const isHtml = /<\s*(html|body|head|!doctype)\b/i.test(resp.body.slice(0, 4000));
    const text = isHtml ? htmlToText(resp.body) : resp.body.trim();
    return text.slice(0, limit);
  } catch {
    return "";
  }
}

const handleWebFetch: ToolHandler = async (args): Promise<string> => {
  const url = String(args.url ?? "").trim();
  if (!url) return "Error: web_fetch requires a 'url'.";

  let target: URL;
  try {
    target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return `Error: web_fetch could not parse URL: ${url}`;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return `Error: web_fetch only supports http(s) URLs (got ${target.protocol}).`;
  }

  // SSRF guard (#9): refuse to fetch private/loopback/link-local addresses
  // unless the user has opted in via MAOS_ALLOW_LOCAL_FETCH=1 (e.g. for local
  // Ollama / LM Studio). Prevents an LLM-supplied URL from probing the host's
  // own services (e.g. the MAOS control server on 127.0.0.1:9224).
  const ssrf = await decideWebFetchUrl(target.toString());
  if (!ssrf.allow) {
    return `Error: web_fetch refused (${ssrf.reason}).`;
  }

  let resp: Awaited<ReturnType<typeof fetchUrl>>;
  try {
    resp = await fetchUrl(target.toString(), "text/html,*/*");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `Error fetching ${target.toString()}: ${reason}`;
  }
  if (!resp.ok) {
    return `Error: web_fetch request failed (${resp.status} ${resp.statusText}) for ${target.toString()}`;
  }

  const isHtml = /<\s*(html|body|head|!doctype)\b/i.test(
    resp.body.slice(0, 4000),
  );
  const text = isHtml ? htmlToText(resp.body) : resp.body.trim();
  const header = `Fetched ${target.toString()} (${resp.status}, ${text.length} chars):\n`;
  return truncate(header + (text || "(no readable text content)"), MAX_OUTPUT);
};

const handleWebSearch: ToolHandler = async (args): Promise<string> => {
  const query = String(args.query ?? args.q ?? "").trim();
  if (!query) return "Error: web_search requires a 'query'.";

  const requested = Number(args.max_results ?? args.k ?? 8);
  const max = Math.min(
    Math.max(Number.isFinite(requested) ? Math.trunc(requested) : 8, 1),
    10,
  );

  const searchUrl = `${DDG_HTML}?${new URLSearchParams({ q: query }).toString()}`;
  let resp: Awaited<ReturnType<typeof fetchUrl>>;
  try {
    resp = await fetchUrl(searchUrl, "text/html");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `Error: web_search request failed: ${reason}`;
  }
  if (!resp.ok) {
    return `Error: web_search request failed (${resp.status} ${resp.statusText})`;
  }

  const results = parseSearchResults(resp.body).slice(0, max);
  const lines: string[] = [
    `Query: ${query}`,
    `Search URL: ${searchUrl}`,
    "Results:",
  ];
  if (results.length === 0) {
    lines.push("(no indexed results parsed)");
    return truncate(lines.join("\n"), MAX_OUTPUT);
  }
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) lines.push(`   ${truncate(r.snippet, 400)}`);
  });
  return truncate(lines.join("\n"), MAX_OUTPUT);
};

export const webToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "web_fetch",
      "Fetch a web page over HTTP(S) and return its readable text (HTML tags stripped). Read-only; no approval required.",
      {
        url: {
          type: "string",
          description:
            "The http(s) URL to fetch (a bare host is upgraded to https://).",
        },
      },
      ["url"],
    ),
    defineTool(
      "web_search",
      "Search the web (DuckDuckGo HTML endpoint) and return a ranked list of {title, url, snippet}. Read-only; no approval required.",
      {
        query: { type: "string", description: "The search query." },
        max_results: {
          type: "integer",
          description: "How many results to return (1-10, default 8).",
        },
      },
      ["query"],
    ),
  ],
  handlers: {
    web_fetch: handleWebFetch,
    web_search: handleWebSearch,
  },
};
