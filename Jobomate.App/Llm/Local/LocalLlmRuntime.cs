using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Persistence;

namespace Jobomate.Llm.Local;

public sealed record LocalModelOption(string Id, string Source, string LocalPath = "");

public sealed record LocalRuntimeStatus(
    bool OllamaReachable,
    bool LmStudioReachable,
    IReadOnlyList<LocalModelOption> Models,
    IReadOnlyList<string> GgufFiles);

/// <summary>
/// Detects local OpenAI-compatible runtimes and on-disk GGUF models. Modeled on
/// MultiAgentOS's LocalLlmRuntimeIntegration but decoupled from the god-object.
/// All decision helpers (<see cref="NormalizeServerUrl"/>, <see cref="ValidateGgufPath"/>)
/// are pure and unit-tested.
/// </summary>
public sealed class LocalLlmRuntime
{
    public const string OllamaBase = "http://127.0.0.1:11434";
    public const string OllamaTags = OllamaBase + "/api/tags";
    public const string OllamaChat = OllamaBase + "/v1/chat/completions";
    public const string LmStudioBase = "http://127.0.0.1:1234";
    public const string LmStudioModels = LmStudioBase + "/v1/models";
    public const string LmStudioChat = LmStudioBase + "/v1/chat/completions";

    private readonly HttpClient _http;

    public LocalLlmRuntime(HttpClient? http = null)
    {
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    }

