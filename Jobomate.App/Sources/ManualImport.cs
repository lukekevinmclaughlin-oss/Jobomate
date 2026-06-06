using System;
using System.Collections.Generic;
using System.Linq;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>Imports postings the user pastes in: CSV, free text, or saved HTML. Pure + unit-tested.</summary>
public static class ManualImport
{
    public static IReadOnlyList<JobPosting> FromCsv(string csv)
    {
        var rows = ParseCsv(csv);
        if (rows.Count < 2) return Array.Empty<JobPosting>();

        var header = rows[0].Select(h => h.Trim().ToLowerInvariant()).ToList();
        int Idx(params string[] names) => header.FindIndex(h => names.Contains(h));

        int ci = Idx("company", "employer"), ti = Idx("title", "role", "position"),
            li = Idx("location", "ort"), ui = Idx("url", "link"), ei = Idx("email", "contact"),
            di = Idx("description", "desc"), wi = Idx("work", "worklocation", "remote"),
            si = Idx("start", "startdate"), langi = Idx("language", "languages", "sprache");

        var jobs = new List<JobPosting>();
        for (var r = 1; r < rows.Count; r++)
        {
            var cols = rows[r];
            string Get(int i) => i >= 0 && i < cols.Count ? cols[i].Trim() : "";

            var title = Get(ti);
            var company = Get(ci);
            if (title.Length == 0 && company.Length == 0) continue;

            var url = Get(ui);
            var email = Get(ei);
            var job = new JobPosting
            {
                Source = "Manual import (CSV)",
                Company = company,
                Title = title,
                Location = Get(li),
                SourceUrl = url,
                PortalUrl = string.IsNullOrWhiteSpace(email) ? url : "",
                ContactEmail = email,
                RawDescription = Get(di),
                StartDateRequirementText = Get(si),
                WorkLocation = ParseWork(Get(wi)),
                ConfidenceScore = 0.6,
            };

            foreach (var lang in Get(langi).Split(new[] { ';', '|', '/', ',' }, StringSplitOptions.RemoveEmptyEntries))
                job.LanguageRequirements.Add(new LanguageRequirement
                {
                    Language = lang.Trim(),
                    Kind = LanguageRequirementKind.Required,
                    Evidence = "Provided in CSV import",
                });

            jobs.Add(JobNormalization.Finalize(job));
        }
        return jobs;
    }

    public static JobPosting FromPastedText(string text, string? url = null)
    {
        var lines = (text ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var title = lines.FirstOrDefault() ?? "(pasted role — review)";
        var email = JobNormalization.ExtractFirstEmail(text);

        var job = new JobPosting
        {
            Source = "Manual import (text)",
            Title = title.Length > 140 ? title[..140] : title,
            RawDescription = (text ?? "").Trim(),
            SourceUrl = url ?? "",
            ContactEmail = email ?? "",
            PortalUrl = string.IsNullOrWhiteSpace(email) ? (url ?? "") : "",
            ConfidenceScore = 0.4,
            ExtractionNotes = "Imported from pasted text; review before sending.",
        };
        return JobNormalization.Finalize(job);
    }

    public static IReadOnlyList<JobPosting> FromHtml(string html, string sourceUrl)
    {
        var parsed = HtmlScraper.ParseJsonLdJobs(html, sourceUrl, "Manual import (HTML)");
        if (parsed.Count > 0) return parsed;

        var title = HtmlScraper.Title(html);
        return new[]
        {
            JobNormalization.Finalize(new JobPosting
            {
                Source = "Manual import (HTML)",
                SourceUrl = sourceUrl,
                Title = string.IsNullOrWhiteSpace(title) ? "(imported HTML — review)" : title,
                RawDescription = HtmlScraper.MetaDescription(html),
                PortalUrl = sourceUrl,
                ConfidenceScore = 0.4,
            }),
        };
    }

    private static WorkLocationType ParseWork(string w)
    {
        w = w.ToLowerInvariant();
        if (w.Contains("remote")) return WorkLocationType.Remote;
        if (w.Contains("hybrid")) return WorkLocationType.Hybrid;
        if (w.Contains("site") || w.Contains("office") || w.Contains("vor ort")) return WorkLocationType.OnSite;
        return WorkLocationType.Unclear;
    }

    /// <summary>Minimal RFC-4180-ish CSV parser (handles quoted fields and embedded commas/quotes).</summary>
    internal static List<List<string>> ParseCsv(string csv)
    {
        var rows = new List<List<string>>();
        if (string.IsNullOrWhiteSpace(csv)) return rows;

        var row = new List<string>();
        var field = new System.Text.StringBuilder();
        var inQuotes = false;

        for (var i = 0; i < csv.Length; i++)
        {
            var c = csv[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < csv.Length && csv[i + 1] == '"') { field.Append('"'); i++; }
                    else inQuotes = false;
                }
                else field.Append(c);
            }
            else
            {
                switch (c)
                {
                    case '"': inQuotes = true; break;
                    case ',': row.Add(field.ToString()); field.Clear(); break;
                    case '\r': break;
                    case '\n':
                        row.Add(field.ToString()); field.Clear();
                        rows.Add(row); row = new List<string>();
                        break;
                    default: field.Append(c); break;
                }
            }
        }
        if (field.Length > 0 || row.Count > 0)
        {
            row.Add(field.ToString());
            rows.Add(row);
        }
        return rows;
    }
}
