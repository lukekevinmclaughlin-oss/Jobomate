using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Llm;

// The single internal service all model traffic flows through. Picks an
// adapter, sends the call, normalizes provider errors, and records cost.
//
// Phase 2 surface returns the raw response body (string). Phase 3 will
// add a Send(LlmRequest) overload that returns an IAsyncEnumerable<AgentEvent>
// once both the legacy LLMConnectionManager loop and the AvaloniaShell loop
// have been collapsed.
public sealed class LlmGateway
{
    private readonly Dictionary<string, ILlmAdapter> _adapters;
    private readonly LlmCostLedger _ledger;
    private readonly LlmCapabilityRegistry _capabilities;

    public LlmGateway(
        IEnumerable<ILlmAdapter> adapters,
        LlmCostLedger ledger,
        LlmCapabilityRegistry capabilities)
    {
        _adapters = adapters.ToDictionary(a => a.Name, a => a, StringComparer.OrdinalIgnoreCase);
        _ledger = ledger;
        _capabilities = capabilities;
        foreach (var a in _adapters.Values)
        {
            _capabilities.RegisterAdapter(a.Name, a.Capabilities);
        }
    }

    public IEnumerable<string> AdapterNames => _adapters.Keys;

    public ILlmAdapter Adapter(string name)
        => _adapters.TryGetValue(name, out var a)
            ? a
            : throw new InvalidOperationException($"No LLM adapter named '{name}' is registered.");

    public LlmCapability Capabilities(string adapter, string model)
        => _capabilities.CapabilitiesFor(adapter, model);

    public ProviderModelMetadata ModelMetadata(AppConnectionType connectionType, string adapter, string model)
        => ModelCapabilities.Resolve(connectionType, model, Capabilities(adapter, model));

    public async Task<string> Send(
        string adapterName,
        LlmEndpoint endpoint,
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages,
        IReadOnlyList<JsonElement> tools,
        LlmCallOptions options,
        CancellationToken ct)
    {
        var adapter = Adapter(adapterName);
        // Retry transient failures (rate-limit / transport / 5xx) a couple of times with
        // exponential backoff, so a momentary network blip or provider hiccup doesn't fail the
        // chat. Cancellation and non-transient errors (auth, context-length, content-filter,
        // unknown) are never retried. Connection tests skip retries for fast feedback.
        const int maxAttempts = 3;
        for (var attempt = 1; ; attempt++)
        {
            var startedAt = DateTimeOffset.UtcNow;
            try
            {
                var body = await adapter.Send(endpoint, messages, tools, options, ct).ConfigureAwait(false);
                _ledger.Record(new LlmCost(
                    Adapter: adapter.Name,
                    Model: endpoint.Model,
                    PromptTokens: TryReadUsage(body, prompt: true),
                    CompletionTokens: TryReadUsage(body, prompt: false),
                    UsdCost: null,
                    At: startedAt));
                return body;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException ex)
            {
                throw new LlmAdapterException(AgentErrorCode.Transport, "Request timed out: " + ex.Message);
            }
            catch (Exception ex)
            {
                // Normalize raw exceptions so callers (and this retry) see the taxonomy.
                var normalized = ex as LlmAdapterException
                    ?? new LlmAdapterException(LlmErrorNormalizer.FromException(ex), ex.Message);
                var transient = normalized.Code is AgentErrorCode.RateLimit or AgentErrorCode.Transport;
                if (transient && attempt < maxAttempts && !options.ConnectionTest && !ct.IsCancellationRequested)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(400 * (1 << (attempt - 1))), ct).ConfigureAwait(false);
                    continue;
                }
                throw normalized;
            }
        }
    }

    // Try each (adapter, endpoint) in the chain until one succeeds. Each provider still gets its own
    // per-call transient retry (via Send). Falls back to the next provider on a provider-specific
    // failure (auth / quota / transport / context-length / server / unknown) but NOT on ContentFilter
    // (the same content would be rejected everywhere) or cancellation. Throws the last error if every
    // provider fails. A single-entry chain behaves exactly like Send (no behavioural change).
    public async Task<string> SendWithFallback(
        IReadOnlyList<(string Adapter, LlmEndpoint Endpoint)> chain,
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages,
        IReadOnlyList<JsonElement> tools,
        LlmCallOptions options,
        CancellationToken ct)
    {
        if (chain is null || chain.Count == 0)
            throw new InvalidOperationException("SendWithFallback requires at least one provider in the chain.");
        LlmAdapterException? last = null;
        for (var i = 0; i < chain.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                return await Send(chain[i].Adapter, chain[i].Endpoint, messages, tools, options, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (LlmAdapterException ex)
            {
                last = ex;
                if (i == chain.Count - 1 || !ShouldFallback(ex.Code)) throw;
                // otherwise fall through to the next provider in the chain
            }
        }
        throw last ?? new LlmAdapterException(AgentErrorCode.Unknown, "All providers in the fallback chain failed.");
    }

    // Content-filter rejects the same content on every provider, and cancellation is the user's intent;
    // everything else is provider-specific enough to be worth trying on the next provider.
    private static bool ShouldFallback(AgentErrorCode code)
        => code is not (AgentErrorCode.ContentFilter or AgentErrorCode.Cancelled);

    // Reads prompt/completion token counts across provider usage shapes: OpenAI
    // (usage.prompt_tokens / completion_tokens), Anthropic (usage.input_tokens /
    // output_tokens), and Gemini (usageMetadata.promptTokenCount / candidatesTokenCount).
    // Previously only the OpenAI shape was read, so Anthropic/Google recorded null (BUG-0031).
    private static int? TryReadUsage(string body, bool prompt)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("usage", out var usage))
            {
                var keys = prompt ? new[] { "prompt_tokens", "input_tokens" }
                                  : new[] { "completion_tokens", "output_tokens" };
                foreach (var k in keys)
                    if (usage.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number)
                        return v.GetInt32();
            }
            if (root.TryGetProperty("usageMetadata", out var um))
            {
                var k = prompt ? "promptTokenCount" : "candidatesTokenCount";
                if (um.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number)
                    return v.GetInt32();
            }
        }
        catch { /* best effort */ }
        return null;
    }
}
