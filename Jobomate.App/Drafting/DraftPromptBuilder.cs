using System.Collections.Generic;
using System.Linq;
using Jobomate.Contracts;
using Jobomate.Llm;

namespace Jobomate.Drafting;

/// <summary>
/// Builds the LLM prompts for application emails and cover letters. Pure and unit-tested:
/// every prompt states the candidate's availability, restricts the model to the CV
/// facts, caps German at intermediate, and — by construction — contains none of the
/// forbidden topics (layoffs, health, private circumstances).
/// </summary>
public static class DraftPromptBuilder
{
    /// <summary>Active app mode — set from preferences. In recruiter mode the prompts flip to
    /// candidate outreach (the "profile" is the role brief, the "job" row is a sourced candidate).</summary>
    public static AppMode Mode = AppMode.JobSeeker;

    public static IReadOnlyList<ChatMessage> EmailPrompt(CandidateProfile profile, JobPosting job) =>
        Mode == AppMode.Recruiter ? RecruiterOutreachPrompt(profile, job) : new[]
    {
        new ChatMessage("system", SystemGuardrails()),
        new ChatMessage("user",
            "Write a concise, specific application email for this role.\n\n" +
            "CANDIDATE (use only these facts):\n" + ProfileBlock(profile) + "\n\n" +
            "ROLE:\n" + RoleBlock(job) + "\n\n" +
            "REQUIREMENTS:\n" +
            "- A clear subject line naming the role and company.\n" +
            "- A short body (about 120–160 words) explaining the fit using only the facts above.\n" +
            $"- State the candidate's availability ({profile.AvailabilityText}).\n" +
            "- Note that the CV is attached.\n" +
            "- Warm, professional, no clichés. " + LanguageRule(profile) + "\n\n" +
            "Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}."),
    };

    /// <summary>Recruiter → candidate outreach. The "profile" is the role the recruiter is hiring for;
    /// the "job" row is a sourced candidate (Title = their headline, Company = current employer).</summary>
    private static IReadOnlyList<ChatMessage> RecruiterOutreachPrompt(CandidateProfile role, JobPosting candidate) => new[]
    {
        new ChatMessage("system", RecruiterGuardrails()),
        new ChatMessage("user",
            "Write a short, personalised recruiting outreach email inviting this candidate to consider an open role.\n\n" +
            "THE ROLE WE ARE HIRING FOR (use only these facts; do not overstate):\n" + RoleBriefBlock(role) + "\n\n" +
            "THE CANDIDATE (what we found; never invent skills or experience they didn't show):\n" + CandidateBlock(candidate) + "\n\n" +
            "REQUIREMENTS:\n" +
            "- A clear, non-spammy subject line referencing the role.\n" +
            "- A short body (about 90–140 words): a genuine reason we reached out (tie to something in their background), a one-line pitch of the role, and a low-pressure call to a brief chat.\n" +
            "- Respect their time and privacy; no flattery clichés, no fake urgency, no salary promises unless given.\n" +
            "- Warm, professional, human.\n\n" +
            "Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}."),
    };

    public static IReadOnlyList<ChatMessage> CoverLetterPrompt(CandidateProfile profile, JobPosting job) =>
        Mode == AppMode.Recruiter ? new[]
        {
            new ChatMessage("system", RecruiterGuardrails()),
            new ChatMessage("user",
                "Write a short one-page role overview a recruiter could share with a candidate.\n\n" +
                "THE ROLE (use only these facts; do not overstate):\n" + RoleBriefBlock(profile) + "\n\n" +
                "REQUIREMENTS:\n" +
                "- 3–4 short paragraphs: what the role is, who it suits, and why it's worth a conversation.\n" +
                "- Ground every claim in the facts above; invent nothing. Professional and warm.\n\n" +
                "Return ONLY the overview text (no preamble, no JSON)."),
        }
        : new[]
        {
            new ChatMessage("system", SystemGuardrails()),
            new ChatMessage("user",
                "Write a tailored one-page cover letter for this role.\n\n" +
                "CANDIDATE (use only these facts):\n" + ProfileBlock(profile) + "\n\n" +
                "ROLE:\n" + RoleBlock(job) + "\n\n" +
                "REQUIREMENTS:\n" +
                "- 3–4 short paragraphs, specific to the company and role.\n" +
                "- Ground every claim in the facts above; invent nothing.\n" +
                $"- State the candidate's availability ({profile.AvailabilityText}).\n" +
                "- Professional and warm. " + LanguageRule(profile) + "\n\n" +
                "Return ONLY the cover-letter text (no preamble, no JSON)."),
        };

