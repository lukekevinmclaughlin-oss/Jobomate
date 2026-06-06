using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// Greenhouse-hosted company boards (public JSON, no key):
/// https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true
/// </summary>
public sealed class GreenhouseJobSource : IJobSource
{
    private readonly HttpClient _http;
    public GreenhouseJobSource(HttpClient http) => _http = http;

    public string Name => "Greenhouse";
    public bool RequiresConfiguration => true; // needs company slugs

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var jobs = new List<JobPosting>();
        foreach (var slug in request.GreenhouseCompanies)
        {
            if (jobs.Count >= request.Limit) break;
            var url = $"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true";
            using var doc = await JsonHttp.GetAsync(_http, url, ct).ConfigureAwait(false);
            if (doc is null || !doc.RootElement.TryGetProperty("jobs", out var arr) || arr.ValueKind != JsonValueKind.Array)
                continue;

            var company = JsonX.Prettify(slug);
            foreach (var j in arr.EnumerateArray())
            {
                var title = JsonX.Str(j, "title");
                var location = JsonX.NestedStr(j, "location", "name");
                var apply = JsonX.Str(j, "absolute_url");
                var content = JobNormalization.StripHtml(WebUtility.HtmlDecode(JsonX.Str(j, "content")));

                if (!JobNormalization.MatchesKeywords(title + " " + content, request.Keywords)) continue;
                if (!JobNormalization.MatchesLocation(location, request.Location)) continue;

                jobs.Add(JobNormalization.Finalize(new JobPosting
                {
                    Source = "Greenhouse · " + company,
                    SourceUrl = apply,
                    Company = company,
                    Title = title,
                    Location = location,
                    RawDescription = content,
                    ApplicationMethod = ApplicationMethod.Portal,
                    PortalUrl = apply,
                    ConfidenceScore = 0.85,
                    DatePosted = JsonX.IsoDate(j, "updated_at"),
                }));
                if (jobs.Count >= request.Limit) break;
            }
        }
        return jobs;
    }
}
