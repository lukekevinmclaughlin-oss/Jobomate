using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Llm.Adapters;
using Jobomate.Llm.Local;
using Jobomate.Persistence;

namespace Jobomate.Llm;

public sealed record ChatMessage(string Role, string Content);

public sealed record ConnectionTestResult(bool Ok, string Message, string Sample = "");

/// <summary>
/// High-level entry point the rest of Jobomate uses to talk to whichever LLM the
/// user configured. Resolves an <see cref="LlmConnectionConfig"/> (reading the API key
/// from the Keychain) into a gateway call and returns plain assistant text.
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

    /// <summary>Build a gateway with the cloud + local OpenAI-compatible adapters registered.</summary>
    public static LlmGateway BuildGateway(HttpClient? http = null)
    {
        http ??= new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        var adapters = new ILlmAdapter[]
        {
            new OpenAiCompatibleAdapter(http),
            new AnthropicAdapter(http),
            new GoogleAiAdapter(http),
        };
        return new LlmGateway(adapters, new LlmCostLedger(), new LlmCapabilityRegistry());
    }

    public static string ApiKeyName(AppApiProvider provider) => provider.ToString();

    public async Task<string> CompleteAsync(
        LlmConnectionConfig cfg,
        IReadOnlyList<ChatMessage> messages,
        LlmCallOptions? options = null,
        CancellationToken ct = default)
    {
        var (adapter, endpoint) = await ResolveAsync(cfg, ct).ConfigureAwait(false);
        var payload = messages
            .Select(m => (IReadOnlyDictionary<string, string>)new Dictionary<string, string>
            {
                ["role"] = m.Role,
                ["content"] = m.Content,
            })
            .ToList();

        var body = await _gateway
            .Send(adapter, endpoint, payload, Array.Empty<JsonElement>(), options ?? new LlmCallOptions(), ct)
            .ConfigureAwait(false);

        return ResponseTextExtractor.Extract(adapter, body);
    }

    /// <summary>One tiny round-trip to confirm the connection works (used by all three menus).</summary>
    public async Task<ConnectionTestResult> TestConnectionAsync(LlmConnectionConfig cfg, CancellationToken ct = default)
    {
        try
        {
            var sample = await CompleteAsync(
                cfg,
                new[] { new ChatMessage("user", "Reply with exactly: OK") },
                new LlmCallOptions(ConnectionTest: true, MaxOutputTokens: 16),
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

    /// <summary>Resolve the configured connection into (adapter name, endpoint), starting the GGUF server if needed.</summary>
    public async Task<(string Adapter, LlmEndpoint Endpoint)> ResolveAsync(LlmConnectionConfig cfg, CancellationToken ct)
    {
        switch (cfg.ConnectionType)
        {
            case AppConnectionType.ApiKey:
            {
                var info = Providers.Info(cfg.ApiProvider);
                var url = cfg.ApiProvider == AppApiProvider.Custom && !string.IsNullOrWhiteSpace(cfg.CustomEndpoint)
                    ? cfg.CustomEndpoint
                    : info.Url;
                var model = string.IsNullOrWhiteSpace(cfg.Model) ? info.Model : cfg.Model;
                var key = _credentials.GetApiKey(ApiKeyName(cfg.ApiProvider)) ?? "";

                // Google authenticates via a ?key= query param (handled inside GoogleAiAdapter).
                if (Providers.UsesQueryParamAuth(cfg.ApiProvider))
                    return (info.Adapter, new LlmEndpoint(url, model, AuthHeader: null, AuthValue: key));

                return (info.Adapter, new LlmEndpoint(url, model, info.Header, info.Prefix + key));
            }

            case AppConnectionType.LocalServer:
            {
                var url = LocalLlmRuntime.NormalizeServerUrl(cfg.LocalServerUrl);
                var model = string.IsNullOrWhiteSpace(cfg.LocalModelName) ? "local-model" : cfg.LocalModelName;
                return (AdapterNames.OpenAiCompatible, new LlmEndpoint(url, model));
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
                throw new LlmAdapterException(AgentErrorCode.Unknown,
                    $"Connection type {cfg.ConnectionType} is not supported for chat.");
        }
    }

    private static async Task<string> EnsureLocalAiAsync(LlmConnectionConfig cfg, CancellationToken ct)
    {
        var validation = LocalLlmRuntime.ValidateGgufPath(cfg.LocalAIModelPath);
        if (!validation.Ok)
            throw new LlmAdapterException(AgentErrorCode.Unknown, validation.Message);

        if (!BundledLlamaServer.IsAvailable)
            throw new LlmAdapterException(AgentErrorCode.Unknown,
                "No llama-server runtime found. Install llama.cpp (e.g. `brew install llama.cpp`) or place a " +
                "llama-server binary under ./gguf-runtime, then retry. Jobomate never downloads models for you.");

        var endpoint = await BundledLlamaServer
            .EnsureRunningAsync(cfg.LocalAIModelPath, Math.Max(1024, cfg.LocalAIContextSize), ct, "Jobomate")
            .ConfigureAwait(false);

        if (string.IsNullOrEmpty(endpoint))
            throw new LlmAdapterException(AgentErrorCode.Transport, "The local GGUF server failed to start.");

        return endpoint!;
    }
}