    public static IReadOnlyList<ChatMessage> UnsolicitedEmailPrompt(CandidateProfile profile, CompanyTarget company) =>
        Mode == AppMode.Recruiter ? new[]
        {
            new ChatMessage("system", RecruiterGuardrails()),
            new ChatMessage("user",
                "Write a brief, professional note to this company's talent/hiring contact introducing the role we're hiring for and asking whether they know anyone who might fit or be open to a referral.\n\n" +
                "THE ROLE (use only these facts):\n" + RoleBriefBlock(profile) + "\n\n" +
                "COMPANY:\n" +
                $"Name: {company.Name}\nIndustry: {company.Industry}\nLocation: {company.Location}\n\n" +
                "REQUIREMENTS:\n" +
                "- A clear subject line referencing the role.\n" +
                "- A short body (about 100–140 words), respectful and non-spammy.\n\n" +
                "Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}."),
        }
        : new[]
        {
            new ChatMessage("system", SystemGuardrails()),
            new ChatMessage("user",
                "Write a concise, specific unsolicited application email to this company.\n\n" +
                "CANDIDATE (use only these facts):\n" + ProfileBlock(profile) + "\n\n" +
                "COMPANY:\n" +
                $"Name: {company.Name}\nIndustry: {company.Industry}\nLocation: {company.Location}\nWhy a fit: {company.FitExplanation}\n\n" +
                "REQUIREMENTS:\n" +
                "- A clear subject line referencing a speculative application and the company.\n" +
                "- A short body (about 120–160 words) on the value the candidate could add, from the facts above.\n" +
                $"- State the candidate's availability ({profile.AvailabilityText}).\n" +
                "- Note that the CV is attached. Warm, professional. " + LanguageRule(profile) + "\n\n" +
                "Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}."),
        };

    /// <summary>Optional user persona/guidelines (set from preferences) folded into every draft prompt.</summary>
    public static string UserGuidelines = "";

    private static string SystemGuardrails()
    {
        var s = "You write truthful, professional job applications for a real candidate. " +
                "Use only the professional facts provided. Never invent skills, employers, titles, dates, or achievements. " +
                "Write strictly about professional qualifications, skills, and motivation for the role. " +
                "State the candidate's start availability exactly as instructed. Keep every claim modest and accurate.";
        if (!string.IsNullOrWhiteSpace(UserGuidelines))
            s += " The candidate also gave these guidelines — follow them: " + UserGuidelines.Trim();
        return s;
    }

    private static string RecruiterGuardrails()
    {
        var s = "You write truthful, professional recruiting outreach on behalf of a real recruiter. " +
                "Use only the facts provided about the role and the candidate. Never invent the candidate's skills, " +
                "employers, titles, or experience, and never overstate the role, compensation, or company. " +
                "Be respectful of the candidate's time and privacy; no manipulative urgency, no flattery clichés.";
        if (!string.IsNullOrWhiteSpace(UserGuidelines))
            s += " The recruiter also gave these guidelines — follow them: " + UserGuidelines.Trim();
        return s;
    }

    /// <summary>The role the recruiter is hiring for, expressed from the loaded role brief (stored in the profile slot).</summary>
    private static string RoleBriefBlock(CandidateProfile role) =>
        $"Role / headline: {role.Headline}\n" +
        $"Hiring location: {role.Location}\n" +
        $"What the role involves: {role.Summary}\n" +
        $"Key skills wanted: {string.Join(", ", role.Skills)}\n" +
        $"Relevant industries: {string.Join(", ", role.Industries)}\n" +
        $"Tools / stack: {string.Join(", ", role.Tools)}";

    /// <summary>A sourced candidate, materialised in the JobPosting slot (Title = headline, Company = current employer).</summary>
    private static string CandidateBlock(JobPosting candidate) =>
        $"Name / headline: {candidate.Title}\n" +
        $"Current employer: {candidate.Company}\n" +
        $"Location: {candidate.Location}\n" +
        $"Profile / source: {candidate.SourceUrl}\n" +
        $"Background notes: {Truncate(candidate.RawDescription, 1200)}";

    private static string ProfileBlock(CandidateProfile p)
    {
        var languages = string.Join(", ", p.Languages.Select(l => $"{l.Language} ({l.Level})"));
        return
            $"Name: {p.FullName}\n" +
            $"Headline: {p.Headline}\n" +
            $"Location: {p.Location}\n" +
            $"Experience: {p.YearsExperience}+ years\n" +
            $"Summary: {p.Summary}\n" +
            $"Key skills: {string.Join(", ", p.Skills)}\n" +
            $"Industries: {string.Join(", ", p.Industries)}\n" +
            $"Tools: {string.Join(", ", p.Tools)}\n" +
            $"Education: {string.Join("; ", p.Education)}\n" +
            $"Languages: {languages}\n" +
            $"Availability: {p.AvailabilityText}";
    }

    private static string RoleBlock(JobPosting job) =>
        $"Company: {job.Company}\n" +
        $"Title: {job.Title}\n" +
        $"Location: {job.Location} ({job.WorkLocation})\n" +
        $"Details: {Truncate(job.RawDescription, 1200)}";

    // Cap every profile language at the level the candidate actually stated — generalised across
    // any language, not just German. Native/fluent languages need no instruction.
    private static string LanguageRule(CandidateProfile p)
    {
        var capped = p.Languages
            .Where(l => !string.IsNullOrWhiteSpace(l.Language) && !IsHighLevel(l.Level))
            .Select(l => $"{l.Language} as \"{l.Level}\"")
            .ToList();
        return capped.Count == 0
            ? ""
            : "If you reference these languages, describe them at the stated level only — never higher: " + string.Join("; ", capped) + ".";
    }

    private static bool IsHighLevel(string? level)
    {
        var l = (level ?? "").ToLowerInvariant();
        return l.Contains("native") || l.Contains("fluent") || l.Contains("bilingual") ||
               l.Contains("mother") || l.Contains("proficient") || l.Contains("advanced") ||
               l.Contains("c2") || l.Contains("c1");
    }

    private static string Truncate(string s, int max) => string.IsNullOrEmpty(s) || s.Length <= max ? s ?? "" : s[..max];
}
