using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// Adzuna jobs API (free app_id + app_key, supplied from the credential store).
/// https://api.adzuna.com/v1/api/jobs/{country}/search/1
/// </summary>
public sealed class AdzunaJobSource : IJobSource
{
    private readonly HttpClient _http;
    public AdzunaJobSource(HttpClient http) => _http = http;

    public string Name => "Adzuna";
    public bool RequiresConfiguration => true; // needs app_id/app_key

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var jobs = new List<JobPosting>();
        if (string.IsNullOrWhiteSpace(request.AdzunaAppId) || string.IsNullOrWhiteSpace(request.AdzunaAppKey))
            return jobs; // not configured

        var country = string.IsNullOrWhiteSpace(request.Country) ? "de" : request.Country.ToLowerInvariant();
        var limit = request.Limit <= 0 ? 50 : request.Limit;
        var url =
            $"https://api.adzuna.com/v1/api/jobs/{country}/search/1?app_id={Uri.EscapeDataString(request.AdzunaAppId!)}" +
            $"&app_key={Uri.EscapeDataString(request.AdzunaAppKey!)}&results_per_page={limit}" +
            $"&what={Uri.EscapeDataString(request.Keywords)}&where={Uri.EscapeDataString(request.Location)}&content-type=application/json";

        using var doc = await JsonHttp.GetAsync(_http, url, ct).ConfigureAwait(false);
        if (doc is null || !doc.RootElement.TryGetProperty("results", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return jobs;

        foreach (var j in arr.EnumerateArray())
        {
            var title = JsonX.Str(j, "title");
            var company = JsonX.NestedStr(j, "company", "display_name");
            var location = JsonX.NestedStr(j, "location", "display_name");
            var redirect = JsonX.Str(j, "redirect_url");
            var desc = JobNormalization.StripHtml(JsonX.Str(j, "description"));

            jobs.Add(JobNormalization.Finalize(new JobPosting
            {
                Source = Name,
                SourceUrl = redirect,
                Company = company,
                Title = title,
                Location = location,
                RawDescription = desc,
                ApplicationMethod = ApplicationMethod.Portal,
                PortalUrl = redirect,
                ConfidenceScore = 0.7,
                DatePosted = JsonX.IsoDate(j, "created"),
            }));
            if (jobs.Count >= limit) break;
        }
        return jobs;
    }
}
