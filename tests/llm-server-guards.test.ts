import { describe, it, expect } from "vitest";
import {
  isHostAllowed,
  isOriginAllowed,
  tokenFromHeaders,
  tokenMatches,
} from "../electron/llm-server";

// These four functions ARE the security boundary of the browser-control server on :9222:
//   - isHostAllowed     → anti-DNS-rebinding (Host must be loopback)
//   - isOriginAllowed   → Origin allowlist (cross-origin requests blocked; absent Origin ok)
//   - tokenFromHeaders  → pulls the bearer token from Authorization or X-Jobomate-Bridge-Token
//   - tokenMatches      → constant-time compare so timing can't leak the token
// A regression in any of these would open the control API, so each is pinned here.

describe("isHostAllowed", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.1:9222",
    "localhost",
    "localhost:9222",
    "[::1]", // bracketed IPv6 loopback
    "[::1]:9222", // bracketed IPv6 loopback with port
  ])("accepts loopback Host %s", (host) => {
    expect(isHostAllowed(host)).toBe(true);
  });

  it.each([
    "example.com",
    "example.com:9222",
    "evil.attacker.dev", // a public hostname that resolves to 127.0.0.1 (DNS rebinding)
    "192.168.1.1", // RFC1918 is NOT loopback
    "10.0.0.1",
    "0.0.0.0",
    "::1", // bare (unbracketed) IPv6 — NOT accepted; see note below
    "",
    undefined,
  ])("rejects non-loopback / absent Host %s", (host) => {
    expect(isHostAllowed(host)).toBe(false);
  });

  // NOTE: a bare `::1` (no brackets) is mangled by the strip-port regex into `:` and rejected.
  // No real HTTP client sends `Host: ::1` without brackets (RFC 7230 §5.4 requires brackets for
  // IPv6 literals in Host), so this is not a live gap — flagged here so a future change is conscious.

  it("handles array-form header by checking the first entry", () => {
    expect(isHostAllowed(["127.0.0.1:9222", "evil.com"])).toBe(true);
    expect(isHostAllowed(["evil.com", "127.0.0.1:9222"])).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it.each([
    undefined, // non-browser client (curl) — no Origin header
    "",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ])("allows absent or loopback Origin %s", (origin) => {
    expect(isOriginAllowed(origin)).toBe(true);
  });

  it.each([
    "https://evil.attacker.dev", // cross-origin browser request
    "http://example.com",
    "http://192.168.1.1",
  ])("rejects cross-origin Origin %s", (origin) => {
    expect(isOriginAllowed(origin)).toBe(false);
  });

  // NOTE: two legacy quirks are pinned below so any future change is conscious. Both are low-impact
  // in this app's threat model (the token gate is the real protection; this is defense-in-depth):
  //   1. Node's URL keeps brackets in hostname (`[::1]`), so IPv6-loopback Origins are rejected.
  //   2. `new URL("file://")` parses successfully with hostname="", so the catch-branch fallback
  //      that would allow "file://" is never reached.
  it("rejects IPv6-loopback Origin (Node URL keeps brackets in hostname)", () => {
    expect(isOriginAllowed("http://[::1]:5173")).toBe(false);
  });

  it("rejects the bare file:// Origin (URL parse succeeds with empty hostname, masking the file:// fallback)", () => {
    expect(isOriginAllowed("file://")).toBe(false);
  });

  it("rejects malformed non-file Origins", () => {
    expect(isOriginAllowed("not-a-url :: garbage")).toBe(false);
  });
});

describe("tokenFromHeaders", () => {
  it("extracts a Bearer token from Authorization (case-insensitive scheme)", () => {
    expect(tokenFromHeaders({ authorization: "Bearer abc123" })).toBe("abc123");
    expect(tokenFromHeaders({ authorization: "bearer abc123" })).toBe("abc123");
  });

  it("trims whitespace around the Bearer token", () => {
    expect(tokenFromHeaders({ authorization: "Bearer   abc123   " })).toBe(
      "abc123",
    );
  });

  it("extracts from the custom X-Jobomate-Bridge-Token header", () => {
    expect(tokenFromHeaders({ "x-jobomate-bridge-token": "xyz789" })).toBe(
      "xyz789",
    );
  });

  it("prefers Authorization when both are present", () => {
    expect(
      tokenFromHeaders({
        authorization: "Bearer from-auth",
        "x-jobomate-bridge-token": "from-custom",
      }),
    ).toBe("from-auth");
  });

  it.each([
    [{}], // no auth headers
    [{ authorization: "Basic abc123" }], // non-Bearer scheme
    [{ authorization: "" }], // empty Authorization
    [{ "x-jobomate-bridge-token": "   " }], // whitespace-only custom header
  ])("returns null when no well-formed token is present: %j", (headers) => {
    expect(tokenFromHeaders(headers)).toBeNull();
  });
});

describe("tokenMatches", () => {
  it("returns true for an exact match", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
  });

  it.each([
    ["wrong", "secret"],
    ["", "secret"], // empty provided
    [null, "secret"], // null provided
    [undefined, "secret"], // undefined provided
  ])(
    "returns false when provided does not match: %s vs secret",
    (provided, expected) => {
      expect(tokenMatches(provided as string | null, expected)).toBe(false);
    },
  );

  it("returns false on length mismatch without throwing (timing-safe compare requires equal length)", () => {
    expect(tokenMatches("a", "ab")).toBe(false);
    expect(tokenMatches("longer-string", "short")).toBe(false);
  });

  it("does not error when buffers legitimately differ in content but match in length", () => {
    expect(tokenMatches("abcdef", "abcdeg")).toBe(false);
    expect(tokenMatches("abcdef", "abcdef")).toBe(true);
  });
});
