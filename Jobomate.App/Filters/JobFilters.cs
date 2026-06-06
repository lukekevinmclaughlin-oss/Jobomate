using System;
using System.Collections.Generic;
using System.Linq;
using Jobomate.Contracts;

namespace Jobomate.Filters;

/// <summary>Removes the same role appearing across multiple sources (keeps the highest-confidence copy).</summary>
public static class JobDeduplicator
{
    public static IReadOnlyList<JobPosting> Dedupe(IEnumerable<JobPosting> jobs)
    {
        return jobs
            .GroupBy(KeyOf)
            .Select(g => g.OrderByDescending(j => j.ConfidenceScore).First())
            .ToList();
    }

    private static string KeyOf(JobPosting j)
    {
        if (!string.IsNullOrEmpty(j.DedupKey)) return j.DedupKey;
        var company = new string((j.Company ?? "").ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
        var title = new string((j.Title ?? "").ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
        return company + "|" + title;
    }
}

/// <summary>Remote / Hybrid / On-site filtering with explicit handling of "unclear".</summary>
public static class WorkLocationFilter
{
    public static (bool Include, string Reason) Evaluate(
        WorkLocationType jobType, IReadOnlyCollection<WorkLocationType> accepted, bool includeUnclear)
    {
        if (accepted is null || accepted.Count == 0) return (true, "Any work location accepted.");

        if (jobType == WorkLocationType.Unclear)
            return includeUnclear
                ? (true, "Work location unclear — included per your setting.")
                : (false, "Work location unclear and excluded per your setting.");

        return accepted.Contains(jobType)
            ? (true, $"{jobType} matches your work-location preference.")
            : (false, $"{jobType} is not in your selected work locations.");
    }
}

/// <summary>
/// Detects start-date compatibility against the hard availability date (1 October 2026).
/// Earlier fixed/ASAP starts become a "Start-date risk".
/// </summary>
public static class StartDateEvaluator
{
    private static readonly string[] AsapTerms =
        { "immediately", "as soon as possible", "asap", "ab sofort", "sofort", "earliest possible", "immediate start", "start now", "zum nächstmöglichen" };

    public static StartDateRisk Evaluate(JobPosting job)
    {
        var available = JobomateConstants.AvailabilityDate;

        if (job.EarliestStart is { } start)
            return start < available ? StartDateRisk.Risk : StartDateRisk.Compatible;

        var text = (job.StartDateRequirementText ?? "").ToLowerInvariant();
        if (text.Length > 0)
        {
            if (AsapTerms.Any(text.Contains)) return StartDateRisk.Risk;
            if (DateOnly.TryParse(job.StartDateRequirementText, out var parsed))
                return parsed < available ? StartDateRisk.Risk : StartDateRisk.Compatible;
        }

        return StartDateRisk.Unknown;
    }
}

/// <summary>
/// Ranks postings. Start-date compatibility (vs 1 Oct 2026) and a clean language match
/// dominate, then LLM fit, extraction confidence, and recency.
/// </summary>
public static class JobRanker
{
    public static double Score(JobPosting j)
    {
        double s = 0;
        s += StartWeight(j.StartDateRisk) * 3.0;
        s += LanguageWeight(j.LanguageDecision) * 2.0;
        s += j.FitScore * 2.0;
        s += j.ConfidenceScore * 1.0;
        s += RecencyBonus(j.DatePosted) * 0.5;
        return s;
    }

    public static IReadOnlyList<JobPosting> Rank(IEnumerable<JobPosting> jobs)
    {
        var list = jobs.ToList();
        foreach (var j in list) j.RankScore = Score(j);
        return list
            .OrderByDescending(j => j.Included)
            .ThenByDescending(j => j.RankScore)
            .ToList();
    }

    private static double StartWeight(StartDateRisk r) => r switch
    {
        StartDateRisk.Compatible => 1.0,
        StartDateRisk.Unknown => 0.7,
        StartDateRisk.Risk => 0.2,
        StartDateRisk.Incompatible => 0.0,
        _ => 0.5,
    };

    private static double LanguageWeight(LanguageInclusionDecision d) => d switch
    {
        LanguageInclusionDecision.Included => 1.0,
        LanguageInclusionDecision.Flagged => 0.6,
        LanguageInclusionDecision.Excluded => 0.0,
        _ => 0.5,
    };

    private static double RecencyBonus(DateOnly? posted)
    {
        if (posted is null) return 0;
        var days = DateOnly.FromDateTime(DateTime.UtcNow).DayNumber - posted.Value.DayNumber;
        return days <= 30 ? 1.0 : days <= 90 ? 0.5 : 0.0;
    }
}

/// <summary>
/// Ties dedup, start-date, work-location, and language filtering together, then ranks.
/// Each posting comes out with its decision, reason, risk, inclusion flag, and rank set.
/// </summary>
public sealed class FilterPipeline
{
    public IReadOnlyList<JobPosting> Process(IEnumerable<JobPosting> jobs, SearchPreferences prefs)
    {
        var deduped = JobDeduplicator.Dedupe(jobs);

        foreach (var job in deduped)
        {
            job.StartDateRisk = StartDateEvaluator.Evaluate(job);

            var (decision, reason) = LanguageFilter.Evaluate(job.LanguageRequirements, prefs.AcceptedLanguages, prefs.LanguageMode);
            job.LanguageDecision = decision;
            job.LanguageDecisionReason = reason;

            var (workOk, _) = WorkLocationFilter.Evaluate(job.WorkLocation, prefs.WorkLocations, prefs.IncludeUnclearWorkLocation);
            var startOk = !(prefs.ExcludeStartDateRisk &&
                            job.StartDateRisk is StartDateRisk.Risk or StartDateRisk.Incompatible);

            job.Included = decision != LanguageInclusionDecision.Excluded && workOk && startOk;
        }

        return JobRanker.Rank(deduped);
    }
}