    /// <summary>
    /// Normalize any user-typed local endpoint to a full OpenAI-compatible
    /// chat-completions URL. Handles bare host:port, "/v1", trailing slashes,
    /// and already-complete URLs idempotently.
    /// </summary>
    public static string NormalizeServerUrl(string? url)
    {
        var u = (url ?? "").Trim();
        if (u.Length == 0) return LmStudioChat;
        if (!u.Contains("://", StringComparison.Ordinal)) u = "http://" + u;
        u = u.TrimEnd('/');

        if (u.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)) return u;
        if (u.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) return u + "/chat/completions";
        if (u.EndsWith("/completions", StringComparison.OrdinalIgnoreCase)) return u;
        return u + "/v1/chat/completions";
    }

    public static (bool Ok, string Message) ValidateGgufPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return (false, "No GGUF model selected.");
        if (!path!.EndsWith(".gguf", StringComparison.OrdinalIgnoreCase)) return (false, "Selected file is not a .gguf model.");
        if (!File.Exists(path)) return (false, "GGUF file not found: " + path);
        return (true, "OK");
    }

    public static string SuggestModelName(string? path)
    {
        var name = Path.GetFileNameWithoutExtension(path ?? "");
        return string.IsNullOrWhiteSpace(name) ? "local-gguf" : name;
    }

    public async Task<bool> IsReachableAsync(string url, CancellationToken ct = default)
    {
        try
        {
            using var resp = await _http.GetAsync(url, ct).ConfigureAwait(false);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<IReadOnlyList<LocalModelOption>> ListOllamaModelsAsync(CancellationToken ct = default)
    {
        var list = new List<LocalModelOption>();
        try
        {
            using var resp = await _http.GetAsync(OllamaTags, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return list;
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
            if (doc.RootElement.TryGetProperty("models", out var models) && models.ValueKind == JsonValueKind.Array)
            {
                foreach (var m in models.EnumerateArray())
                {
                    if (m.TryGetProperty("name", out var n) && n.GetString() is { } id)
                        list.Add(new LocalModelOption(id, "Ollama"));
                }
            }
        }
        catch { /* runtime offline */ }
        return list;
    }

    public async Task<IReadOnlyList<LocalModelOption>> ListOpenAiCompatibleModelsAsync(
        string modelsUrl, string source, CancellationToken ct = default)
    {
        var list = new List<LocalModelOption>();
        try
        {
            using var resp = await _http.GetAsync(modelsUrl, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return list;
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
            if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
            {
                foreach (var m in data.EnumerateArray())
                {
                    if (m.TryGetProperty("id", out var n) && n.GetString() is { } id)
                        list.Add(new LocalModelOption(id, source));
                }
            }
        }
        catch { /* runtime offline */ }
        return list;
    }

    public async Task<LocalRuntimeStatus> DetectAsync(CancellationToken ct = default)
    {
        var ollamaUp = await IsReachableAsync(OllamaTags, ct).ConfigureAwait(false);
        var lmUp = await IsReachableAsync(LmStudioModels, ct).ConfigureAwait(false);

        var models = new List<LocalModelOption>();
        if (ollamaUp) models.AddRange(await ListOllamaModelsAsync(ct).ConfigureAwait(false));
        if (lmUp) models.AddRange(await ListOpenAiCompatibleModelsAsync(LmStudioModels, "LM Studio", ct).ConfigureAwait(false));
        models.AddRange(await ListLmStudioCliModelsAsync(ct).ConfigureAwait(false)); // downloaded-but-unloaded
        models = models.GroupBy(m => m.Id).Select(g => g.First()).ToList();

        var gguf = FindLocalGgufModels().Concat(ListManagedGgufModels()).Distinct().ToList();
        return new LocalRuntimeStatus(ollamaUp, lmUp, models, gguf);
    }

    /// <summary>Downloaded LM Studio models via the `lms` CLI (best-effort; empty if lms isn't installed).</summary>
    public async Task<IReadOnlyList<LocalModelOption>> ListLmStudioCliModelsAsync(CancellationToken ct = default)
    {
        var list = new List<LocalModelOption>();
        try
        {
            var psi = new ProcessStartInfo("lms") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            psi.ArgumentList.Add("ls");
            using var proc = Process.Start(psi);
            if (proc is null) return list;
            var output = await proc.StandardOutput.ReadToEndAsync(ct).ConfigureAwait(false);
            await proc.WaitForExitAsync(ct).ConfigureAwait(false);
            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var id = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
                // Model identifiers look like "publisher/model"; skip header/summary lines.
                if (!string.IsNullOrWhiteSpace(id) && id!.Contains('/') && !id.Contains(':'))
                    list.Add(new LocalModelOption(id, "LM Studio (cli)"));
            }
        }
        catch { /* lms not installed / not on PATH */ }
        return list;
    }

    // ----- managed GGUF store -----

    /// <summary>App-managed folder for GGUF models the user has imported.</summary>
    public static string ManagedModelsDir => JobomatePaths.EnsureDir(Path.Combine(JobomatePaths.DataDir, "models"));

    /// <summary>Copy a .gguf into the managed store and return the stored path.</summary>
    public static string ImportGgufToStore(string sourcePath)
    {
        var dest = Path.Combine(ManagedModelsDir, Path.GetFileName(sourcePath));
        File.Copy(sourcePath, dest, overwrite: true);
        return dest;
    }

    public static IReadOnlyList<string> ListManagedGgufModels() =>
        Directory.Exists(ManagedModelsDir) ? Directory.GetFiles(ManagedModelsDir, "*.gguf") : Array.Empty<string>();

    /// <summary>Bounded filesystem scan of the usual model folders for *.gguf files.</summary>
    public IReadOnlyList<string> FindLocalGgufModels(int max = 64, int budgetMs = 4000)
    {
        var results = new List<string>();
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var roots = new[]
        {
            Path.Combine(home, "Downloads"),
            Path.Combine(home, "Documents"),
            Path.Combine(home, "Models"),
            Path.Combine(home, ".lmstudio", "models"),
            Path.Combine(home, ".ollama", "models"),
            Path.Combine(home, ".cache", "lm-studio", "models"),
            Path.Combine(home, "Library", "Application Support", "Jobomate", "models"),
        };

        var deadline = DateTime.UtcNow.AddMilliseconds(budgetMs);
        foreach (var root in roots)
        {
            if (results.Count >= max || DateTime.UtcNow > deadline) break;
            if (!Directory.Exists(root)) continue;
            foreach (var f in SafeEnumerate(root, "*.gguf", deadline))
            {
                results.Add(f);
                if (results.Count >= max) break;
            }
        }
        return results.Distinct().ToList();
    }

    private static IEnumerable<string> SafeEnumerate(string root, string pattern, DateTime deadline)
    {
        var queue = new Queue<string>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            if (DateTime.UtcNow > deadline) yield break;
            var dir = queue.Dequeue();

            string[] files = Array.Empty<string>();
            try { files = Directory.GetFiles(dir, pattern); } catch { }
            foreach (var f in files) yield return f;

            string[] subs = Array.Empty<string>();
            try { subs = Directory.GetDirectories(dir); } catch { }
            foreach (var s in subs) queue.Enqueue(s);
        }
    }
}
