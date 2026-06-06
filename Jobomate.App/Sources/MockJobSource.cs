using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// Curated offline sample postings so the whole workflow (filters → drafts → approval
/// → dry-run) can be exercised with no API keys, no network, and no LLM. Language
/// requirements are pre-classified with evidence so strict filtering works offline.
/// All contact addresses use non-routable .example domains.
/// </summary>
public sealed class MockJobSource : IJobSource
{
    public string Name => "Sample data (offline)";
    public bool RequiresConfiguration => false;

    public Task<IReadOnlyList<JobPosting>> SearchAsync(JobSearchRequest request, CancellationToken ct = default)
    {
        IEnumerable<JobPosting> q = Build();
        if (!string.IsNullOrWhiteSpace(request.Keywords))
        {
            q = q.Where(j => JobNormalization.MatchesKeywords(
                j.Title + " " + j.RawDescription + " " + string.Join(' ', j.LanguageRequirements.Select(l => l.Language)),
                request.Keywords));
        }
        var limit = request.Limit <= 0 ? 50 : request.Limit;
        return Task.FromResult<IReadOnlyList<JobPosting>>(q.Take(limit).ToList());
    }

    private static List<JobPosting> Build()
    {
        var jobs = new List<JobPosting>
        {
            Make("BioReach Labs", "Senior Growth Marketing Manager (Remote, EU)", "Remote · EU",
                WorkLocationType.Remote,
                "Drive AI-assisted growth for a B2B life-science scale-up. Fluent English required. Own SEO, paid, CRM and reporting.",
                lang: ("English", LanguageRequirementKind.Required, "Fluent English required."),
                contactEmail: "careers@bioreachlabs.example"),

            Make("MünchenBio GmbH", "Marketing Manager (m/w/d)", "München, Bayern",
                WorkLocationType.OnSite,
                "Wir suchen eine:n Marketing Manager:in. Verhandlungssichere Deutschkenntnisse erforderlich. Standort München, vor Ort.",
                lang: ("German", LanguageRequirementKind.Required, "Verhandlungssichere Deutschkenntnisse erforderlich."),
                contactEmail: "bewerbung@muenchenbio.example"),

            Make("Helix Therapeutics", "Digital Marketing Lead (Hybrid, Munich)", "Munich, Germany",
                WorkLocationType.Hybrid,
                "Business-fluent English is required. German is a plus. Hybrid, two days in office in Munich. Biotech marketing automation and demand gen.",
                lang: ("English", LanguageRequirementKind.Required, "Business-fluent English is required."),
                lang2: ("German", LanguageRequirementKind.Preferred, "German is a plus."),
                contactEmail: "talent@helixtx.example"),

            Make("GenomEU", "Performance Marketing Manager (Remote)", "Remote · Europe",
                WorkLocationType.Remote,
                "English required. Start date: as soon as possible. Paid acquisition across DACH life-science accounts.",
                lang: ("English", LanguageRequirementKind.Required, "English required."),
                startText: "Start date: as soon as possible.",
                earliestStart: new DateOnly(2026, 7, 1),
                portalUrl: "https://genomeu.example/careers/perf-marketing"),

            Make("CellSignal", "Marketing Operations Specialist (Remote)", "Remote",
                WorkLocationType.Remote,
                "Own marketing operations, HubSpot, and reporting for a fast-growing diagnostics company.",
                portalUrl: "https://cellsignal.example/jobs/marketing-ops"),

            Make("NeuroBytes", "Product Marketing Manager (Biotech)", "Berlin, Germany",
                WorkLocationType.OnSite,
                "Excellent English skills required. Position based on-site in Berlin. Life-science product marketing.",
                lang: ("English", LanguageRequirementKind.Required, "Excellent English skills required."),
                contactEmail: "jobs@neurobytes.example"),
        };

        return jobs.Select(JobNormalization.Finalize).ToList();
    }

    private static JobPosting Make(
        string company, string title, string location, WorkLocationType work, string description,
        (string Lang, LanguageRequirementKind Kind, string Evidence)? lang = null,
        (string Lang, LanguageRequirementKind Kind, string Evidence)? lang2 = null,
        string? contactEmail = null, string? portalUrl = null,
        string? startText = null, DateOnly? earliestStart = null)
    {
        var job = new JobPosting
        {
            Source = "Sample data (offline)",
            SourceUrl = portalUrl ?? "https://example.com/jobs/" + JobNormalization.NormalizeToken(company + title),
            Company = company,
            Title = title,
            Location = location,
            WorkLocation = work,
            RawDescription = description,
            ContactEmail = contactEmail ?? "",
            PortalUrl = portalUrl ?? "",
            StartDateRequirementText = startText ?? "",
            EarliestStart = earliestStart,
            ConfidenceScore = 0.95,
            DatePosted = DateOnly.FromDateTime(DateTime.UtcNow),
        };
        if (lang is { } l) job.LanguageRequirements.Add(new LanguageRequirement { Language = l.Lang, Kind = l.Kind, Evidence = l.Evidence });
        if (lang2 is { } l2) job.LanguageRequirements.Add(new LanguageRequirement { Language = l2.Lang, Kind = l2.Kind, Evidence = l2.Evidence });
        return job;
    }
}
