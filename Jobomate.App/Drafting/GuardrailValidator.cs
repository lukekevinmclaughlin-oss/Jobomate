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

    /// <summary>Legacy German-specific cap (kept for back-compat / tests).</summary>
    public static string EnforceGermanLevel(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        return OverstatedGerman.Replace(text!, JobomateConstants.GermanLevel + " German");
    }

    private static readonly string[] HighLevels = { "native", "fluent", "bilingual", "mother", "proficient", "advanced", "c2", "c1" };

    /// <summary>
    /// Cap any over-stated claim about a profile language at the level the candidate actually
    /// stated — generalised across every language (not just German). Languages the candidate marks
    /// native/fluent are left untouched; lower-level ones (e.g. "intermediate French") get downgraded
    /// if the text over-claims ("fluent French" → "intermediate French").
    /// </summary>
    public static string EnforceLanguageLevels(string? text, CandidateProfile profile)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        var result = text!;
        foreach (var lang in profile.Languages)
        {
            if (string.IsNullOrWhiteSpace(lang.Language)) continue;
            var level = (lang.Level ?? "").ToLowerInvariant();
            if (HighLevels.Any(level.Contains)) continue; // native/fluent — nothing to cap
            var rx = new Regex($@"\b(fluent|native|advanced|proficient|bilingual|mother\s*tongue)\s+{Regex.Escape(lang.Language)}\b",
                RegexOptions.IgnoreCase);
            result = rx.Replace(result, lang.Level + " " + lang.Language);
        }
        return result;
    }

    /// <summary>Apply every guard (legacy, no profile).</summary>
    public static string Clean(string? text) => EnforceGermanLevel(StripForbidden(text));

    /// <summary>Apply every guard, capping each profile language at its stated level.</summary>
    public static string Clean(string? text, CandidateProfile profile) => EnforceLanguageLevels(StripForbidden(text), profile);
}
