using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>A normalized job search across every source.</summary>
public sealed class JobSearchRequest
{
    public string Keywords { get; set; } = "";
    public string Location { get; set; } = "";

    /// <summary>ISO country code for sources that need one (Adzuna, Bundesagentur).</summary>
    public string Country { get; set; } = "de";

    /// <summary>Empty = any work-location type.</summary>
    public List<WorkLocationType> WorkLocations { get; set; } = new();

    public List<string> AcceptedLanguages { get; set; } = new();
    public bool RemoteOnly { get; set; }
    public int Limit { get; set; } = 50;

    // Source-specific targets (resolved company boards / pages / URLs).
    public List<string> GreenhouseCompanies { get; set; } = new();
    public List<string> LeverCompanies { get; set; } = new();
    public List<string> CareerPageUrls { get; set; } = new();
    public List<string> JobUrls { get; set; } = new();

    /// <summary>Adzuna credentials (free) — supplied from the credential store when present.</summary>
    public string? AdzunaAppId { get; set; }
    public string? AdzunaAppKey { get; set; }
}

/// <summary>A normalized company-research request (unsolicited mode).</summary>
public sealed class CompanyResearchRequest
{
    public List<string> Industries { get; set; } = new();
    public List<string> Geographies { get; set; } = new();
    public List<string> AcceptedLanguages { get; set; } = new();
    public int Limit { get; set; } = 20;

    /// <summary>Optional explicit company names/domains to research (e.g. proposed by the LLM).</summary>
    public List<string> SeedCompanies { get; set; } = new();
}

/// <summary>A source of recent job postings.</summary>
public interface IJobSource
{
    string Name { get; }

    /// <summary>True when the source needs user-supplied config (keys/slugs/URLs) before it returns anything.</summary>
    bool RequiresConfiguration { get; }

    Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default);
}

/// <summary>A source that researches prospective employers (unsolicited mode).</summary>
public interface ICompanyResearchSource
{
    string Name { get; }

    Task<IReadOnlyList<CompanyTarget>> ResearchAsync(CompanyResearchRequest request, CancellationToken ct = default);
}
