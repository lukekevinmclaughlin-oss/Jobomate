using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace Jobomate.Llm.Local;

/// <summary>
/// Launches the self-contained bundled llama.cpp server (<c>gguf-runtime</c> +
/// its adjacent ggml/llama dylibs) that ships with the app, serving a GGUF on a
/// loopback port. This is the zero-setup local runtime — it needs no Ollama or
/// other install — consumed through the LLM gateway's OpenAI-compatible adapter
/// at <see cref="ChatEndpoint"/>.
///
/// Used by BOTH the prepackaged "Multiagent" default model and the "Local AI"
/// connection (the user's own GGUF). Process-wide singleton: one server runs at
/// a time; requesting a different model restarts it on that model. Killed on
/// process exit.
/// </summary>
public static class BundledLlamaServer
{
    private static readonly object Gate = new();
    // BUG-0024: serialize the full ensure path (health probe + stop + spawn) so concurrent
    // Multiagent <-> Local AI switches cannot orphan a second llama-server.
    private static readonly SemaphoreSlim EnsureGate = new(1, 1);
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private static Process? _process;
    private static string? _baseUrl;
    private static string? _modelPath;

    static BundledLlamaServer()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Stop();
    }

    /// <summary>The OpenAI-compatible chat endpoint once the server is running, else null.</summary>
    public static string? ChatEndpoint =>
        _baseUrl is null ? null : _baseUrl.TrimEnd('/') + "/v1/chat/completions";

    /// <summary>True if the bundled runtime binary is present and can be launched.</summary>
    public static bool IsAvailable => FindRuntimeBinary() is not null;

    /// <summary>
    /// Ensures the bundled server is running and serving <paramref name="modelPath"/>
    /// under the OpenAI model name <paramref name="alias"/>, returning the chat
    /// endpoint, or null if the runtime binary or model is missing. If a different
    /// model is already running it is stopped and relaunched on the new one.
    /// </summary>
    public static async Task<string?> EnsureRunningAsync(string modelPath, int contextSize, CancellationToken ct, string alias = "Multiagent", string? mmprojPath = null)
    {
        if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath)) return null;
        var binary = FindRuntimeBinary();
        if (binary is null) return null;

        // All-in-one (vision + text) models load a multimodal projector alongside the weights. Use an
        // explicit projector if given, else auto-detect a sibling "*mmproj*.gguf" of the SAME model
        // family next to the model (e.g. gemma-3-27b-it + gemma-3-27b-it-mmproj-f16). A non-vision
        // model with no matching projector simply runs text-only.
        var projector = !string.IsNullOrWhiteSpace(mmprojPath) && File.Exists(mmprojPath)
            ? mmprojPath
            : FindSidecarMmproj(modelPath);

        await EnsureGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            string? existingUrl;
            string? existingModel;
            lock (Gate)
            {
                existingUrl = _baseUrl;
                existingModel = _modelPath;
            }

            if (existingUrl is not null && string.Equals(existingModel, modelPath, StringComparison.Ordinal)
                && await IsHealthyAsync(existingUrl, ct).ConfigureAwait(false))
                return ChatEndpoint;

            if (existingUrl is not null && !string.Equals(existingModel, modelPath, StringComparison.Ordinal))
                Stop();

            string baseUrl;
            Process proc;
            lock (Gate)
            {
                if (_baseUrl is not null && _process is { HasExited: false }
                    && string.Equals(_modelPath, modelPath, StringComparison.Ordinal))
                    return ChatEndpoint;

            var port = ReserveLoopbackPort();
            baseUrl = $"http://127.0.0.1:{port}";
            var psi = new ProcessStartInfo(binary)
            {
                WorkingDirectory = Path.GetDirectoryName(binary)!,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.ArgumentList.Add("--model"); psi.ArgumentList.Add(ToRuntimeSafePath(modelPath));
            if (projector is not null)
            {
                psi.ArgumentList.Add("--mmproj"); psi.ArgumentList.Add(ToRuntimeSafePath(projector));
            }
            psi.ArgumentList.Add("--alias"); psi.ArgumentList.Add(string.IsNullOrWhiteSpace(alias) ? "Multiagent" : alias);
            psi.ArgumentList.Add("--host"); psi.ArgumentList.Add("127.0.0.1");
            psi.ArgumentList.Add("--port"); psi.ArgumentList.Add(port.ToString());
            psi.ArgumentList.Add("-c"); psi.ArgumentList.Add(Math.Max(1024, contextSize).ToString());
            psi.ArgumentList.Add("-ngl"); psi.ArgumentList.Add("999"); // offload every layer to the GPU where available (Metal / CUDA)
            psi.ArgumentList.Add("--parallel"); psi.ArgumentList.Add("1");

            // Cross-architecture CPU/GPU efficiency. The bundled runtime ships per OS/arch
            // (arm64 + Metal on Apple Silicon, x86-64 + AVX on Intel/AMD, arm64 + NEON
            // elsewhere); these flags get the most out of whichever it is:
            //   -fa on     flash attention — large prompt-eval win on Metal/CUDA, safe on CPU.
            //   --threads  match CPU workers to PHYSICAL cores (Apple P-cores; logical/2 on
            //              x86-64 where SMT exposes 2 threads/core; n-1 on other ARM). Extra
            //              threads only add contention + heat, never throughput.
            //   --mlock    Apple Silicon only: pin weights in unified memory so they are
            //              never swapped/compressed back through the CPU.
            psi.ArgumentList.Add("-fa"); psi.ArgumentList.Add("on");
            psi.ArgumentList.Add("--threads"); psi.ArgumentList.Add(OptimalThreadCount().ToString());
            if (IsAppleSilicon)
                psi.ArgumentList.Add("--mlock");

            proc = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start bundled llama-server.");
            // Drain stdio so the pipe buffers never fill and stall the child.
            proc.OutputDataReceived += static (_, _) => { };
            proc.ErrorDataReceived += static (_, _) => { };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            _process = proc;
            _baseUrl = baseUrl;
            _modelPath = modelPath;
            }

            // First load reads the model from disk; allow generous time (large GGUFs).
            var deadline = DateTimeOffset.UtcNow.AddSeconds(120);
            while (DateTimeOffset.UtcNow < deadline)
            {
                ct.ThrowIfCancellationRequested();
                if (proc.HasExited)
                {
                    lock (Gate) { if (ReferenceEquals(_process, proc)) { _process = null; _baseUrl = null; _modelPath = null; } }
                    try { proc.Dispose(); } catch { /* best effort */ }
                    return null;
                }
                if (await IsHealthyAsync(baseUrl, ct).ConfigureAwait(false)) return ChatEndpoint;
                await Task.Delay(500, ct).ConfigureAwait(false);
            }
            try { if (!proc.HasExited) proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
            lock (Gate) { if (ReferenceEquals(_process, proc)) { _process = null; _baseUrl = null; _modelPath = null; } }
            try { proc.Dispose(); } catch { /* best effort */ }
            return null;
        }
        finally
        {
            EnsureGate.Release();
        }
    }

    public static void Stop()
    {
        lock (Gate)
        {
            try { if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true); }
            catch { /* best effort */ }
            try { _process?.Dispose(); } catch { /* best effort */ } // release OS/pipe handles
            _process = null;
            _baseUrl = null;
            _modelPath = null;
        }
    }

    private static async Task<bool> IsHealthyAsync(string baseUrl, CancellationToken ct)
    {
        try
        {
            using var resp = await Http.GetAsync(baseUrl.TrimEnd('/') + "/health", ct);
            if (!resp.IsSuccessStatusCode) return false;
            var body = await resp.Content.ReadAsStringAsync(ct);
            return body.Contains("\"status\":\"ok\"", StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static int ReserveLoopbackPort()
    {
        var listener = new TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    /// <summary>True on Apple Silicon (arm64 macOS), where Metal offload + the
    /// performance/efficiency core split make the extra launch flags worthwhile.</summary>
    private static bool IsAppleSilicon =>
        RuntimeInformation.IsOSPlatform(OSPlatform.OSX) &&
        RuntimeInformation.OSArchitecture == Architecture.Arm64;

    /// <summary>
    /// Optimal llama.cpp CPU worker-thread count for this machine's architecture:
    /// Apple Silicon P-cores; logical/2 on x86-64/AMD (SMT exposes ~2 threads/core, but
    /// CPU inference peaks at physical cores); n-1 on other ARM. Extra threads only add
    /// contention + heat.
    /// </summary>
    private static int OptimalThreadCount()
    {
        if (IsAppleSilicon) return ApplePerformanceCoreCount();
        var logical = Math.Max(1, Environment.ProcessorCount);
        var arch = RuntimeInformation.ProcessArchitecture;
        if (arch is Architecture.X64 or Architecture.X86)
            return Math.Max(1, logical / 2);  // x86/x64 (Intel/AMD): SMT → ~2 logical per core
        return Math.Max(1, logical - 1);      // other ARM (Win-on-ARM / Linux ARM): no SMT
    }

    /// <summary>
    /// Number of high-performance (P) cores on this Apple Silicon machine, via
    /// <c>sysctl hw.perflevel0.physicalcpu</c> (8 on an M1 Max). Used to cap the
    /// runtime's CPU worker threads to the P-cores so inference never spills onto
    /// the slower efficiency cores. Falls back to a safe estimate on any failure.
    /// </summary>
    private static int ApplePerformanceCoreCount()
    {
        try
        {
            var psi = new ProcessStartInfo("/usr/sbin/sysctl", "-n hw.perflevel0.physicalcpu")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            if (p is not null)
            {
                var outp = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(1000);
                if (int.TryParse(outp, out var cores) && cores > 0)
                    return cores;
            }
        }
        catch { /* fall through to estimate */ }
        // Conservative fallback: leave 2 cores for the app/UI, but use at least 4.
        return Math.Max(4, Environment.ProcessorCount - 2);
    }

    /// <summary>
    /// Locates the bundled llama.cpp server: the standard shipping layout is an
    /// unmodified llama.cpp release inside a <c>gguf-runtime</c> folder (the
    /// server exe plus its adjacent ggml/llama libraries), found alongside the
    /// app, in a sibling <c>Resources/</c> folder, or up the tree (dev/repo
    /// layout). A legacy single renamed <c>gguf-runtime[.exe]</c> binary is also
    /// honoured for forward/back compatibility.
    /// </summary>
    public static string? FindRuntimeBinary()
    {
        var win = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        // What actually ships in the package: the llama.cpp server executable
        // living inside a folder literally named "gguf-runtime", next to the
        // ggml*/llama* libraries it loads from its own directory.
        var server = win ? "llama-server.exe" : "llama-server";
        // Legacy layout: a single standalone binary renamed to "gguf-runtime".
        var legacy = win ? "gguf-runtime.exe" : "gguf-runtime";
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; dir is not null && i < 8; i++, dir = dir.Parent)
        {
            foreach (var candidate in new[]
            {
                // Canonical: server exe inside a "gguf-runtime" folder.
                Path.Combine(dir.FullName, "gguf-runtime", server),
                Path.Combine(dir.FullName, "Resources", "gguf-runtime", server),
                Path.Combine(dir.FullName, "Contents", "Resources", "gguf-runtime", server),
                // Legacy single renamed binary.
                Path.Combine(dir.FullName, legacy),
                Path.Combine(dir.FullName, "Resources", legacy),
                Path.Combine(dir.FullName, "Contents", "Resources", legacy),
            })
            {
                if (File.Exists(candidate)) return candidate;
            }
        }
        return null;
    }

    /// <summary>
    /// Locates a multimodal projector (<c>*mmproj*.gguf</c>) sitting next to the model that belongs to
    /// the SAME model family, so an all-in-one vision model (e.g. Gemma 3, Qwen2.5-VL, LLaVA) loads its
    /// vision tower automatically. Returns null when no same-family projector is present — a plain text
    /// model then runs text-only and never accidentally loads another model's projector.
    /// </summary>
    private static string? FindSidecarMmproj(string modelPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(modelPath);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return null;
            var candidates = Directory.EnumerateFiles(dir, "*.gguf")
                .Where(f => Path.GetFileName(f).Contains("mmproj", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (candidates.Count == 0) return null;
            // Require the projector to share the model's leading family token (gemma / qwen2.5 / llava…).
            var stem = Path.GetFileNameWithoutExtension(modelPath).ToLowerInvariant();
            var key = stem.Split('-', '_', '.', ' ').FirstOrDefault(t => t.Length >= 3) ?? stem;
            return candidates.FirstOrDefault(f => Path.GetFileName(f).ToLowerInvariant().Contains(key));
        }
        catch { return null; }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(string lpszLongPath, System.Text.StringBuilder lpszShortPath, uint cchBuffer);

    // llama.cpp's command-line parser mangles non-ASCII characters in the model
    // path on Windows (e.g. a user folder like C:\Users\Büro3\...), so the server
    // fails with "failed to open GGUF file ... No such file or directory". Hand the
    // child process the 8.3 short path instead — it is pure ASCII, so the path
    // survives argv intact. .NET itself launches the exe and resolves File.Exists
    // over the long Unicode path fine; only the value passed *through* argv needs this.
    private static string ToRuntimeSafePath(string path)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return path;
        if (string.IsNullOrEmpty(path) || IsAscii(path) || !File.Exists(path)) return path;
        try
        {
            var sb = new System.Text.StringBuilder(520);
            var len = GetShortPathName(path, sb, (uint)sb.Capacity);
            if (len > sb.Capacity)
            {
                sb = new System.Text.StringBuilder((int)len);
                len = GetShortPathName(path, sb, (uint)sb.Capacity);
            }
            if (len == 0) return path;
            var shortPath = sb.ToString();
            // 8.3 short-name generation can be disabled per-volume; when it is, the
            // API echoes the long path back. Only adopt the result if it is ASCII-safe.
            return IsAscii(shortPath) ? shortPath : path;
        }
        catch
        {
            return path;
        }
    }

    private static bool IsAscii(string s)
    {
        foreach (var c in s)
        {
            if (c > '\x7F') return false;
        }
        return true;
    }
}
