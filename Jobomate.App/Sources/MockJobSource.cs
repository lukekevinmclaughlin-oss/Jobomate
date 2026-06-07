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
        // Profession-agnostic sample postings spanning software, data, design, content, sales,
        // product and finance — with mixed language / start-date / contact-email situations so the
        // strict filters demonstrate include/exclude regardless of the candidate's field.
        var jobs = new List<JobPosting>
        {
            Make("Northwind Systems", "Senior Software Engineer (Backend, Remote EU)", "Remote · EU",
                WorkLocationType.Remote,
                "Design and ship backend services in Go and Python. Fluent English required. Ownership of APIs, reliability and CI/CD.",
                lang: ("English", LanguageRequirementKind.Required, "Fluent English required."),
                contactEmail: "careers@northwind.example"),

            Make("Orbit Sales", "Business Development Representative (Remote, EU)", "Remote · EU",
                WorkLocationType.Remote,
                "Drive outbound pipeline and qualify inbound leads for a B2B SaaS platform. Excellent English required.",
                lang: ("English", LanguageRequirementKind.Required, "Excellent English required."),
                contactEmail: "talent@orbitsales.example"),

            Make("Atlas Robotics", "Product Manager (Hybrid, Berlin)", "Berlin, Germany",
                WorkLocationType.Hybrid,
                "Own the product roadmap for our automation suite. Business-fluent English required; German is a plus. Two days a week in Berlin.",
                lang: ("English", LanguageRequirementKind.Required, "Business-fluent English required."),
                lang2: ("German", LanguageRequirementKind.Preferred, "German is a plus."),
                contactEmail: "jobs@atlasrobotics.example"),

            Make("Vega Analytics", "Data Analyst (Remote)", "Remote · Europe",
                WorkLocationType.Remote,
                "SQL, dbt and dashboarding for a fast-growing analytics company. English required. Start date: as soon as possible.",
                lang: ("English", LanguageRequirementKind.Required, "English required."),
                startText: "Start date: as soon as possible.",
                earliestStart: new DateOnly(2026, 7, 1),
                portalUrl: "https://vega-analytics.example/careers/data-analyst"),

            Make("Pixelforge", "UX/UI Designer (Remote)", "Remote",
                WorkLocationType.Remote,
                "Design web and mobile interfaces in Figma; partner with engineering on a design system.",
                portalUrl: "https://pixelforge.example/jobs/ux-designer"),

            Make("Lumen Studios", "Content Creator / Social Media (Remote)", "Remote",
                WorkLocationType.Remote,
                "Create short-form video and written content across channels. Excellent English skills required.",
                lang: ("English", LanguageRequirementKind.Required, "Excellent English skills required."),
                contactEmail: "hello@lumenstudios.example"),

            Make("Cobalt Cloud", "DevOps Engineer (Remote)", "Remote · EU",
                WorkLocationType.Remote,
                "Kubernetes, Terraform and CI/CD for a cloud-native platform. English required.",
                lang: ("English", LanguageRequirementKind.Required, "English required."),
                contactEmail: "careers@cobaltcloud.example"),

            Make("Meridian Bank GmbH", "Kundenberater:in (m/w/d)", "München, Bayern",
                WorkLocationType.OnSite,
                "Wir suchen eine:n Kundenberater:in. Verhandlungssichere Deutschkenntnisse erforderlich. Standort München, vor Ort.",
                lang: ("German", LanguageRequirementKind.Required, "Verhandlungssichere Deutschkenntnisse erforderlich."),
                contactEmail: "bewerbung@meridianbank.example"),
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
