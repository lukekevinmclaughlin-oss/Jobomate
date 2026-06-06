using System;
using System.Linq;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>Detects the applicant-tracking system (and board slug) behind a careers URL.</summary>
public static class AtsDetector
{
    public static (AtsKind Kind, string Slug) Detect(string? url)
    {
        var u = (url ?? "").ToLowerInvariant();
        if (u.Length == 0) return (AtsKind.Unknown, "");

        if (u.Contains("greenhouse.io"))
            return (AtsKind.Greenhouse, SlugAfter(u, "boards.greenhouse.io/", "job-boards.greenhouse.io/", "boards-api.greenhouse.io/v1/boards/"));
        if (u.Contains("lever.co"))
            return (AtsKind.Lever, SlugAfter(u, "jobs.lever.co/", "api.lever.co/v0/postings/"));
        if (u.Contains("personio."))
            return (AtsKind.Personio, "");
        if (u.Contains("myworkdayjobs.com") || u.Contains(".workday."))
            return (AtsKind.Workday, "");

        return (AtsKind.Unknown, "");
    }

    private static string SlugAfter(string url, params string[] markers)
    {
        foreach (var marker in markers)
        {
            var i = url.IndexOf(marker, StringComparison.Ordinal);
            if (i < 0) continue;
            var rest = url[(i + marker.Length)..];
            var slug = rest.Split('/', '?', '#').FirstOrDefault(s => s.Length > 0) ?? "";
            if (slug.Length > 0) return slug;
        }
        return "";
    }
}
