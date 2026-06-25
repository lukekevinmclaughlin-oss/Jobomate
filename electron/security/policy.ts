// Security policy module for MAOS. Pure, side-effect-free helpers that enforce
// trust-boundary rules at IPC and Electron event boundaries. Kept separate from
// electron/main.ts so each policy is independently unit-testable and auditable.
//
// Everything here must be defensive and deterministic: the main process is the
// last line of defense against a compromised renderer, so a policy decision must
// never depend on renderer-supplied data being well-formed.

import * as path from "node:path";

// ---------------------------------------------------------------------------
// will-attach-webview policy (#2)
// ---------------------------------------------------------------------------
//
// Electron fires `will-attach-webview` on the host webContents right before a
// <webview> element attaches its own webContents. A malicious page that got code
// execution in the renderer could craft a <webview> with nodeIntegration, a
// custom preload, or dangerous blink features. We strip those unconditionally
// and reject anything that is not an http(s) URL in the sandbox partition.
//
// Signature mirrors Electron's WillAttachWebviewEvent for direct wiring.

export interface WebviewAttachParams {
  /** The raw `src` attribute of the attaching <webview>. */
  url: string;
  /**
   * The webPreferences object Electron is about to apply. Mutated in place.
   * Typed loosely so this module stays decoupled from the Electron type tree
   * (and stays unit-testable without importing Electron).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webPreferences: any;
}

export interface WebviewAttachDecision {
  /** False => the attach must be prevented. */
  allow: boolean;
  /** Reason for denial (logged + surfaced via event.preventDefault). */
  reason?: string;
}

/** The only partition the sandbox <webview> is allowed to use. */
export const SANDBOX_PARTITION = "persist:maos-sandbox";

/**
 * Inspect + harden a <webview> attach attempt in place. Returns whether the
 * attach may proceed. Even when allowed, dangerous webPreferences are stripped.
 */
export function decideWebviewAttach(
  params: WebviewAttachParams,
): WebviewAttachDecision {
  const { url, webPreferences } = params;

  // Force nodeIntegration / contextIsolation / sandbox off the table. The
  // sandbox <webview> is meant to render untrusted web content only — it must
  // never get Node APIs regardless of what the renderer asked for.
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.enableRemoteModule = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webviewTag = false;
  // Strip any caller-supplied preload — only our explicitly-built preload is
  // trusted, and the sandbox <webview> intentionally has none.
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  delete webPreferences.enableBlinkFeatures;

  // Reject anything that is not http(s). file:/data:/blob:/about: URLs in a
  // sandboxed webview are a common escalation primitive (e.g. file: → read
  // local files into the webview, then exfiltrate via the partition session).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      allow: false,
      reason: `webview src is not a valid URL: ${url.slice(0, 120)}`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      allow: false,
      reason: `webview src must be http(s), got ${parsed.protocol}`,
    };
  }

  return { allow: true };
}

// ---------------------------------------------------------------------------
// openExternal URL policy (#3)
// ---------------------------------------------------------------------------

