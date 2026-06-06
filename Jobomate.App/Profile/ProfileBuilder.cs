using System;
using System.Linq;
using Jobomate.Contracts;

namespace Jobomate.Profile;

/// <summary>
/// Pure profile construction + guardrails. Deterministic and unit-tested: the
/// fallback path (CV parse failed / too little text) and the honesty guards
/// (never claim German fluency; never imply availability earlier than 1 Oct 2026)
/// do not depend on an LLM or the filesystem.
/// </summary>
public static class ProfileBuilder
{
    private const int MinUsefulChars = 200;

    private static readonly string[] OverstatedGerman =
        { "fluent", "native", "advanced", "proficient", "c1", "c2", "bilingual" };

    /// <summary>
    /// Build a profile from extracted CV text. If the text is empty/too short, return
    /// the known-background fallback (FromFallback = true). Otherwise seed from the known
    /// facts and attach a CV-derived summary excerpt. Always passes through the guards.
    /// </summary>
    public static CandidateProfile FromCvText(string? cvText)
    {
        var clean = (cvText ?? "").Trim();
        if (clean.Length < MinUsefulChars)
        {
            var fallback = CandidateProfileDefaults.Known();
            fallback.FromFallback = true;
            return EnforceGuards(fallback);
        }

        var profile = CandidateProfileDefaults.Known();
        profile.FromFallback = false;
        profile.Summary = ExcerptSummary(clean) is { Length: > 0 } excerpt ? excerpt : profile.Summary;
        return EnforceGuards(profile);
    }

    /// <summary>
    /// Enforce the hard honesty rules on any profile (including LLM-enriched ones):
    /// availability is never earlier than 1 October 2026, and German is never above
    /// "intermediate".
    /// </summary>
    public static CandidateProfile EnforceGuards(CandidateProfile profile)
    {
        if (profile.AvailabilityFrom < JobomateConstants.AvailabilityDate)
            profile.AvailabilityFrom = JobomateConstants.AvailabilityDate;

        foreach (var lang in profile.Languages)
        {
            if (!lang.Language.Equals("German", StringComparison.OrdinalIgnoreCase)) continue;
            var level = (lang.Level ?? "").ToLowerInvariant();
            if (OverstatedGerman.Any(level.Contains))
                lang.Level = JobomateConstants.GermanLevel;
        }

        return profile;
    }

    private static string ExcerptSummary(string cvText)
    {
        // First non-trivial lines of the CV, capped — a readable seed the user can edit.
        var lines = cvText
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(l => l.Length > 3)
            .Take(6);
        var joined = string.Join(" ", lines);
        return joined.Length > 600 ? joined[..600] + "…" : joined;
    }
}
