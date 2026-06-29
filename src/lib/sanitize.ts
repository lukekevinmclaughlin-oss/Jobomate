// Reasoning models (GLM, DeepSeek, Qwen "thinking", etc.) emit their internal
// chain of thought inline as <think>…</think>. The engine already strips this,
// but we also clean it at render time as a belt-and-suspenders guard so the tags
// and the rambling can never leak into a chat bubble — including any partial tag
// left at the end of a live stream.
export function stripReasoning(text: string): string {
  if (!text || text.indexOf("<") === -1) return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = out.toLowerCase().lastIndexOf("<think>");
  if (open !== -1) {
    const closed = out.toLowerCase().indexOf("</think>", open);
    if (closed === -1) out = out.slice(0, open);
  }
  out = out.replace(/<\/?think>/gi, "");
  // Drop a trailing partial tag that is a prefix of <think> / </think>.
  out = out.replace(/<\/?(?:t|th|thi|thin|think)?$/i, "");
  return out.replace(/^\s+/, "");
}

// Turn a raw thrown error into something a non-technical user can act on. Hides
// Electron IPC plumbing ("Error invoking remote method 'assistant:send':") and
// renderer-internals advice, and maps known transient failures to plain English.
export function friendlyError(raw: unknown): string {
  const msg = (raw instanceof Error ? raw.message : String(raw ?? "")).trim();
  const lower = msg.toLowerCase();
  if (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("etimedout") ||
    lower.includes("socket hang") ||
    lower.includes("timeout")
  ) {
    return "I couldn't reach the model just now — looks like a brief connection hiccup. Please press Run to try again.";
  }
  if (lower.includes("script failed to execute") || lower.includes("renderer")) {
    return "That step hit a snag on the page (it may have navigated or changed while I was working). Press Run to try again, or rephrase the request.";
  }
  // Strip the IPC wrapper so at worst the user sees the real message, not plumbing.
  const cleaned = msg
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^(TypeError|Error):\s*/i, "");
  return cleaned || "Something went wrong while running that task. Please press Run to try again.";
}

// Heuristic: is this failure worth one automatic retry? Transient network/page
// errors are; deliberate user stops and hard API errors are not.
export function isTransient(raw: unknown): boolean {
  const lower = (raw instanceof Error ? raw.message : String(raw ?? "")).toLowerCase();
  if (lower.includes("abort") || lower.includes("cancel") || lower.includes("stopped")) return false;
  return (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("etimedout") ||
    lower.includes("socket hang") ||
    lower.includes("script failed to execute")
  );
}
