using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using AngleSharp.Html.Parser;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// AngleSharp-backed HTML scraping. The primary extractor is schema.org JSON-LD
/// <c>JobPosting</c> (emitted by most career pages and ATS portals); falls back to
/// page title/meta. Pure (no network) so the JSON-LD mapping is unit-tested.
/// </summary>
public static class HtmlScraper
{
    private static readonly HtmlParser Parser = new();

    public static IReadOnlyList<JobPosting> ParseJsonLdJobs(string html, string sourceUrl, string sourceName)
    {
        var results = new List<JobPosting>();
        if (string.IsNullOrWhiteSpace(html)) return results;

        using var doc = Parser.ParseDocument(html);
        foreach (var script in doc.QuerySelectorAll("script[type='application/ld+json']"))
        {
            var json = script.TextContent;
            if (string.IsNullOrWhiteSpace(json)) continue;
            try
            {
                using var jd = JsonDocument.Parse(json);
                Collect(jd.RootElement, sourceUrl, sourceName, results);
            }
            catch { /* malformed JSON-LD block */ }
        }
        return results;
    }

    public static string Title(string html)
    {
        if (string.IsNullOrWhiteSpace(html)) return "";
        using var doc = Parser.ParseDocument(html);
        return doc.Title?.Trim() ?? "";
    }

    public static string MetaDescription(string html)
    {
        if (string.IsNullOrWhiteSpace(html)) return "";
        using var doc = Parser.ParseDocument(html);
        var meta = doc.QuerySelector("meta[name='description']") ?? doc.QuerySelector("meta[property='og:description']");
        return meta?.GetAttribute("content")?.Trim() ?? "";
    }

    public static IReadOnlyList<string> Emails(string html)
    {
        if (string.IsNullOrWhiteSpace(html)) return Array.Empty<string>();
        using var doc = Parser.ParseDocument(html);
        var found = new List<string>();
        foreach (var a in doc.QuerySelectorAll("a[href^='mailto:']"))
        {
            var href = a.GetAttribute("href") ?? "";
            var email = href.Replace("mailto:", "", StringComparison.OrdinalIgnoreCase).Split('?')[0].Trim();
            if (email.Length > 0) found.Add(email);
        }
        found.AddRange(JobNormalization.ExtractEmails(doc.Body?.TextContent));
        return found.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    public static bool LooksLoginWalled(string html)
    {
        var t = (html ?? "").ToLowerInvariant();
        return t.Contains("sign in to continue") || t.Contains("please verify you are a human") ||
               t.Contains("captcha") || t.Contains("enable javascript and cookies to continue") ||
               t.Contains("log in to view") || t.Contains("authwall");
    }

    private static void Collect(JsonElement el, string sourceUrl, string sourceName, List<JobPosting> output)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Array:
                foreach (var item in el.EnumerateArray()) Collect(item, sourceUrl, sourceName, output);
                return;
            case JsonValueKind.Object:
                if (el.TryGetProperty("@graph", out var graph)) Collect(graph, sourceUrl, sourceName, output);
                if (TypeOf(el).Equals("JobPosting", StringComparison.OrdinalIgnoreCase))
                    output.Add(Map(el, sourceUrl, sourceName));
                return;
        }
    }

    private static string TypeOf(JsonElement el)
    {
        if (!el.TryGetProperty("@type", out var t)) return "";
        if (t.ValueKind == JsonValueKind.String) return t.GetString() ?? "";
        if (t.ValueKind == JsonValueKind.Array && t.GetArrayLength() > 0) return t[0].GetString() ?? "";
        return "";
    }

    private static JobPosting Map(JsonElement el, string sourceUrl, string sourceName)
    {
        var desc = JobNormalization.StripHtml(JsonX.Str(el, "description"));
        var email = JobNormalization.ExtractFirstEmail(desc);
        var url = JsonX.Str(el, "url");
        if (string.IsNullOrWhiteSpace(url)) url = sourceUrl;

        var job = new JobPosting
        {
            Source = sourceName,
            SourceUrl = url,
            Company = JsonX.NestedStr(el, "hiringOrganization", "name"),
            Title = JsonX.Str(el, "title"),
            Location = ExtractLocation(el),
            WorkLocation = IndicatesRemote(el) ? WorkLocationType.Remote : WorkLocationType.Unclear,
            RawDescription = desc,
            ContactEmail = email ?? "",
            PortalUrl = string.IsNullOrEmpty(email) ? url : "",
            ApplicationMethod = string.IsNullOrEmpty(email) ? ApplicationMethod.Portal : ApplicationMethod.Email,
            StartDateRequirementText = JsonX.Str(el, "jobStartDate"),
            EarliestStart = JsonX.IsoDate(el, "jobStartDate"),
            ConfidenceScore = 0.8,
            DatePosted = JsonX.IsoDate(el, "datePosted"),
        };
        return JobNormalization.Finalize(job);
    }

    private static bool IndicatesRemote(JsonElement el)
    {
        var lt = JsonX.Str(el, "jobLocationType");
        return lt.Contains("TELECOMMUTE", StringComparison.OrdinalIgnoreCase);
    }

    private static string ExtractLocation(JsonElement el)
    {
        if (!el.TryGetProperty("jobLocation", out var loc)) return "";
        if (loc.ValueKind == JsonValueKind.Array && loc.GetArrayLength() > 0) loc = loc[0];
        if (loc.ValueKind != JsonValueKind.Object) return "";
        if (!loc.TryGetProperty("address", out var addr) || addr.ValueKind != JsonValueKind.Object) return "";

        var parts = new[]
        {
            JsonX.Str(addr, "addressLocality"),
            JsonX.Str(addr, "addressRegion"),
            JsonX.Str(addr, "addressCountry"),
        }.Where(s => !string.IsNullOrWhiteSpace(s));
        return string.Join(", ", parts);
    }
}
