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
    public static IReadOnlyList<ChatMessage> EmailPrompt(CandidateProfile profile, JobPosting job) => new[]
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
            "- Warm, professional, no clichés. " + GermanRule(profile) + "\n\n" +
            "Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}."),
    };

    public static IReadOnlyList<ChatMessage> CoverLetterPrompt(CandidateProfile profile, JobPosting job) => new[]
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
            "- Professional and warm. " + GermanRule(profile) + "\n\n" +
            "Return ONLY the cover-letter text (no preamble, no JSON)."),
    };

    public static IReadOnlyList<ChatMessage> UnsolicitedEmailPrompt(CandidateProfile profile, CompanyTarget company) => new[]
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
            "- Note that the CV is attached. Warm, professional. " + GermanRule(profile) + "\n\n" +
            "Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}."),
    };

    private static string SystemGuardrails() =>
        "You write truthful, professional job applications for a real candidate. " +
        "Use only the professional facts provided. Never invent skills, employers, titles, dates, or achievements. " +
        "Write strictly about professional qualifications, skills, and motivation for the role. " +
        "State the candidate's start availability exactly as instructed. Keep every claim modest and accurate.";

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

    private static string GermanRule(CandidateProfile p)
    {
        var hasGerman = p.Languages.Any(l => l.Language.Equals("German", System.StringComparison.OrdinalIgnoreCase));
        return hasGerman
            ? $"If you reference German, describe it as {JobomateConstants.GermanLevel} only — never higher."
            : "";
    }

    private static string Truncate(string s, int max) => string.IsNullOrEmpty(s) || s.Length <= max ? s ?? "" : s[..max];
}