/** Validate a URL before passing it to electron.shell.openExternal. */
export function decideOpenExternalUrl(rawUrl: string): {
  ok: boolean;
  reason?: string;
  url?: URL;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme: ${parsed.protocol}` };
  }
  // Reject embedded credentials — openExternal hands the URL to the OS handler
  // and userinfo can be used to confuse gullible parsers.
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "userinfo/credentials in URL are not allowed" };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: "URL has no hostname" };
  }
  return { ok: true, url: parsed };
}

// ---------------------------------------------------------------------------
// fs:openExternal extension policy (#4)
// ---------------------------------------------------------------------------

/**
 * File extensions that the OS will execute / interpret when `openPath` is
 * called on them. The file browser sidecar may legitimately open documents
 * and media, but never binaries/scripts/launch agents — that would let a
 * compromised renderer execute arbitrary code via the OS handler.
 */
const DANGEROUS_EXTENSIONS = new Set([
  // Scripts
  ".sh",
  ".bash",
  ".zsh",
  ".csh",
  ".ksh",
  ".fish",
  ".command",
  ".tool",
  ".scpt",
  ".applescript",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".wsf",
  ".msi",
  // macOS app/launch artifacts
  ".app",
  ".action",
  ".workflow",
  ".definition",
  // Windows executables
  ".exe",
  ".com",
  ".scr",
  ".jar",
  // Shared libraries / loadable bundles
  ".dylib",
  ".so",
  ".dll",
  // Shell/rc files that some handlers will source
  ".profile",
  ".bashrc",
  ".zshrc",
  // Desktop launchers (Linux)
  ".desktop",
  // Compiled
  ".pyc",
  ".pyo",
]);

/**
 * Decide whether `shell.openPath` may be called on the given path. Returns
 * ok=false for known-executable extensions; otherwise ok=true (the path's
 * existence is the caller's responsibility).
 */
export function decideOpenPath(filePath: string): {
  ok: boolean;
  reason?: string;
} {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && DANGEROUS_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: `refusing to open executable file type: ${ext}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// fs:* sensitive-path policy (#6)
// ---------------------------------------------------------------------------

/**
 * Path fragments (case-insensitive, forward-or-backslash separated) that mark a
 * location as sensitive. A compromised renderer should never be able to read
 * `~/.ssh/id_rsa` or `~/Library/Keychains/*` through the fs:* IPC surface, so
 * any path that resolves into one of these roots is rejected at the boundary.
 *
 * Deliberately conservative: this is a deny-list, not an allow-list, so it only
 * blocks the well-known high-value targets. Normal document/download dirs are
 * unaffected.
 */
const SENSITIVE_PATH_FRAGMENTS: readonly RegExp[] = (() => {
  const frags = [
    // SSH / GPG / AWS / GCP / Azure / Docker / k8s creds
    ".ssh",
    ".gnupg",
    ".aws",
    ".config/gcloud",
    ".azure",
    ".docker",
    ".kube",
    // macOS keychain + secrets
    "Library/Keychains",
    "Library/Application Support/Google/Chrome/Default/Login Data",
    // Crypto wallets (common location)
    "Library/Application Support/Ethereum",
    // Password-store
    ".password-store",
    // Mozilla profile logins
    ".mozilla/firefox",
    ".thunderbird",
    // MAOS itself — its own settings file holds the (encrypted) API key
    "Library/Application Support/MAOS/llm-connection.json",
  ];
  // Match as path segments so "Library/Keychains" doesn't hit "Library/KeychainsFoo".
  // Anchored to a path separator (or string start) on both sides.
  return frags.map(
    (f) =>
      new RegExp(
        "(?:^|[\\\\/])" + f.replace(/[\\/]/g, "[\\\\/]") + "(?:[\\\\/]|$)",
        "i",
      ),
  );
})();

/**
 * True if the path points into a known sensitive location (credentials,
 * keychains, etc.). Used to reject fs:read / fs:readBinary / fs:write on those
 * paths even though the rest of the file browser remains open.
 */
export function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = path.normalize(filePath);
  for (const re of SENSITIVE_PATH_FRAGMENTS) {
    if (re.test(normalized)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// SSRF guard for web_fetch (#9)
// ---------------------------------------------------------------------------

/**
 * Resolve a hostname to its resolved IPs (best-effort) so we can refuse to
 * fetch private/loopback/link-local addresses. Returns an empty array if the
 * lookup fails — callers decide how to treat that (we fail closed).
 *
 * Uses Node's `dns.lookup` (which respects /etc/hosts and the system resolver)
 * with `all: true` so we see every resolved address, not just the first.
 */
export async function resolveHostIps(hostname: string): Promise<string[]> {
  if (!hostname) return [];
  // Avoid importing `dns` at module top so this file stays importable in tests
  // that run without a real resolver (the function is stubbed where needed).
  const dns = await import("node:dns/promises");
  try {
    const result = await dns.lookup(hostname, { all: true });
    return result.map((r) => r.address);
  } catch {
    return [];
  }
}

/**
 * True if the IP literal is private/loopback/link-local/multicast/etc. — i.e.
 * the kind of address a server-side request should never touch unless the user
 * has explicitly opted in. Mirrors the spirit of `ipaddress.is_private` in
 * Python's stdlib.
 */
export function isPrivateIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (!v) return false;

  // IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
    const parts = v.split(".").map((p) => Number(p));
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
      return false;
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
  }

  // IPv6 (strip zone id, normalize)
  let v6 = v.replace(/%.*$/, "");
  if (v6.startsWith("[") && v6.endsWith("]")) v6 = v6.slice(1, -1);

  // Common loopback/private IPv6 forms before full expansion.
  if (v6 === "::1" || v6 === "::") return true;
  if (v6 === "fe80::" || /^fe80[:%]/i.test(v6)) return true; // link-local
  if (/^fc[0-9a-f]{2}:/i.test(v6) || /^fd[0-9a-f]{2}:/i.test(v6)) return true; // ULA fc00::/7
  if (/^ff[0-9a-f]{2}:/i.test(v6)) return true; // multicast
  if (/^64:ff9b::/i.test(v6)) return true; // NAT64 well-known prefix
  if (/^::ffff:/i.test(v6)) {
    // IPv4-mapped IPv6 — recurse on the embedded v4.
    const tail = v6.slice("::ffff:".length);
    return isPrivateIp(tail);
  }
  return false;
}

/** True iff MAOS_ALLOW_LOCAL_FETCH=1 (the explicit SSRF opt-in env var). */
export function localFetchAllowed(): boolean {
  return process.env.MAOS_ALLOW_LOCAL_FETCH === "1";
}

export interface SsrfDecision {
  /** False => the fetch must be refused. */
  allow: boolean;
  reason?: string;
}

/**
 * Decide whether web_fetch may proceed to a URL. Blocks private/loopback IPs
 * unless the user has opted in via MAOS_ALLOW_LOCAL_FETCH=1 (e.g. for local
 * Ollama/LM Studio). DNS resolution is best-effort; if it fails entirely we
 * fail open (the OS will reject the connection shortly anyway), but a hostname
 * that resolves to ANY private IP is blocked.
 */
export async function decideWebFetchUrl(rawUrl: string): Promise<SsrfDecision> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allow: false, reason: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allow: false, reason: `unsupported scheme: ${parsed.protocol}` };
  }

  if (localFetchAllowed()) return { allow: true };

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  // Literal IP in the URL — check directly.
  if (isPrivateIp(host)) {
    return {
      allow: false,
      reason: `refusing to fetch private/loopback IP ${host}`,
    };
  }
  // Hostname — resolve and refuse if any resolved address is private.
  const ips = await resolveHostIps(host);
  if (ips.length === 0) {
    // Could not resolve: fail open; the OS will refuse the connect if bogus.
    return { allow: true };
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      return {
        allow: false,
        reason: `refusing to fetch ${host} (resolves to private IP ${ip})`,
      };
    }
  }
  return { allow: true };
}
