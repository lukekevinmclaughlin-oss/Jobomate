using System;
using System.Linq;
using Jobomate.Contracts;

namespace Jobomate.Profile;

/// <summary>
/// Pure profile construction + guardrails. Deterministic and unit-tested: the
/// fallback path (CV parse failed / too little text) and the honesty guards
/// (never claim German fluency) do not depend on an LLM or the filesystem.
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
        if (GuessName(clean) is { Length: > 0 } name) profile.FullName = name;
        profile.Summary = ExcerptSummary(clean) is { Length: > 0 } excerpt ? excerpt : profile.Summary;
        return EnforceGuards(profile);
    }

    /// <summary>Heuristic: a CV usually opens with the candidate's name on its own line — 2-4
    /// words, letters only (allowing . - '), no digits/email/role keywords.</summary>
    private static string? GuessName(string cvText)
    {
        var roleWords = new[] { "curriculum", "vitae", "resume", "cv", "profile", "summary", "engineer", "developer", "manager", "designer", "analyst", "consultant", "director", "specialist", "lead", "senior", "junior" };
        foreach (var raw in cvText.Split('\n').Take(8))
        {
            var line = raw.Trim();
            if (line.Length is < 4 or > 48) continue;
            if (line.Any(char.IsDigit) || line.Contains('@') || line.Contains(':') || line.Contains(',')) continue;
            var words = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (words.Length is < 2 or > 4) continue;
            if (!words.All(w => w.All(c => char.IsLetter(c) || c is '.' or '-' or '\''))) continue;
            var lower = line.ToLowerInvariant();
            if (roleWords.Any(lower.Contains)) continue;
            // Title-case (handles ALL-CAPS names like "JORDAN AVERY").
            return string.Join(' ', words.Select(w => w.Length == 0 ? w : char.ToUpper(w[0]) + w[1..].ToLowerInvariant()));
        }
        return null;
    }

    /// <summary>
    /// Enforce the honesty rules on any profile (including LLM-enriched ones):
    /// German is never described above "intermediate".
    /// </summary>
    public static CandidateProfile EnforceGuards(CandidateProfile profile)
    {
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
