// Persistent semantic memory / lightweight RAG store. Embeds text into vectors
// (via the connected provider's embeddings API when available, else a local
// deterministic lexical embedding so it works fully offline) and stores them in
// ~/.maos/memory.json. Gives the agent long-term recall across sessions and
// retrieval over the user's own files.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { defineTool, type ToolContext, type ToolModule } from "./types";

const STORE_DIR = path.join(process.env.MAOS_HOME || os.homedir(), ".maos");
const STORE_PATH = path.join(STORE_DIR, "memory.json");
const LOCAL_DIM = 256;

interface MemoryItem {
  id: string;
  text: string;
  tags: string[];
  source: string;
  at: number;
  vector: number[];
}
interface MemoryStore {
  version: number;
  method: "local" | "provider";
  items: MemoryItem[];
}

function str(args: Record<string, any>, ...keys: string[]): string {
  for (const k of keys) if (typeof args[k] === "string" && args[k]) return args[k];
  return "";
}

async function loadStore(): Promise<MemoryStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) return parsed;
  } catch {
    /* fresh store */
  }
  return { version: 1, method: "local", items: [] };
}

async function saveStore(store: MemoryStore): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store), "utf8");
}

/** Deterministic local embedding: hashed bag-of-words, tf-weighted + L2-normalized. */
function localEmbed(text: string): number[] {
  const vec = new Array(LOCAL_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[Math.abs(h) % LOCAL_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Embed texts using the store's method (provider when possible, else local). */
async function embedTexts(
  ctx: ToolContext,
  store: MemoryStore,
  texts: string[]
): Promise<{ vectors: number[][]; method: "local" | "provider" }> {
  if (ctx.embed) {
    try {
      const provider = await ctx.embed(texts);
      if (provider && provider.length === texts.length && provider.every((v) => v.length > 0)) {
        return { vectors: provider.map(normalize), method: "provider" };
      }
    } catch {
      /* fall back to local */
    }
  }
  return { vectors: texts.map(localEmbed), method: "local" };
}

function chunk(text: string, size = 1500): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const out: string[] = [];
  const paras = clean.split(/\n{2,}/);
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > size && buf) {
      out.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? buf + "\n\n" + p : p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export const memoryToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "remember",
      "Store a fact, preference, or note in long-term semantic memory (persists across sessions). " +
        "Use this whenever the user shares something worth recalling later.",
      {
        text: { type: "string", description: "The content to remember." },
        tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
      },
      ["text"]
    ),
    defineTool(
      "recall",
      "Search long-term memory semantically and return the most relevant stored items.",
      { query: { type: "string" }, k: { type: "number", description: "How many results (default 5)." } },
      ["query"]
    ),
    defineTool(
      "index_files",
      "Index files into semantic memory for retrieval (RAG). Provide `paths` (files) and/or a `dir`. " +
        "Each file is chunked and embedded so you can later `recall` over its contents.",
      {
        paths: { type: "array", items: { type: "string" } },
        dir: { type: "string", description: "Directory to index (top-level text files)." },
        tags: { type: "array", items: { type: "string" } },
      },
      []
    ),
    defineTool("memory_list", "List stored memory items (most recent first).", { limit: { type: "number" } }, []),
    defineTool(
      "memory_forget",
      "Delete a memory item by id, or pass all:true to clear all memory.",
      { id: { type: "string" }, all: { type: "boolean" } },
      []
    ),
  ],
  handlers: {
    remember: async (args, ctx) => {
      const text = str(args, "text", "content", "note");
      if (!text) return "remember needs `text`.";
      const store = await loadStore();
      const { vectors, method } = await embedTexts(ctx, store, [text]);
      if (store.items.length === 0) store.method = method;
      store.items.push({
        id: crypto.randomUUID(),
        text,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        source: "user",
        at: Date.now(),
        vector: vectors[0],
      });
      await saveStore(store);
      return `Remembered (${store.items.length} item(s) in memory, ${store.method} embeddings).`;
    },

    recall: async (args, ctx) => {
      const query = str(args, "query", "q", "text");
      if (!query) return "recall needs `query`.";
      const k = Math.max(1, Math.min(Number(args.k) || 5, 20));
      const store = await loadStore();
      if (!store.items.length) return "Memory is empty.";
      const { vectors, method } = await embedTexts(ctx, store, [query]);
      let scored: { item: MemoryItem; score: number }[];
      if (method === store.method) {
        scored = store.items.map((item) => ({ item, score: cosine(vectors[0], item.vector) }));
      } else {
        // Method mismatch (e.g. provider went offline) — degrade to keyword overlap.
        const qTokens = new Set((query.toLowerCase().match(/[a-z0-9]+/g) || []));
        scored = store.items.map((item) => {
          const t = new Set((item.text.toLowerCase().match(/[a-z0-9]+/g) || []));
          let overlap = 0;
          qTokens.forEach((w) => t.has(w) && overlap++);
          return { item, score: overlap / (qTokens.size || 1) };
        });
      }
      const top = scored.sort((a, b) => b.score - a.score).slice(0, k).filter((s) => s.score > 0);
      if (!top.length) return "No relevant memories found.";
      return top
        .map((s) => `• (${s.score.toFixed(2)}${s.item.tags.length ? ", " + s.item.tags.join("/") : ""}) ${s.item.text}\n  [id:${s.item.id} src:${s.item.source}]`)
        .join("\n");
    },

    index_files: async (args, ctx) => {
      const paths: string[] = Array.isArray(args.paths) ? args.paths.map(String) : [];
      const dir = str(args, "dir", "directory");
      const resolved = new Set<string>();
      const add = (p: string) => {
        let r = p;
        if (r.startsWith("~")) r = path.join(os.homedir(), r.slice(1));
        if (!path.isAbsolute(r)) r = path.resolve(ctx.cwd, r);
        resolved.add(r);
      };
      paths.forEach(add);
      if (dir) {
        let d = dir;
        if (d.startsWith("~")) d = path.join(os.homedir(), d.slice(1));
        if (!path.isAbsolute(d)) d = path.resolve(ctx.cwd, d);
        try {
          for (const name of await fs.readdir(d)) {
            if (/\.(txt|md|markdown|csv|json|log|html?|tsx?|jsx?|py|java|go|rs|c|cpp|cs|rb)$/i.test(name)) add(path.join(d, name));
          }
        } catch {
          return `Could not read directory ${d}.`;
        }
      }
      if (!resolved.size) return "index_files needs `paths` and/or a `dir`.";
      if (!(await ctx.approve({ tool: "index_files", summary: `Index ${resolved.size} file(s) into memory` }))) return "Denied by user.";

      const store = await loadStore();
      let chunks = 0;
      for (const file of resolved) {
        let content: string;
        try {
          content = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        const parts = chunk(content);
        if (!parts.length) continue;
        const { vectors, method } = await embedTexts(ctx, store, parts);
        if (store.items.length === 0) store.method = method;
        parts.forEach((p, i) => {
          store.items.push({
            id: crypto.randomUUID(),
            text: p,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : ["file"],
            source: file,
            at: Date.now(),
            vector: vectors[i],
          });
        });
        chunks += parts.length;
      }
      await saveStore(store);
      return `Indexed ${resolved.size} file(s) into ${chunks} chunk(s). Memory now holds ${store.items.length} item(s).`;
    },

    memory_list: async (args) => {
      const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
      const store = await loadStore();
      if (!store.items.length) return "Memory is empty.";
      return store.items
        .slice()
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map((i) => `• [${i.id}] (${i.source}) ${i.text.slice(0, 100)}${i.text.length > 100 ? "…" : ""}`)
        .join("\n");
    },

    memory_forget: async (args, ctx) => {
      const store = await loadStore();
      if (args.all === true) {
        const n = store.items.length;
        if (!(await ctx.approve({ tool: "memory_forget", summary: `Clear all ${n} memory items` }))) return "Denied by user.";
        store.items = [];
        await saveStore(store);
        return `Cleared all ${n} memory item(s).`;
      }
      const id = str(args, "id");
      if (!id) return "memory_forget needs an `id` or all:true.";
      const before = store.items.length;
      store.items = store.items.filter((i) => i.id !== id);
      await saveStore(store);
      return before === store.items.length ? `No item with id ${id}.` : `Forgot item ${id}.`;
    },
  },
};
