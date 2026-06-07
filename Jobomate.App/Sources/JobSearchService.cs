using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Persistence;

namespace Jobomate.Sources;

/// <summary>
/// Aggregates the enabled job sources, runs them concurrently, and returns the combined
/// raw postings. Deduplication, language/location/start-date filtering, and ranking are
/// applied downstream by the filter pipeline.
/// </summary>
public sealed class JobSearchService
{
    private readonly IReadOnlyList<IJobSource> _sources;

    public JobSearchService(IEnumerable<IJobSource> sources) => _sources = sources.ToList();

    public IReadOnlyList<string> SourceNames => _sources.Select(s => s.Name).ToList();

    public IReadOnlyList<IJobSource> Sources => _sources;

    public async Task<IReadOnlyList<JobPosting>> SearchAsync(
        JobSearchRequest request, IEnumerable<string>? enabledSourceNames = null, CancellationToken ct = default)
    {
        var enabled = enabledSourceNames?.ToHashSet(System.StringComparer.OrdinalIgnoreCase);
        var active = enabled is null ? _sources : _sources.Where(s => enabled.Contains(s.Name)).ToList();

        var tasks = active.Select(async s =>
        {
            try { return await s.SearchAsync(request, ct).ConfigureAwait(false); }
            catch { return (IReadOnlyList<JobPosting>)System.Array.Empty<JobPosting>(); }
        });

        var batches = await Task.WhenAll(tasks).ConfigureAwait(false);
        return batches.SelectMany(b => b).ToList();
    }
}

/// <summary>Factory that wires the standard set of job sources.</summary>
public static class JobSources
{
    public static JobSearchService CreateDefault(
        HttpClient http, ICredentialStore? credentials = null)
    {
        var sources = new List<IJobSource>
        {
            new MockJobSource(),
            new ArbeitnowJobSource(http),
            new RemotiveJobSource(http),
            new BundesagenturJobSource(http),
            new GreenhouseJobSource(http),
            new LeverJobSource(http),
            new AdzunaJobSource(http),
            new CareerPageJobSource(http),
            new UrlImportJobSource(http),
        };
        return new JobSearchService(sources);
    }

    /// <summary>Fill Adzuna keys on a request from the credential store, when present.</summary>
    public static void ApplyAdzunaKeys(JobSearchRequest request, ICredentialStore? credentials)
    {
        if (credentials is null) return;
        request.AdzunaAppId ??= credentials.GetCloudToken("adzuna_app_id");
        request.AdzunaAppKey ??= credentials.GetCloudToken("adzuna_app_key");
    }
}
