using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Email;
using Jobomate.Llm.Adapters;
using Jobomate.Llm.Local;
using Jobomate.Persistence;

namespace Jobomate.Llm;

public sealed record ChatMessage(string Role, string Content);

public sealed record ConnectionTestResult(bool Ok, string Message, string Sample = "");

/// <summary>
/// High-level entry point to whichever LLM the user configured. Resolves an
/// <see cref="LlmConnectionConfig"/> across all six connection types (API key, local
/// server, local GGUF, CLI pipe, terminal, OAuth bearer) into a gateway call, applies
/// reasoning-effort / fast-mode / system-prompt, and reports activity for the sidecar.
/// </summary>
public sealed class LlmClient
{
    private readonly LlmGateway _gateway;
    private readonly ICredentialStore _credentials;

    public LlmClient(LlmGateway gateway, ICredentialStore credentials)
    {
        _gateway = gateway;
        _credentials = credentials;
    }

    /// <summary>Raised around every call so the automation sidecar can show LLM activity. (detail, isActive)</summary>
    public event Action<string, bool>? ActivityChanged;

    public static LlmGateway BuildGateway(HttpClient? http = null)
    {
        http ??= new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        var adapters = new ILlmAdapter[]
        {
            new OpenAiCompatibleAdapter(http),
            new AnthropicAdapter(http),
            new GoogleAiAdapter(http),
            new CliAdapter(RunShellAsync),
        };
        return new LlmGateway(adapters, new LlmCostLedger(), new LlmCapabilityRegistry());
    }

    public static string ApiKeyName(AppApiProvider provider) => provider.ToString();

    public async Task<string> CompleteAsync(
        LlmConnectionConfig cfg, IReadOnlyList<ChatMessage> messages, LlmCallOptions? options = null, CancellationToken ct = default)
    {
        ActivityChanged?.Invoke($"Contacting {Describe(cfg)}…", true);
        try
        {
            var (adapter, endpoint) = await ResolveAsync(cfg, ct).ConfigureAwait(false);
            var opts = MergeOptions(cfg, adapter, options);
            var payload = BuildPayload(cfg, messages);

            var body = await _gateway.Send(adapter, endpoint, payload, Array.Empty<JsonElement>(), opts, ct).ConfigureAwait(false);
            var text = ResponseTextExtractor.Extract(adapter, body);
            ActivityChanged?.Invoke($"Received {text.Length} chars", false);
            return text;
        }
        catch (Exception ex)
        {
            ActivityChanged?.Invoke("Error: " + ex.Message, false);
            throw;
        }
        finally
        {
            ActivityChanged?.Invoke("", false);
        }
    }

    public async Task<ConnectionTestResult> TestConnectionAsync(LlmConnectionConfig cfg, CancellationToken ct = default)
    {
        try
        {
            var sample = await CompleteAsync(cfg,
                new[] { new ChatMessage("user", "Reply with exactly: OK") },
                new LlmCallOptions(ConnectionTest: true, MaxOutputTokens: cfg.ConnectionType is AppConnectionType.CliPipe or AppConnectionType.Terminal ? cfg.CliTimeout : 16),
                ct).ConfigureAwait(false);
            return new ConnectionTestResult(true, "Connected — the model responded.", sample.Trim());
        }
        catch (LlmAdapterException ex)
        {
            return new ConnectionTestResult(false, $"{ex.Code}: {ex.Message}");
        }
        catch (Exception ex)
        {
            return new ConnectionTestResult(false, ex.Message);
        }
    }

    /// <summary>Run the LLM-OAuth browser sign-in for this config (stores the refresh token in the Keychain).</summary>
    public Task SignInOAuthAsync(LlmConnectionConfig cfg, CancellationToken ct = default)
    {
        var defaults = Providers.OAuthDefaults(cfg.OAuthProvider);
        var scope = string.IsNullOrWhiteSpace(cfg.OAuthScope) ? defaults.Scope : cfg.OAuthScope;
        return BuildOAuthManager(cfg).SignInAsync(
            scope.Split(' ', StringSplitOptions.RemoveEmptyEntries), ct);
    }

