using System.Text.RegularExpressions;

namespace Jobomate.Security;

/// <summary>
/// Replaces common secret shapes with neutral placeholders before any
/// agent turn is written to disk. Patterns are intentionally
/// conservative; the cost of a false positive (a redacted log line) is
/// negligible compared to leaking a credential.
/// </summary>
public static class SecretRedactor
{
    private static readonly (Regex Pattern, string Placeholder)[] Rules =
    {
        // Anthropic-style API keys. Must run before the generic sk- rule
        // below, otherwise the broader pattern redacts sk-ant- keys first
        // and this more specific rule never matches.
        (new Regex(@"sk-ant-[A-Za-z0-9\-_]{16,}", RegexOptions.Compiled), "<api-key>"),
        // OpenAI-style API keys and project keys.
        (new Regex(@"sk-[A-Za-z0-9\-_]{16,}", RegexOptions.Compiled), "<api-key>"),
        // GitHub PATs (classic + fine-grained).
        (new Regex(@"gh[ouprs]_[A-Za-z0-9]{16,}", RegexOptions.Compiled), "<github-token>"),
        // Bearer headers, case-insensitive.
        (new Regex(@"[Bb]earer\s+[A-Za-z0-9\-_\.]{8,}", RegexOptions.Compiled), "Bearer <bearer>"),
        // Authorization header values that look like API keys (Anthropic x-api-key shape).
        (new Regex(@"(?<=""x-api-key""\s*:\s*"")[^""]+", RegexOptions.Compiled), "<api-key>"),
        // OAuth refresh / access tokens (very loose).
        (new Regex(@"ya29\.[A-Za-z0-9\-_]{16,}", RegexOptions.Compiled), "<oauth-token>"),
        // AWS access key id.
        (new Regex(@"AKIA[0-9A-Z]{16}", RegexOptions.Compiled), "<aws-access-key-id>"),
    };

    /// <summary>Apply all redaction rules to <paramref name="input"/>.</summary>
    public static string Redact(string? input)
    {
        if (string.IsNullOrEmpty(input)) return input ?? "";
        var output = input!;
        foreach (var (pattern, placeholder) in Rules)
        {
            output = pattern.Replace(output, placeholder);
        }
        return output;
    }
}
