using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// Pure helpers shared by every source: work-location classification, dedup keys,
/// HTML→text, email extraction, and light keyword/location matching. Kept pure so
/// the normalization is unit-tested without any network.
/// </summary>
public static class JobNormalization
{
    private static readonly string[] HybridTerms =
        { "hybrid", "teilweise remote", "partially remote", "remote-friendly", "days in office", "days per week in" };

    private static readonly string[] RemoteTerms =
        { "fully remote", "100% remote", "remote", "home office", "homeoffice", "work from home", "telecommute", "ortsunabhängig" };

    private static readonly string[] OnSiteTerms =
        { "on-site", "on site", "onsite", "vor ort", "in office", "in-office", "presence required", "relocation" };

    private static readonly Regex EmailRegex =
        new(@"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", RegexOptions.Compiled);

    private static readonly Regex HtmlTag = new("<[^>]+>", RegexOptions.Compiled);

    public static (WorkLocationType Type, string Evidence) ClassifyWorkLocation(string? text)
    {
        var t = (text ?? "").ToLowerInvariant();
        if (t.Length == 0) return (WorkLocationType.Unclear, "");

        foreach (var term in HybridTerms)
            if (t.Contains(term)) return (WorkLocationType.Hybrid, term);
        foreach (var term in RemoteTerms)
            if (t.Contains(term)) return (WorkLocationType.Remote, term);
        foreach (var term in OnSiteTerms)
            if (t.Contains(term)) return (WorkLocationType.OnSite, term);

        return (WorkLocationType.Unclear, "");
    }

    /// <summary>Stable key used to deduplicate the same role coming from multiple sources.</summary>
    public static string BuildDedupKey(string company, string title, string? location = null)
    {
        var key = NormalizeToken(company) + "|" + NormalizeToken(title);
        return key;
    }

    /// <summary>Lowercase, strip everything but a-z0-9, used for fuzzy company/title equality.</summary>
    public static string NormalizeToken(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        var lowered = s.ToLowerInvariant();
        var chars = lowered.Where(char.IsLetterOrDigit).ToArray();
        return new string(chars);
    }

    public static string StripHtml(string? html)
    {
        if (string.IsNullOrWhiteSpace(html)) return "";
        var noTags = HtmlTag.Replace(html, " ");
        noTags = System.Net.WebUtility.HtmlDecode(noTags);
        return Regex.Replace(noTags, @"\s+", " ").Trim();
    }

    public static string? ExtractFirstEmail(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var m = EmailRegex.Match(text);
        return m.Success ? m.Value : null;
    }

    public static IReadOnlyList<string> ExtractEmails(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return Array.Empty<string>();
        return EmailRegex.Matches(text).Select(m => m.Value).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    public static bool MatchesKeywords(string text, string keywords)
    {
        if (string.IsNullOrWhiteSpace(keywords)) return true;
        var hay = (text ?? "").ToLowerInvariant();
        var tokens = keywords.ToLowerInvariant()
            .Split(new[] { ' ', ',', ';' }, StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length > 2);
        return tokens.Any(hay.Contains);
    }

    public static bool MatchesLocation(string jobLocation, string requested, bool jobIsRemote = false)
    {
        if (string.IsNullOrWhiteSpace(requested)) return true;
        if (jobIsRemote) return true;
        var job = (jobLocation ?? "").ToLowerInvariant();
        var req = requested.ToLowerInvariant();
        if (job.Contains(req) || req.Contains(job) && job.Length > 2) return true;

        // Broad geographies always match.
        if (req is "germany" or "deutschland" or "eu" or "europe" or "worldwide" or "remote") return true;
        return false;
    }

    /// <summary>Fill in derived fields after a source maps its raw payload.</summary>
    public static JobPosting Finalize(JobPosting job)
    {
        if (job.WorkLocation == WorkLocationType.Unclear)
        {
            var (type, evidence) = ClassifyWorkLocation(job.Title + " " + job.Location + " " + job.RawDescription);
            job.WorkLocation = type;
            if (job.WorkLocationEvidence.Length == 0) job.WorkLocationEvidence = evidence;
        }

        if (job.ApplicationMethod == ApplicationMethod.Unknown)
        {
            if (!string.IsNullOrWhiteSpace(job.ContactEmail)) job.ApplicationMethod = ApplicationMethod.Email;
            else if (!string.IsNullOrWhiteSpace(job.PortalUrl) || !string.IsNullOrWhiteSpace(job.SourceUrl))
                job.ApplicationMethod = ApplicationMethod.Portal;
        }

        if (string.IsNullOrWhiteSpace(job.PortalUrl) && job.ApplicationMethod == ApplicationMethod.Portal)
            job.PortalUrl = job.SourceUrl;

        job.DedupKey = BuildDedupKey(job.Company, job.Title, job.Location);
        return job;
    }
}
