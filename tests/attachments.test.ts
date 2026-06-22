import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  looksLikeText,
  decodeTextBuffer,
  formatBytes,
  buildAttachmentContext,
  extractAttachments,
  PER_FILE_CHARS,
  TOTAL_CHARS,
  type ExtractedAttachment,
} from "../electron/attachments";

// The attachments module turns dropped/picked files into plain text that gets
// folded into the user's turn. These tests cover the pure helpers plus the
// real fs-backed extraction for text, image, binary, and missing files.

describe("looksLikeText", () => {
  it("treats UTF-8 prose as text", () => {
    expect(looksLikeText(Buffer.from("Hello, world. Café ☕ résumé."))).toBe(true);
  });
  it("treats a buffer with NUL bytes as binary", () => {
    expect(looksLikeText(Buffer.from([0x48, 0x00, 0x49]))).toBe(false);
  });
  it("treats mostly-control-byte data as binary", () => {
    expect(looksLikeText(Buffer.from(Array.from({ length: 64 }, () => 0x01)))).toBe(false);
  });
  it("treats an empty buffer as text", () => {
    expect(looksLikeText(Buffer.alloc(0))).toBe(true);
  });
});

describe("decodeTextBuffer", () => {
  it("decodes utf-8 and reports not truncated for small input", () => {
    const { text, truncated } = decodeTextBuffer(Buffer.from("line one\nline two"));
    expect(text).toBe("line one\nline two");
    expect(truncated).toBe(false);
  });
  it("strips a leading BOM", () => {
    const { text } = decodeTextBuffer(Buffer.from("﻿hi"));
    expect(text).toBe("hi");
  });
  it("truncates at the per-file cap", () => {
    const big = "x".repeat(PER_FILE_CHARS + 5000);
    const { text, truncated } = decodeTextBuffer(Buffer.from(big));
    expect(truncated).toBe(true);
    expect(text.length).toBe(PER_FILE_CHARS);
  });
});

describe("formatBytes", () => {
  it("formats common sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("buildAttachmentContext", () => {
  const textItem = (over: Partial<ExtractedAttachment>): ExtractedAttachment => ({
    name: "a.txt",
    kind: "text",
    bytes: 100,
    text: "hello",
    truncated: false,
    ...over,
  });

  it("returns empty string for no items", () => {
    expect(buildAttachmentContext([])).toBe("");
  });

  it("wraps a single file with markers and a singular intro", () => {
    const ctx = buildAttachmentContext([textItem({ name: "notes.md", text: "remember this" })]);
    expect(ctx).toContain("The user attached 1 file");
    expect(ctx).toContain("----- FILE 1/1: notes.md");
    expect(ctx).toContain("remember this");
    expect(ctx).toContain("----- END FILE 1/1 -----");
  });

  it("uses a plural intro and numbers multiple files", () => {
    const ctx = buildAttachmentContext([
      textItem({ name: "one.txt" }),
      textItem({ name: "two.txt" }),
    ]);
    expect(ctx).toContain("The user attached 2 files");
    expect(ctx).toContain("FILE 1/2: one.txt");
    expect(ctx).toContain("FILE 2/2: two.txt");
  });

  it("renders the note for a file without text", () => {
    const ctx = buildAttachmentContext([
      textItem({ name: "pic.png", kind: "image", text: "", note: "Image file attached." }),
    ]);
    expect(ctx).toContain("[Image file attached.]");
  });

  it("enforces the whole-turn character budget across files", () => {
    const huge = "y".repeat(PER_FILE_CHARS);
    const items = Array.from({ length: 6 }, (_, i) =>
      textItem({ name: `f${i}.txt`, text: huge })
    );
    const ctx = buildAttachmentContext(items);
    // 6 * 60k would be 360k; the budget caps total injected file text near TOTAL_CHARS.
    expect(ctx.length).toBeLessThan(TOTAL_CHARS + 5000);
    expect(ctx).toContain("attachment budget");
  });
});

describe("extractAttachments (fs-backed)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lmb-attach-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("extracts text from a .txt file", async () => {
    const p = path.join(dir, "hello.txt");
    await fs.writeFile(p, "the secret code is 42");
    const [result] = await extractAttachments([{ path: p, name: "hello.txt" }]);
    expect(result.kind).toBe("text");
    expect(result.text).toContain("the secret code is 42");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("reads a file with an unknown extension if it sniffs as text", async () => {
    const p = path.join(dir, "data.weirdext");
    await fs.writeFile(p, "plain text body");
    const [result] = await extractAttachments([{ path: p }]);
    expect(result.kind).toBe("text");
    expect(result.text).toContain("plain text body");
  });

  it("flags images with a vision note and no text", async () => {
    const p = path.join(dir, "shot.png");
    await fs.writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const [result] = await extractAttachments([{ path: p }]);
    expect(result.kind).toBe("image");
    expect(result.text).toBe("");
    expect(result.note).toMatch(/vision-capable|can't read images/i);
  });

  it("notes binary files it can't turn into text", async () => {
    const p = path.join(dir, "blob.dat");
    await fs.writeFile(p, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]));
    const [result] = await extractAttachments([{ path: p }]);
    expect(result.text).toBe("");
    expect(result.note).toMatch(/binary/i);
  });

  it("notes a missing file instead of throwing", async () => {
    const [result] = await extractAttachments([{ path: path.join(dir, "nope.txt") }]);
    expect(result.text).toBe("");
    expect(result.note).toMatch(/could not read/i);
  });

  it("returns [] for no inputs", async () => {
    expect(await extractAttachments([])).toEqual([]);
  });
});
