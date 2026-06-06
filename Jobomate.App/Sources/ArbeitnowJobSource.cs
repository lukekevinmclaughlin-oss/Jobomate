using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>Public Arbeitnow job board feed (no API key). https://www.arbeitnow.com/api/job-board-api</summary>
public sealed class ArbeitnowJobSource : IJobSource
{
    private readonly HttpClient _http;
    public ArbeitnowJobSource(HttpClient http) => _http = http;

    public string Name => "Arbeitnow";
    public bool RequiresConfiguration => false;

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var jobs = new List<JobPosting>();
        using var doc = await JsonHttp.GetAsync(_http, "https://www.arbeitnow.com/api/job-board-api", ct).ConfigureAwait(false);
        if (doc is null || !doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            return jobs;

        foreach (var j in data.EnumerateArray())
        {
            var title = JsonX.Str(j, "title");
            var company = JsonX.Str(j, "company_name");
            var location = JsonX.Str(j, "location");
            var url = JsonX.Str(j, "url");
            var desc = JobNormalization.StripHtml(JsonX.Str(j, "description"));
            var remote = j.TryGetProperty("remote", out var r) && r.ValueKind == JsonValueKind.True;

            if (!JobNormalization.MatchesKeywords(title + " " + desc, request.Keywords)) continue;
            if (!JobNormalization.MatchesLocation(location, request.Location, remote)) continue;

            jobs.Add(JobNormalization.Finalize(new JobPosting
            {
                Source = Name,
                SourceUrl = url,
                Company = company,
                Title = title,
                Location = location,
                WorkLocation = remote ? WorkLocationType.Remote : WorkLocationType.Unclear,
                RawDescription = desc,
                ApplicationMethod = ApplicationMethod.Portal,
                PortalUrl = url,
                ConfidenceScore = 0.7,
                DatePosted = JsonX.UnixDate(j, "created_at"),
            }));
            if (jobs.Count >= request.Limit) break;
        }
        return jobs;
    }
}