    public async Task<(string Adapter, LlmEndpoint Endpoint)> ResolveAsync(LlmConnectionConfig cfg, CancellationToken ct)
    {
        switch (cfg.ConnectionType)
        {
            case AppConnectionType.ApiKey:
            {
                var info = Providers.Info(cfg.ApiProvider);
                var url = !string.IsNullOrWhiteSpace(cfg.CustomEndpoint) ? cfg.CustomEndpoint : info.Url;
                var model = cfg.ResolvedModel();
                var key = ResolveApiKey(cfg.ApiProvider);

                if (Providers.UsesQueryParamAuth(cfg.ApiProvider))
                {
                    // Google: key is a query param the adapter appends; {model} is substituted by the adapter.
                    return (info.Adapter, new LlmEndpoint(url, model, AuthHeader: null, AuthValue: key));
                }
                var auth = string.IsNullOrWhiteSpace(info.Header) || string.IsNullOrWhiteSpace(key)
                    ? (null, (string?)null)
                    : (info.Header, info.Prefix + key);
                return (info.Adapter, new LlmEndpoint(url, model, auth.Item1, auth.Item2));
            }

            case AppConnectionType.LocalServer:
            {
                var url = LocalLlmRuntime.NormalizeServerUrl(cfg.LocalServerUrl);
                var model = string.IsNullOrWhiteSpace(cfg.LocalModelName) ? "local-model" : cfg.LocalModelName;
                return (AdapterNames.OpenAiCompatible, new LlmEndpoint(url, model));
            }

            case AppConnectionType.CliPipe:
                return (AdapterNames.Cli, new LlmEndpoint(cfg.CliCommand, "cli"));

            case AppConnectionType.Terminal:
                return (AdapterNames.Cli, new LlmEndpoint(cfg.TerminalCommand, "cli"));

            case AppConnectionType.OAuth:
            {
                if (string.IsNullOrWhiteSpace(cfg.CustomEndpoint))
                    throw new LlmAdapterException(AgentErrorCode.Unknown, "OAuth connection needs an endpoint URL (Custom endpoint).");
                var token = await BuildOAuthManager(cfg).GetAccessTokenAsync(ct).ConfigureAwait(false);
                return (AdapterNames.OpenAiCompatible, new LlmEndpoint(cfg.CustomEndpoint, cfg.ResolvedModel(), "Authorization", "Bearer " + token));
            }

            case AppConnectionType.LocalAI:
            {
                var url = await EnsureLocalAiAsync(cfg, ct).ConfigureAwait(false);
                var model = string.IsNullOrWhiteSpace(cfg.LocalAIModelName)
                    ? Path.GetFileNameWithoutExtension(cfg.LocalAIModelPath)
                    : cfg.LocalAIModelName;
                return (AdapterNames.OpenAiCompatible, new LlmEndpoint(url, model));
            }

            default:
                throw new LlmAdapterException(AgentErrorCode.Unknown, $"Connection type {cfg.ConnectionType} is not supported.");
        }
    }

    // ----- options / payload -----

    private static LlmCallOptions MergeOptions(LlmConnectionConfig cfg, string adapter, LlmCallOptions? caller)
    {
        var o = caller ?? new LlmCallOptions();

        string? effort = o.ReasoningEffort;
        if (!o.ConnectionTest && cfg.ConnectionType is AppConnectionType.ApiKey or AppConnectionType.OAuth
            && Providers.SupportsReasoningEffort(cfg.ApiProvider, cfg.ResolvedModel()))
        {
            effort = cfg.FastMode ? "low" : Providers.ReasoningEffortApiValue(cfg.ReasoningEffort);
        }

        var maxTokens = o.MaxOutputTokens;
        if (adapter == AdapterNames.Cli && maxTokens is null) maxTokens = cfg.CliTimeout;

        return o with { FastMode = o.FastMode || cfg.FastMode, ReasoningEffort = effort, MaxOutputTokens = maxTokens };
    }

    private static List<IReadOnlyDictionary<string, string>> BuildPayload(LlmConnectionConfig cfg, IReadOnlyList<ChatMessage> messages)
    {
        var list = new List<IReadOnlyDictionary<string, string>>();
        var hasSystem = messages.Count > 0 && messages[0].Role.Equals("system", StringComparison.OrdinalIgnoreCase);
        if (!hasSystem && !string.IsNullOrWhiteSpace(cfg.SystemPrompt))
            list.Add(new Dictionary<string, string> { ["role"] = "system", ["content"] = cfg.SystemPrompt });
        foreach (var m in messages)
            list.Add(new Dictionary<string, string> { ["role"] = m.Role, ["content"] = m.Content });
        return list;
    }

    // ----- key + OAuth + GGUF + shell -----

