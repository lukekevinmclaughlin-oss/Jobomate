using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// Bundesagentur für Arbeit (German Federal Employment Agency) jobsuche API.
/// Public client key, sent as the <c>X-API-Key</c> header.
/// </summary>
public sealed class BundesagenturJobSource : IJobSource
{
    private const string ApiKey = "jobboerse-jobsuche";
    private readonly HttpClient _http;
    public BundesagenturJobSource(HttpClient http) => _http = http;

    public string Name => "Bundesagentur für Arbeit";
    public bool RequiresConfiguration => false;

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var jobs = new List<JobPosting>();
        var size = request.Limit <= 0 ? 50 : request.Limit;
        var url =
            "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs" +
            $"?was={Uri.EscapeDataString(request.Keywords)}&wo={Uri.EscapeDataString(request.Location)}&size={size}";

        using var doc = await JsonHttp.GetAsync(_http, url, ct, ("X-API-Key", ApiKey)).ConfigureAwait(false);
        if (doc is null || !doc.RootElement.TryGetProperty("stellenangebote", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return jobs;

        foreach (var j in arr.EnumerateArray())
        {
            var title = JsonX.Str(j, "titel");
            var company = JsonX.Str(j, "arbeitgeber");
            var location = JsonX.NestedStr(j, "arbeitsort", "ort");
            var refnr = JsonX.Str(j, "refnr");
            var external = JsonX.Str(j, "externeUrl");
            var startText = JsonX.Str(j, "eintrittsdatum");

            var detailUrl = !string.IsNullOrWhiteSpace(external)
                ? external
                : "https://www.arbeitsagentur.de/jobsuche/jobdetail/" + Uri.EscapeDataString(refnr);

            jobs.Add(JobNormalization.Finalize(new JobPosting
            {
                Source = Name,
                SourceUrl = detailUrl,
                Company = company,
                Title = title,
                Location = location,
                RawDescription = JsonX.Str(j, "beruf"),
                StartDateRequirementText = startText,
                EarliestStart = JsonX.IsoDate(j, "eintrittsdatum"),
                ApplicationMethod = ApplicationMethod.Portal,
                PortalUrl = detailUrl,
                ConfidenceScore = 0.75,
            }));
            if (jobs.Count >= size) break;
        }
        return jobs;
    }
}
