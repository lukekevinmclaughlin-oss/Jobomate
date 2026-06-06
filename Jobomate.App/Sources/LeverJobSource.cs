using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// Lever-hosted company boards (public JSON, no key):
/// https://api.lever.co/v0/postings/{company}?mode=json
/// </summary>
public sealed class LeverJobSource : IJobSource
{
    private readonly HttpClient _http;
    public LeverJobSource(HttpClient http) => _http = http;

    public string Name => "Lever";
    public bool RequiresConfiguration => true; // needs company slugs

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var jobs = new List<JobPosting>();
        foreach (var slug in request.LeverCompanies)
        {
            if (jobs.Count >= request.Limit) break;
            var url = $"https://api.lever.co/v0/postings/{slug}?mode=json";
            using var doc = await JsonHttp.GetAsync(_http, url, ct).ConfigureAwait(false);
            if (doc is null || doc.RootElement.ValueKind != JsonValueKind.Array) continue;

            var company = JsonX.Prettify(slug);
            foreach (var j in doc.RootElement.EnumerateArray())
            {
                var title = JsonX.Str(j, "text");
                var location = JsonX.NestedStr(j, "categories", "location");
                var commitment = JsonX.NestedStr(j, "categories", "commitment");
                var apply = JsonX.Str(j, "hostedUrl");
                var desc = JobNormalization.StripHtml(JsonX.Str(j, "descriptionPlain"));
                if (string.IsNullOrWhiteSpace(desc)) desc = JobNormalization.StripHtml(JsonX.Str(j, "description"));

                if (!JobNormalization.MatchesKeywords(title + " " + desc, request.Keywords)) continue;
                if (!JobNormalization.MatchesLocation(location, request.Location)) continue;

                jobs.Add(JobNormalization.Finalize(new JobPosting
                {
                    Source = "Lever · " + company,
                    SourceUrl = apply,
                    Company = company,
                    Title = title,
                    Location = string.IsNullOrWhiteSpace(commitment) ? location : $"{location} · {commitment}",
                    RawDescription = desc,
                    ApplicationMethod = ApplicationMethod.Portal,
                    PortalUrl = apply,
                    ConfidenceScore = 0.85,
                }));
                if (jobs.Count >= request.Limit) break;
            }
        }
        return jobs;
    }
}
