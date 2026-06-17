using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Engine;

/// <summary>
/// The headless Jobomate engine's local HTTP API (loopback only). The merged Electron app spawns this
/// process and the React UI calls it with fetch(). Plain JSON over HTTP; permissive CORS for the
/// loopback renderer. One <see cref="JobomateEngine"/> singleton holds all state for the session.
/// </summary>
public static class EngineServer
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private const string TokenHeader = "X-Jobomate-Token";

    /// <summary>
    /// Per-session shared secret supplied by the Electron host via <c>JOBOMATE_ENGINE_TOKEN</c>.
    /// When set (always, in the packaged app) every request must present it in the
    /// <c>X-Jobomate-Token</c> header, which stops any web page the in-app browser visits from
    /// reaching this loopback API cross-origin. Empty in dev / direct CLI use, where the API stays
    /// open on loopback for convenience.
    /// </summary>
    private static string _authToken = "";

    public static void Run(int port)
    {
        _authToken = Environment.GetEnvironmentVariable("JOBOMATE_ENGINE_TOKEN") ?? "";
        var engine = new JobomateEngine();
        var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        Console.WriteLine($"[jobomate-engine] listening on http://127.0.0.1:{port}/ (auth: {(_authToken.Length > 0 ? "token" : "open")})");

        while (true)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch { break; }
            // Dispatch to the thread pool so a slow/blocking handler can never stall the accept loop.
            _ = Task.Run(() => HandleAsync(ctx, engine)).ContinueWith(t =>
            {
                if (t.Exception is not null) Console.Error.WriteLine("[engine] handler fault: " + t.Exception.GetBaseException());
            }, TaskContinuationOptions.OnlyOnFaulted);
        }
    }

    private static async Task HandleAsync(HttpListenerContext ctx, JobomateEngine engine)
    {
        var req = ctx.Request;
        var res = ctx.Response;
        // When a session token is required we do NOT advertise a wildcard CORS origin — there is no
        // legitimate cross-origin caller. The token itself is the real protection; this just avoids
        // telling a browser the response is cross-origin readable. In open (dev) mode keep it simple.
        if (_authToken.Length == 0)
            res.AddHeader("Access-Control-Allow-Origin", "*");
        res.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.AddHeader("Access-Control-Allow-Headers", "Content-Type, " + TokenHeader);

        if (req.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.Close(); return; }

        // Reject any request that doesn't carry the session token (constant-time compare).
        if (_authToken.Length > 0 && !TokenMatches(req.Headers[TokenHeader]))
        {
            Console.Error.WriteLine($"[engine] 401 {req.HttpMethod} {req.Url?.AbsolutePath} (missing/invalid token)");
            try { await WriteJsonAsync(res, 401, new { error = "unauthorized" }).ConfigureAwait(false); } catch { }
            return;
        }

        var path = (req.Url?.AbsolutePath ?? "/").TrimEnd('/');
        Console.Error.WriteLine($"[engine] {req.HttpMethod} {path}");
        try
        {
            var body = await ReadBodyAsync(req).ConfigureAwait(false);
            var result = await RouteAsync(path, req.HttpMethod, body, engine).ConfigureAwait(false);
            await WriteJsonAsync(res, 200, result).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[engine] route error: " + ex);
            try { await WriteJsonAsync(res, 500, new { error = ex.Message }).ConfigureAwait(false); } catch { }
        }
    }

    /// <summary>Constant-time comparison of the presented token against the session token.</summary>
    private static bool TokenMatches(string? presented) => TokensEqual(presented, _authToken);

    /// <summary>Constant-time string equality (no early-out on first mismatch). Empty/null never matches.</summary>
    internal static bool TokensEqual(string? presented, string expected)
    {
        if (string.IsNullOrEmpty(presented) || string.IsNullOrEmpty(expected)) return false;
        var a = Encoding.UTF8.GetBytes(presented);
        var b = Encoding.UTF8.GetBytes(expected);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(a, b);
    }

    private static async Task<object?> RouteAsync(string path, string method, JsonElement body, JobomateEngine e)
    {
        string S(string k) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        string[] Arr(string k) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToArray() : Array.Empty<string>();
        bool B(string k) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(k, out var v) && (v.ValueKind == JsonValueKind.True || (v.ValueKind == JsonValueKind.String && v.GetString() == "true"));
        // Nullable getters for partial updates: absent -> null (field left unchanged).
        string? SN(string k) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        bool? BN(string k) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(k, out var v) ? (v.ValueKind == JsonValueKind.True ? true : v.ValueKind == JsonValueKind.False ? false : (bool?)null) : null;

        switch (path)
        {
            case "/api/status": return e.Status();

            // ---- LLM config ----
            case "/api/llm/key": e.SetApiKey(S("provider"), S("key")); return e.Status();
            case "/api/llm/connect": return e.ConnectLlm(B("connect"));
            case "/api/llm/config":
                if (body.TryGetProperty("config", out var cfgEl))
                {
                    var cfg = cfgEl.Deserialize<LlmConnectionConfig>(Json);
                    if (cfg is not null) { if (string.IsNullOrEmpty(cfg.Id)) cfg.Id = "llm"; cfg.Connected = true; e.Services.SaveLlmConfig(cfg); }
                }
                return e.Status();

            // ---- chat ----
            case "/api/chat": return await e.ChatAsync(S("text")).ConfigureAwait(false);

            // ---- CV ----
            case "/api/cv": return await e.LoadCvAsync(S("path")).ConfigureAwait(false);

            // ---- research ----
            case "/api/research":
            {
                var urlArg = S("url");
                return await e.ResearchAsync(S("goal"), string.IsNullOrWhiteSpace(urlArg) ? null : urlArg, _ => { }).ConfigureAwait(false);
            }

            // ---- repos ----
            case "/api/jobs": return e.Jobs();
            case "/api/companies": return e.Companies();
            case "/api/drafts": return e.Drafts();

            // ---- repos (edit / delete / manage) ----
            case "/api/jobs/update": return e.UpdateJob(S("id"), SN("title"), SN("company"), SN("location"), SN("email"), SN("url"), BN("included"));
            case "/api/jobs/delete": return e.DeleteJob(S("id"));
            case "/api/jobs/delete-bulk": return e.DeleteJobs(Arr("ids"), B("all"));
            case "/api/companies/delete-bulk": return e.DeleteCompanies(Arr("ids"), B("all"));
            case "/api/drafts/update": return e.UpdateDraft(S("id"), SN("role"), SN("company"), SN("to"), SN("subject"), SN("body"), SN("status"), SN("coverLetter"));
            case "/api/drafts/delete": return e.DeleteDraft(S("id"));
            case "/api/drafts/delete-bulk": return e.DeleteDrafts(Arr("ids"), B("all"));

            // ---- chat threads ----
            case "/api/threads": return e.Threads();
            case "/api/thread/new": return e.NewThread();
            case "/api/thread/switch": return e.SwitchThread(S("id"));
            case "/api/thread/messages": return e.ThreadMessages();
            case "/api/thread/delete": return e.DeleteThreads(Arr("ids"));

            // ---- drafting / approval / send ----
            case "/api/draft": return await e.DraftAsync(S("kind"), Arr("ids")).ConfigureAwait(false);
            case "/api/approve": return e.Approve(Arr("ids"));
            case "/api/schedule": return e.Schedule();
            case "/api/send": return await e.SendDueAsync().ConfigureAwait(false);

            // ---- browser + email ----
            case "/api/browser/open": return await e.OpenBrowserAsync(S("url")).ConfigureAwait(false);
            case "/api/browser/status": return e.BrowserStatus();
            case "/api/browser/resume": return e.ResumeBrowser();
            case "/api/email/prepare": return await e.PrepareEmailsAsync().ConfigureAwait(false);
            case "/api/email/create-drafts": return await e.CreateGmailDraftsAsync().ConfigureAwait(false);

            // ---- job fit ----
            case "/api/jobs/score": return await e.ScoreJobFit(S("id")).ConfigureAwait(false);
            case "/api/jobs/score-all": return await e.ScoreAllJobs().ConfigureAwait(false);

            // ---- application tracker ----
            case "/api/tracker": return e.Tracker();
            case "/api/tracker/update": return e.UpdateTracker(S("id"), S("status"), SN("notes"));

            // ---- cost ledger ----
            case "/api/costs": return e.Costs();

            // ---- cover letter PDF ----
            case "/api/drafts/cover-letter-pdf": return await e.GenerateCoverLetterPdf(S("id")).ConfigureAwait(false);

            // ---- preferences ----
            case "/api/sites": e.SaveSites(Arr("sites")); return e.Status();
            case "/api/persona": e.SavePersona(S("persona")); return e.Status();
            case "/api/mode": return e.SetMode(S("mode"));

            default: return new { error = "unknown endpoint: " + path };
        }
    }

    private const long MaxBodyBytes = 32 * 1024 * 1024; // 32 MiB (CV uploads/base64 images stay well under)

    private static async Task<JsonElement> ReadBodyAsync(HttpListenerRequest req)
    {
        if (!req.HasEntityBody) return default;
        // Reject oversized bodies. The ContentLength64 check covers the honest case; the
        // byte-capped loop inside ReadBody ALSO catches streamed/chunked bodies that omit
        // Content-Length, so neither path can push us past the cap.
        if (req.ContentLength64 > MaxBodyBytes)
            throw new InvalidDataException($"Request body exceeds {MaxBodyBytes} bytes");
        return await ReadBody(req.InputStream, req.ContentEncoding ?? Encoding.UTF8, MaxBodyBytes).ConfigureAwait(false);
    }

    /// <summary>
    /// Reads at most <paramref name="maxBytes"/> from <paramref name="stream"/> and parses it as JSON.
    /// Exposed as internal so tests can drive the cap directly with a fake stream (HttpListenerRequest
    /// is not fakeable). Returns default(JsonElement) for empty/whitespace/unparseable bodies —
    /// matching the historical behavior of the route layer, which treats those as "no body".
    /// </summary>
    internal static async Task<JsonElement> ReadBody(Stream stream, Encoding encoding, long maxBytes)
    {
        var buffer = new byte[16 * 1024];
        using var ms = new MemoryStream();
        int n;
        while ((n = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
        {
            ms.Write(buffer, 0, n);
            if (ms.Length > maxBytes)
                throw new InvalidDataException($"Request body exceeds {maxBytes} bytes");
        }

        if (ms.Length == 0) return default;
        var text = encoding.GetString(ms.GetBuffer(), 0, (int)ms.Length);
        if (string.IsNullOrWhiteSpace(text)) return default;
        try { return JsonDocument.Parse(text).RootElement.Clone(); } catch { return default; }
    }

    private static async Task WriteJsonAsync(HttpListenerResponse res, int status, object? payload)
    {
        res.StatusCode = status;
        res.ContentType = "application/json";
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, Json));
        res.ContentLength64 = bytes.Length;
        try { await res.OutputStream.WriteAsync(bytes).ConfigureAwait(false); } catch { }
        finally { res.Close(); }
    }
}
