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

    /// <summary>
    /// Replace leftover template placeholders the model sometimes leaves in (e.g. "[Your Name]",
    /// "[Position]") so an application never goes out with an unfilled bracket. Name placeholders
    /// become the candidate's name; date placeholders are dropped; any other bracketed stub is removed.
    /// </summary>
    public static string FillPlaceholders(string? text, CandidateProfile profile)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        var name = (profile.FullName ?? "").Trim();
        var result = text!;
        // Name-style placeholders → the candidate's name (or just drop the bracket if we have no name).
        result = Regex.Replace(result, @"\[\s*(your\s+full\s+name|your\s+name|full\s+name|candidate\s+name|applicant\s+name|sender\s+name|name)\s*\]",
            name, RegexOptions.IgnoreCase);
        // Anything else still in square brackets (e.g. "[Position]", "[Company]", "[Date]") → remove.
        result = Regex.Replace(result, @"\[[^\]\r\n]{0,60}\]", "");
        // Tidy the gaps the removals leave behind.
        result = Regex.Replace(result, @"[ \t]{2,}", " ");
        result = Regex.Replace(result, @"\n{3,}", "\n\n");
        return result.Trim();
    }

    /// <summary>Apply every guard (legacy, no profile).</summary>
    public static string Clean(string? text) => EnforceGermanLevel(StripForbidden(text));

    /// <summary>Apply every guard, capping each profile language at its stated level and filling
    /// any leftover template placeholders.</summary>
    public static string Clean(string? text, CandidateProfile profile) =>
        FillPlaceholders(EnforceLanguageLevels(StripForbidden(text), profile), profile);
}
