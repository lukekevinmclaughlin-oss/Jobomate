using System;

namespace Jobomate.Llm;

/// <summary>
/// Retry policy for transient LLM failures (Round 24): rate-limit + transport errors are retried
/// with exponential backoff; auth / context-length / content-filter / invalid-request are not
/// (retrying those just wastes calls). Pure + testable; the gateway/agent loop can drive it.
/// </summary>
public static class TransientRetry
{
    public static bool IsRetryable(ModelErrorCode code) =>
        code is ModelErrorCode.RateLimit or ModelErrorCode.Transport;

    /// <summary>Backoff for a 1-based attempt: 0.5s, 1s, 2s, 4s, ... capped at <paramref name="maxSeconds"/>.</summary>
    public static TimeSpan Backoff(int attempt, double maxSeconds = 30)
    {
        if (attempt < 1) attempt = 1;
        var seconds = Math.Min(maxSeconds, 0.5 * Math.Pow(2, attempt - 1));
        return TimeSpan.FromSeconds(seconds);
    }

    /// <summary>Whether to attempt again given the error and how many attempts have already happened.</summary>
    public static bool ShouldRetry(ModelErrorCode code, int attemptsSoFar, int maxAttempts = 3) =>
        IsRetryable(code) && attemptsSoFar < maxAttempts;
}