    private string ResolveApiKey(AppApiProvider provider)
    {
        var stored = _credentials.GetApiKey(ApiKeyName(provider));
        if (!string.IsNullOrWhiteSpace(stored)) return stored!;
        foreach (var env in Providers.ApiKeyEnvironmentNames(provider))
        {
            var v = Environment.GetEnvironmentVariable(env);
            if (!string.IsNullOrWhiteSpace(v)) return v!;
        }
        return "";
    }

    private OAuthTokenManager BuildOAuthManager(LlmConnectionConfig cfg)
    {
        var defaults = Providers.OAuthDefaults(cfg.OAuthProvider);
        var auth = string.IsNullOrWhiteSpace(cfg.OAuthAuthUrl) ? defaults.AuthUrl : cfg.OAuthAuthUrl;
        var token = string.IsNullOrWhiteSpace(cfg.OAuthTokenUrl) ? defaults.TokenUrl : cfg.OAuthTokenUrl;
        var secret = _credentials.GetCloudToken(cfg.OAuthClientSecretRef);
        return new OAuthTokenManager(new OAuthEndpoints(auth, token), cfg.OAuthClientId, secret, _credentials, cfg.OAuthRefreshRef);
    }

    private static async Task<string> EnsureLocalAiAsync(LlmConnectionConfig cfg, CancellationToken ct)
    {
        var validation = LocalLlmRuntime.ValidateGgufPath(cfg.LocalAIModelPath);
        if (!validation.Ok)
            throw new LlmAdapterException(AgentErrorCode.Unknown, validation.Message);
        if (!BundledLlamaServer.IsAvailable)
            throw new LlmAdapterException(AgentErrorCode.Unknown,
                "No llama-server runtime found. Install llama.cpp (e.g. `brew install llama.cpp`) or place a llama-server binary under ./gguf-runtime, then retry. Jobomate never downloads models for you.");

        var endpoint = await BundledLlamaServer
            .EnsureRunningAsync(cfg.LocalAIModelPath, Math.Max(1024, cfg.LocalAIContextSize), ct, "Jobomate")
            .ConfigureAwait(false);
        if (string.IsNullOrEmpty(endpoint))
            throw new LlmAdapterException(AgentErrorCode.Transport, "The local GGUF server failed to start.");
        return endpoint!;
    }

    /// <summary>Shell runner used by the CLI/Terminal connection types. Substitutes {prompt} or pipes via stdin.</summary>
    private static async Task<string> RunShellAsync(string command, string prompt, int timeoutSeconds, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(command))
            throw new LlmAdapterException(AgentErrorCode.Unknown, "The CLI/terminal command template is empty.");

        var substitutes = command.Contains("{prompt}", StringComparison.Ordinal);
        var finalCmd = substitutes ? command.Replace("{prompt}", ShellQuote(prompt)) : command;

        var psi = new ProcessStartInfo("/bin/bash")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = !substitutes,
            UseShellExecute = false,
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add(finalCmd);

        using var proc = Process.Start(psi) ?? throw new LlmAdapterException(AgentErrorCode.Transport, "Failed to start the shell.");
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(timeoutSeconds, 5, 600)));

        try
        {
            if (!substitutes)
            {
                await proc.StandardInput.WriteAsync(prompt).ConfigureAwait(false);
                proc.StandardInput.Close();
            }
            var stdout = await proc.StandardOutput.ReadToEndAsync(timeoutCts.Token).ConfigureAwait(false);
            await proc.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
            if (proc.ExitCode != 0 && string.IsNullOrWhiteSpace(stdout))
            {
                var err = await proc.StandardError.ReadToEndAsync(ct).ConfigureAwait(false);
                throw new LlmAdapterException(AgentErrorCode.Transport, $"Command exited {proc.ExitCode}: {err.Trim()}");
            }
            return stdout.Trim();
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            try { proc.Kill(true); } catch { }
            throw new LlmAdapterException(AgentErrorCode.Transport, $"Command timed out after {timeoutSeconds}s.");
        }
    }

    private static string ShellQuote(string s) => "'" + s.Replace("'", "'\\''") + "'";

    private static string Describe(LlmConnectionConfig cfg) => cfg.ConnectionType switch
    {
        AppConnectionType.ApiKey => Providers.DisplayName(cfg.ApiProvider),
        AppConnectionType.LocalServer => "local server",
        AppConnectionType.LocalAI => "local GGUF",
        AppConnectionType.CliPipe => "CLI",
        AppConnectionType.Terminal => "terminal",
        AppConnectionType.OAuth => "OAuth (" + cfg.OAuthProvider + ")",
        _ => cfg.ConnectionType.ToString(),
    };
}
