using System;
using System.Collections.Generic;
using System.Linq;
using Jobomate.Contracts;

namespace Jobomate.Filters;

/// <summary>
/// Strict, explainable language filtering. Decisions are deterministic given the
/// (evidence-cited) language requirements: it never guesses. Modes form a monotonic
/// inclusivity ladder — Strict ⊂ IncludeUnclear ⊂ IncludePreferredMismatch ⊂ ShowAllFlag.
/// </summary>
public static class LanguageFilter
{
    public static (LanguageInclusionDecision Decision, string Reason) Evaluate(
        IReadOnlyList<LanguageRequirement> requirements,
        IReadOnlyCollection<string> acceptedLanguages,
        LanguageMatchMode mode)
    {
        var accepted = new HashSet<string>(acceptedLanguages.Select(a => a.Trim().ToLowerInvariant()));

        var required = requirements
            .Where(r => r.Kind == LanguageRequirementKind.Required && !string.IsNullOrWhiteSpace(r.Evidence))
            .Select(r => r.Language).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        var preferred = requirements
            .Where(r => r.Kind == LanguageRequirementKind.Preferred)
            .Select(r => r.Language).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        // "Unclear" = nothing carries evidence (the LLM is required to cite a phrase; missing → unclear).
        var unclear = requirements.Count == 0 ||
                      requirements.All(r => r.Kind == LanguageRequirementKind.Unclear || string.IsNullOrWhiteSpace(r.Evidence));

        var reqNotAccepted = required.Where(l => !accepted.Contains(l.ToLowerInvariant())).ToList();
        var prefNotAccepted = preferred.Where(l => !accepted.Contains(l.ToLowerInvariant())).ToList();

        var level = mode switch
        {
            LanguageMatchMode.StrictRequired => 0,
            LanguageMatchMode.IncludeUnclear => 1,
            LanguageMatchMode.IncludePreferredMismatch => 2,
            LanguageMatchMode.ShowAllFlag => 3,
            _ => 0,
        };

        var reqStr = required.Count > 0 ? string.Join(", ", required) : "none stated as mandatory";
        var prefStr = preferred.Count > 0 ? string.Join(", ", preferred) : "none";

        // Show-all: never excludes, flags anything off.
        if (level >= 3)
        {
            var issue = reqNotAccepted.Count > 0 || unclear;
            return (issue ? LanguageInclusionDecision.Flagged : LanguageInclusionDecision.Included,
                $"Required: {reqStr}. Preferred: {prefStr}. Shown (flag-mismatches mode).");
        }

        if (unclear)
        {
            return level >= 1
                ? (LanguageInclusionDecision.Flagged, "Language requirement unclear — included per your setting.")
                : (LanguageInclusionDecision.Excluded, "Language requirement unclear; enable \"include unclear language postings\" to see it.");
        }

        if (reqNotAccepted.Count > 0)
        {
            return level >= 2
                ? (LanguageInclusionDecision.Flagged, $"Requires {string.Join(", ", reqNotAccepted)} (mandatory) — included per your \"include mismatches\" setting.")
                : (LanguageInclusionDecision.Excluded, $"Requires {string.Join(", ", reqNotAccepted)} (mandatory), which is not in your accepted languages ({string.Join(", ", acceptedLanguages)}).");
        }

        // All mandatory languages are accepted.
        if (prefNotAccepted.Count > 0)
            return (LanguageInclusionDecision.Included,
                $"Required: {reqStr} (you have these). Preferred: {string.Join(", ", prefNotAccepted)} — nice-to-have, not mandatory.");

        return (LanguageInclusionDecision.Included, $"Required: {reqStr}. Preferred: {prefStr}.");
    }

    /// <summary>A human-readable Required/Preferred/Decision/Reason block with evidence.</summary>
    public static string Summary(JobPosting job)
    {
        string Block(LanguageRequirementKind kind) => string.Join("; ", job.LanguageRequirements
            .Where(r => r.Kind == kind)
            .Select(r => string.IsNullOrWhiteSpace(r.Evidence) ? r.Language : $"{r.Language} (“{r.Evidence}”)"));

        var required = Block(LanguageRequirementKind.Required);
        var preferred = Block(LanguageRequirementKind.Preferred);
        return
            $"Required: {(required.Length == 0 ? "—" : required)}\n" +
            $"Preferred: {(preferred.Length == 0 ? "—" : preferred)}\n" +
            $"Decision: {job.LanguageDecision}\n" +
            $"Reason: {job.LanguageDecisionReason}";
    }
}
