using System;
using System.Net;
using System.Text.Json;
using Jobomate.Contracts;

namespace Jobomate.Llm;

// One taxonomy every provider's error maps to. Per llm-software-architecture/01:
// "provider errors map to one taxonomy: rate-limit, auth, context-length,
//  content-filter, transport, unknown."
public static class LlmErrorNormalizer
{
    public static ModelErrorCode Normalize(string? provider, HttpStatusCode status, string? body = null, string? providerCode = null)
    {
        var fromCode = MapProviderCode(provider, providerCode, body);
        if (fromCode != ModelErrorCode.Unknown) return fromCode;
        return FromHttpStatus(status, body);
    }

    public static ModelErrorCode FromHttpStatus(HttpStatusCode status, string? body = null)
    {
        if (status == HttpStatusCode.Unauthorized || status == HttpStatusCode.Forbidden)
            return ModelErrorCode.Authentication;
        if (status == (HttpStatusCode)429)
            return ModelErrorCode.RateLimit;
        if (status == HttpStatusCode.NotFound)
            return ModelErrorCode.ModelNotFound;
        if (status == HttpStatusCode.BadRequest)
            return ModelErrorCode.InvalidRequest;
        if (status == HttpStatusCode.RequestTimeout)
            return ModelErrorCode.Transport;
        if ((int)status >= 500)
            return ModelErrorCode.Transport;

        if (body != null)
        {
            var lower = body.ToLowerInvariant();
            if (lower.Contains("context_length") ||
                lower.Contains("maximum context length") ||
                lower.Contains("too many tokens") ||
                lower.Contains("prompt is too long"))
                return ModelErrorCode.ContextLength;
            if (lower.Contains("content_filter") ||
                lower.Contains("content policy") ||
                lower.Contains("safety filter") ||
                lower.Contains("responsible ai"))
                return ModelErrorCode.ContentFilter;
            if (lower.Contains("invalid_api_key") || lower.Contains("incorrect api key"))
                return ModelErrorCode.Authentication;
            if (lower.Contains("model_not_found") || lower.Contains("does not exist"))
                return ModelErrorCode.ModelNotFound;
        }

        return ModelErrorCode.Unknown;
    }

    public static ModelErrorCode FromException(Exception ex)
    {
        if (ex is OperationCanceledException oce && oce.CancellationToken.IsCancellationRequested)
            return ModelErrorCode.Cancelled;

        return ex switch
        {
            OperationCanceledException => ModelErrorCode.Transport,
            TimeoutException => ModelErrorCode.Transport,
            System.Net.Http.HttpRequestException => ModelErrorCode.Transport,
            _ => ModelErrorCode.Unknown,
        };
    }

    public static AgentErrorCode ToAgentErrorCode(ModelErrorCode code)
        => ModelErrorMapping.ToAgentErrorCode(code);

    private static ModelErrorCode MapProviderCode(string? provider, string? providerCode, string? body)
    {
        if (string.IsNullOrWhiteSpace(providerCode)) return ModelErrorCode.Unknown;
        var code = providerCode.Trim().ToLowerInvariant();
        var p = (provider ?? "").Trim().ToLowerInvariant();

        // OpenAI / OpenAI-compatible
        if (code is "rate_limit_exceeded" or "insufficient_quota") return ModelErrorCode.RateLimit;
        if (code is "invalid_api_key" or "authentication_error") return ModelErrorCode.Authentication;
        if (code is "context_length_exceeded" or "tokens_exceeded") return ModelErrorCode.ContextLength;
        if (code is "content_filter" or "content_policy_violation") return ModelErrorCode.ContentFilter;
        if (code is "model_not_found") return ModelErrorCode.ModelNotFound;

        // Anthropic
        if (p.Contains("anthropic"))
        {
            if (code is "overloaded_error") return ModelErrorCode.RateLimit;
            if (code is "authentication_error") return ModelErrorCode.Authentication;
            if (code is "invalid_request_error" && body?.Contains("context", StringComparison.OrdinalIgnoreCase) == true)
                return ModelErrorCode.ContextLength;
        }

        // Google
        if (p.Contains("google") || p.Contains("gemini"))
        {
            if (code is "resource_exhausted") return ModelErrorCode.RateLimit;
            if (code is "unauthenticated" or "permission_denied") return ModelErrorCode.Authentication;
        }

        return ModelErrorCode.Unknown;
    }

    /// <summary>Best-effort parse of a provider JSON error body for its machine code.</summary>
    public static string? TryExtractProviderCode(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var err))
            {
                if (err.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String)
                    return c.GetString();
                if (err.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String)
                    return t.GetString();
            }
            if (root.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String)
                return type.GetString();
        }
        catch { }
        return null;
    }
}
