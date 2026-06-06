using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// User-provided job URLs. Tries JSON-LD, then page title/meta. Login-walled sites
/// (LinkedIn/Indeed/etc.) or blocked fetches are returned flagged for browser-assisted
/// extraction / manual portal application rather than guessed.
/// </summary>
public sealed class UrlImportJobSource : IJobSource
{
    private static readonly string[] LoginWalledHosts =
        { "linkedin.com", "indeed.", "glassdoor.", "stepstone.", "wellfound.com", "otta.com", "welcometothejungle." };

    private readonly HttpClient _http;
    public UrlImportJobSource(HttpClient http) => _http = http;

    public string Name => "Imported URLs";
    public bool RequiresConfiguration => true;

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var jobs = new List<JobPosting>();
        foreach (var url in request.JobUrls)
        {
            if (jobs.Count >= request.Limit) break;

            var html = await HtmlFetch.GetAsync(_http, url, ct).ConfigureAwait(false);
            if (html is null || HtmlScraper.LooksLoginWalled(html) || IsLoginWalled(url))
            {
                jobs.Add(JobNormalization.Finalize(NeedsBrowser(url)));
                continue;
            }

            var parsed = HtmlScraper.ParseJsonLdJobs(html, url, "Imported URL");
            if (parsed.Count > 0)
            {
                jobs.AddRange(parsed);
                continue;
            }

            // No JSON-LD: build a low-confidence posting from title/meta the user can review.
            var title = HtmlScraper.Title(html);
            jobs.Add(JobNormalization.Finalize(new JobPosting
            {
                Source = "Imported URL",
                SourceUrl = url,
                Company = HostOf(url),
                Title = string.IsNullOrWhiteSpace(title) ? "(imported role — review)" : title,
                RawDescription = HtmlScraper.MetaDescription(html),
                PortalUrl = url,
                ApplicationMethod = ApplicationMethod.Portal,
                ConfidenceScore = 0.35,
                ExtractionNotes = "No structured job data found; review manually.",
            }));
        }
        return jobs;
    }

    private static bool IsLoginWalled(string url)
    {
        var u = url.ToLowerInvariant();
        return Array.Exists(LoginWalledHosts, u.Contains);
    }

    private static JobPosting NeedsBrowser(string url) => new()
    {
        Source = "Imported URL",
        SourceUrl = url,
        Company = HostOf(url),
        Title = "(login-walled — use browser-assisted extraction)",
        PortalUrl = url,
        ApplicationMethod = ApplicationMethod.Portal,
        ConfidenceScore = 0.2,
        ExtractionNotes = "Site requires login/anti-bot. Use browser-assisted extraction (logged in) or apply manually on the portal.",
    };

    private static string HostOf(string url)
    {
        return Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host.Replace("www.", "") : "";
    }
}
