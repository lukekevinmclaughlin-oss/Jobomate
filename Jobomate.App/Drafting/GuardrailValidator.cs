using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Jobomate.Contracts;

namespace Jobomate.Drafting;

/// <summary>
/// Post-generation safety net for any LLM-written application text: strips sentences that
/// stray into forbidden topics, caps German at intermediate, and guarantees the start
/// availability is stated. Pure + unit-tested.
/// </summary>
public static class GuardrailValidator
{
    private static readonly Regex OverstatedGerman =
        new(@"\b(fluent|native|advanced|proficient|bilingual|mother\s*tongue)\s+German\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static bool ContainsForbidden(string? text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        var t = text.ToLowerInvariant();
        return JobomateConstants.ForbiddenTopics.Any(t.Contains);
    }

    public static IReadOnlyList<string> FoundTopics(string? text)
    {
        if (string.IsNullOrEmpty(text)) return Array.Empty<string>();
        var t = text.ToLowerInvariant();
        return JobomateConstants.ForbiddenTopics.Where(t.Contains).Distinct().ToList();
    }

    /// <summary>Drop any sentence that mentions a forbidden topic.</summary>
    public static string StripForbidden(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        var sentences = Regex.Split(text, @"(?<=[.!?])\s+");
        var kept = sentences.Where(s => !ContainsForbidden(s));
        return Regex.Replace(string.Join(" ", kept), @"\s+", " ").Trim();
    }

    /// <summary>Never let the candidate be described as more than intermediate in German.</summary>
    public static string EnforceGermanLevel(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        return OverstatedGerman.Replace(text!, JobomateConstants.GermanLevel + " German");
    }

    /// <summary>Apply every guard to a body of generated text.</summary>
    public static string Clean(string? text) => EnforceGermanLevel(StripForbidden(text));
}
