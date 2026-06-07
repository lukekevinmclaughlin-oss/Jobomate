using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Llm;

namespace Jobomate.Drafting;

public sealed record DraftResult(EmailDraft Email, string CoverLetter);

/// <summary>
/// Generates the application email + cover letter via the LLM, then runs every result
/// through <see cref="GuardrailValidator"/> so the output can never overstate German,
/// stray into forbidden topics, or omit the start availability.
/// </summary>
public sealed class DraftGenerator
{
    private readonly LlmClient _llm;
    private readonly LlmConnectionConfig _cfg;

    public DraftGenerator(LlmClient llm, LlmConnectionConfig cfg)
    {
        _llm = llm;
        _cfg = cfg;
    }

    public async Task<DraftResult> ForJobAsync(
        CandidateProfile profile, JobPosting job, CandidateDocument? cv, CancellationToken ct = default)
    {
        var emailJson = await _llm.CompleteAsync(_cfg, DraftPromptBuilder.EmailPrompt(profile, job),
            new LlmCallOptions(MaxOutputTokens: 700), ct).ConfigureAwait(false);
        var (subject, body) = ParseSubjectBody(emailJson, DefaultSubject(profile, job.Title, job.Company));

        var cover = await _llm.CompleteAsync(_cfg, DraftPromptBuilder.CoverLetterPrompt(profile, job),
            new LlmCallOptions(MaxOutputTokens: 900), ct).ConfigureAwait(false);

        return Finish(profile, job.ContactEmail, job.Company, subject, body, cover, cv);
    }

    public async Task<DraftResult> ForCompanyAsync(
        CandidateProfile profile, CompanyTarget company, CandidateDocument? cv, CancellationToken ct = default)
    {
        var emailJson = await _llm.CompleteAsync(_cfg, DraftPromptBuilder.UnsolicitedEmailPrompt(profile, company),
            new LlmCallOptions(MaxOutputTokens: 700), ct).ConfigureAwait(false);
        var (subject, body) = ParseSubjectBody(emailJson, $"Speculative application — {profile.FullName}");

        var pseudoJob = new JobPosting
        {
            Company = company.Name,
            Title = "Speculative application",
            Location = company.Location,
            RawDescription = company.FitExplanation,
        };
        var cover = await _llm.CompleteAsync(_cfg, DraftPromptBuilder.CoverLetterPrompt(profile, pseudoJob),
            new LlmCallOptions(MaxOutputTokens: 900), ct).ConfigureAwait(false);

        return Finish(profile, company.RecruitingEmail, company.Name, subject, body, cover, cv);
    }

    /// <summary>Deterministic, LLM-free draft (offline/demo fallback). Still guardrail-cleaned.</summary>
    public static DraftResult OfflineForJob(CandidateProfile profile, JobPosting job, CandidateDocument? cv)
    {
        var subject = $"Application: {job.Title} — {profile.FullName}";
        var body = OfflineBody(profile, $"the {job.Title} role at {job.Company}");
        var cover = OfflineCover(profile, job.Company, job.Title);
        return Finish(profile, job.ContactEmail, job.Company, subject, body, cover, cv);
    }

    public static DraftResult OfflineForCompany(CandidateProfile profile, CompanyTarget company, CandidateDocument? cv)
    {
        var subject = $"Speculative application — {profile.FullName}";
        var body = OfflineBody(profile, $"a suitable role at {company.Name}");
        var cover = OfflineCover(profile, company.Name, "a suitable position");
        return Finish(profile, company.RecruitingEmail, company.Name, subject, body, cover, cv);
    }

    private static string OfflineBody(CandidateProfile p, string roleRef) =>
        $"Dear hiring team,\n\nI'm writing to apply for {roleRef}. I bring {p.YearsExperience}+ years in " +
        $"{string.Join(", ", p.Industries)}, with strengths in {string.Join(", ", p.Skills.Take(5))}. " +
        $"I would welcome the chance to contribute. I am available to start {p.AvailabilityText}, " +
        $"and my CV is attached.\n\nKind regards,\n{p.FullName}";

    private static string OfflineCover(CandidateProfile p, string company, string title) =>
        $"Dear {company} team,\n\nI am writing to apply for the {title} position. {p.Summary}\n\n" +
        $"Across my career I have focused on {string.Join(", ", p.Skills.Take(6))}, working with tools such as " +
        $"{string.Join(", ", p.Tools.Take(6))}. I am confident I can bring measurable value to {company}.\n\n" +
        $"I am available to start {p.AvailabilityText} and would welcome the opportunity to discuss " +
        $"how I can help.\n\nKind regards,\n{p.FullName}";

    private static DraftResult Finish(
        CandidateProfile profile, string toEmail, string toName, string subject, string body, string cover, CandidateDocument? cv)
    {
        var email = new EmailDraft
        {
            ToAddress = toEmail,
            ToName = toName,
            Subject = GuardrailValidator.StripForbidden(subject),
            Body = GuardrailValidator.Clean(body, profile),
        };
        if (cv is not null && !string.IsNullOrEmpty(cv.StoredPath) && File.Exists(cv.StoredPath))
            email.AttachmentPaths.Add(cv.StoredPath);

        var cleanCover = GuardrailValidator.Clean(cover, profile);
        return new DraftResult(email, cleanCover);
    }

    private static string DefaultSubject(CandidateProfile profile, string title, string company) =>
        $"Application: {title} — {profile.FullName}";

    public static (string Subject, string Body) ParseSubjectBody(string response, string defaultSubject)
    {
        var json = ExtractObject(response);
        if (json is not null)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                var subject = root.TryGetProperty("subject", out var s) ? s.GetString() ?? "" : "";
                var body = root.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
                if (!string.IsNullOrWhiteSpace(body))
                    return (string.IsNullOrWhiteSpace(subject) ? defaultSubject : subject, body);
            }
            catch { /* fall through to text handling */ }
        }

        // Plain-text fallback: maybe "Subject: ...\n\n<body>".
        var text = response.Trim();
        var match = System.Text.RegularExpressions.Regex.Match(text, @"^\s*Subject:\s*(.+)$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Multiline);
        if (match.Success)
        {
            var subject = match.Groups[1].Value.Trim();
            var body = text[(match.Index + match.Length)..].Trim();
            return (subject, string.IsNullOrWhiteSpace(body) ? text : body);
        }

        return (defaultSubject, string.IsNullOrWhiteSpace(text) ? "" : text);
    }

    private static string? ExtractObject(string text)
    {
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        return start >= 0 && end > start ? text[start..(end + 1)] : null;
    }
}
