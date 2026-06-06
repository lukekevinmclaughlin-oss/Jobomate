using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>Public Remotive remote-jobs API (no key). https://remotive.com/api/remote-jobs</summary>
public sealed class RemotiveJobSource : IJobSource
{
    private readonly HttpClient _http;
    public RemotiveJobSource(HttpClient http) => _http = http;

    public string Name => "Remotive";
    public bool RequiresConfiguration => false;

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var jobs = new List<JobPosting>();
        var url = "https://remotive.com/api/remote-jobs?limit=" + (request.Limit <= 0 ? 50 : request.Limit);
        if (!string.IsNullOrWhiteSpace(request.Keywords))
            url += "&search=" + Uri.EscapeDataString(request.Keywords);

        using var doc = await JsonHttp.GetAsync(_http, url, ct).ConfigureAwait(false);
        if (doc is null || !doc.RootElement.TryGetProperty("jobs", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return jobs;

        foreach (var j in arr.EnumerateArray())
        {
            var title = JsonX.Str(j, "title");
            var company = JsonX.Str(j, "company_name");
            var location = JsonX.Str(j, "candidate_required_location");
            var link = JsonX.Str(j, "url");
            var desc = JobNormalization.StripHtml(JsonX.Str(j, "description"));

            jobs.Add(JobNormalization.Finalize(new JobPosting
            {
                Source = Name,
                SourceUrl = link,
                Company = company,
                Title = title,
                Location = string.IsNullOrWhiteSpace(location) ? "Remote" : location,
                WorkLocation = WorkLocationType.Remote,
                WorkLocationEvidence = "Remotive lists remote-only roles.",
                RawDescription = desc,
                ApplicationMethod = ApplicationMethod.Portal,
                PortalUrl = link,
                ConfidenceScore = 0.7,
                DatePosted = JsonX.IsoDate(j, "publication_date"),
            }));
            if (jobs.Count >= request.Limit) break;
        }
        return jobs;
    }
}
