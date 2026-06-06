using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// Direct company career pages. If the page is a Greenhouse/Lever board it uses that
/// public API; otherwise it parses schema.org JSON-LD from the page HTML and harvests
/// any published recruiting email so the role can be applied to by email.
/// </summary>
public sealed class CareerPageJobSource : IJobSource
{
    private readonly HttpClient _http;
    public CareerPageJobSource(HttpClient http) => _http = http;

    public string Name => "Company career pages";
    public bool RequiresConfiguration => true; // needs career-page URLs

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        var jobs = new List<JobPosting>();
        foreach (var url in request.CareerPageUrls)
        {
            if (jobs.Count >= request.Limit) break;

            var (kind, slug) = AtsDetector.Detect(url);
            if (kind == AtsKind.Greenhouse && slug.Length > 0)
            {
                jobs.AddRange(await new GreenhouseJobSource(_http).SearchAsync(With(request, gh: slug), ct).ConfigureAwait(false));
                continue;
            }
            if (kind == AtsKind.Lever && slug.Length > 0)
            {
                jobs.AddRange(await new LeverJobSource(_http).SearchAsync(With(request, lv: slug), ct).ConfigureAwait(false));
                continue;
            }

            var html = await HtmlFetch.GetAsync(_http, url, ct).ConfigureAwait(false);
            if (html is null) continue;

            var parsed = HtmlScraper.ParseJsonLdJobs(html, url, "Career page");
            var pageEmails = HtmlScraper.Emails(html);
            foreach (var j in parsed)
            {
                if (jobs.Count >= request.Limit) break;
                if (!JobNormalization.MatchesKeywords(j.Title + " " + j.RawDescription, request.Keywords)) continue;

                if (string.IsNullOrWhiteSpace(j.ContactEmail) && pageEmails.Count > 0)
                {
                    j.ContactEmail = PickRecruitingEmail(pageEmails);
                    j.ApplicationMethod = ApplicationMethod.Email;
                }
                jobs.Add(JobNormalization.Finalize(j));
            }
        }
        return jobs;
    }

    private static string PickRecruitingEmail(IReadOnlyList<string> emails)
    {
        foreach (var prefer in new[] { "jobs@", "careers@", "career@", "bewerbung@", "recruiting@", "talent@", "hr@", "people@" })
            foreach (var e in emails)
                if (e.StartsWith(prefer, System.StringComparison.OrdinalIgnoreCase))
                    return e;
        return emails[0];
    }

    private static JobSearchRequest With(JobSearchRequest request, string? gh = null, string? lv = null) => new()
    {
        Keywords = request.Keywords,
        Location = request.Location,
        Country = request.Country,
        Limit = request.Limit,
        GreenhouseCompanies = gh is null ? new() : new() { gh },
        LeverCompanies = lv is null ? new() : new() { lv },
    };
}
