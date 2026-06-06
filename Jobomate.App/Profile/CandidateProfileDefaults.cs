using Jobomate.Contracts;

namespace Jobomate.Profile;

/// <summary>
/// The known candidate background. Used both as the seed for a parsed profile and
/// as the fallback when CV parsing fails or yields too little text. Single source of
/// truth for the honest facts (10+ yrs, biotech marketing, English native / German
/// <b>intermediate</b>, available from 1 October 2026).
/// </summary>
public static class CandidateProfileDefaults
{
    public static CandidateProfile Known() => new()
    {
        Id = "profile",
        FullName = "Luke McLaughlin",
        Headline = "AI-driven growth & B2B biotech / life-science marketing",
        Location = "Munich, Germany",
        Summary =
            "Growth and digital-marketing leader with 10+ years across B2B biotech and life sciences: " +
            "AI-driven growth, SEO, paid campaigns, CRM, marketing automation, AI workflows, market " +
            "intelligence, and reporting.",
        YearsExperience = 10,
        Skills =
        {
            "AI-driven growth", "Digital marketing", "Business development",
            "B2B biotech & life-science marketing", "SEO", "Paid campaigns", "CRM",
            "Marketing automation", "AI workflows", "Market intelligence", "Reporting",
        },
        Industries = { "Biotech", "Life sciences" },
        Tools =
        {
            "LLM workflows", "GA4", "Looker Studio", "Search Console", "SEMrush", "Ahrefs",
            "ActiveCampaign", "HubSpot", "LinkedIn Sales Navigator", "Python", "JavaScript / Node",
            "Vite", "Docker", "WordPress", "Affinity / Adobe", "DaVinci Resolve",
        },
        Education = { "MSc Molecular Biology", "BSc Life Sciences" },
        Languages =
        {
            new CandidateLanguage { Language = "English", Level = "native" },
            new CandidateLanguage { Language = "German", Level = JobomateConstants.GermanLevel },
        },
        AvailabilityFrom = JobomateConstants.AvailabilityDate,
        FromFallback = true,
    };
}
