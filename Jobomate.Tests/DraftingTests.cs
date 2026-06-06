using System.IO;
using System.Linq;
using Jobomate.Contracts;
using Jobomate.Drafting;
using Jobomate.Llm;
using Jobomate.Profile;
using Xunit;

namespace Jobomate.Tests;

public class DraftingTests
{
    private static JobPosting CleanJob() => new()
    {
        Company = "BioReach Labs",
        Title = "Senior Growth Marketing Manager",
        Location = "Remote · EU",
        WorkLocation = WorkLocationType.Remote,
        RawDescription = "Own SEO, paid acquisition, CRM and reporting for a B2B life-science scale-up.",
        ContactEmail = "careers@bioreachlabs.example",
    };

    private static string AllPromptText(params System.Collections.Generic.IReadOnlyList<ChatMessage>[] prompts) =>
        string.Join("\n", prompts.SelectMany(p => p).Select(m => m.Content));

    [Fact]
    public void Prompts_AlwaysStateAvailability_FromOct2026()
    {
        var profile = CandidateProfileDefaults.Known();
        var job = CleanJob();

        Assert.Contains(JobomateConstants.AvailabilityText,
            AllPromptText(DraftPromptBuilder.EmailPrompt(profile, job)));
        Assert.Contains(JobomateConstants.AvailabilityText,
            AllPromptText(DraftPromptBuilder.CoverLetterPrompt(profile, job)));
    }

    [Fact]
    public void Prompts_ContainNoForbiddenTopics()
    {
        var profile = CandidateProfileDefaults.Known();
        var job = CleanJob();
        var company = new CompanyTarget { Name = "Helix", Industry = "Biotech", Location = "Munich", FitExplanation = "Strong biotech fit." };

        var text = AllPromptText(
            DraftPromptBuilder.EmailPrompt(profile, job),
            DraftPromptBuilder.CoverLetterPrompt(profile, job),
            DraftPromptBuilder.UnsolicitedEmailPrompt(profile, company)).ToLowerInvariant();

        foreach (var topic in JobomateConstants.ForbiddenTopics)
            Assert.DoesNotContain(topic, text);
    }

    [Fact]
    public void Guardrail_DetectsAndStripsForbiddenContent()
    {
        const string bad = "I am a strong marketer. I was laid off last year due to redundancy. I deliver results.";
        Assert.True(GuardrailValidator.ContainsForbidden(bad));

        var stripped = GuardrailValidator.StripForbidden(bad);
        Assert.False(GuardrailValidator.ContainsForbidden(stripped));
        Assert.Contains("strong marketer", stripped);
        Assert.Contains("deliver results", stripped);
    }

    [Fact]
    public void Guardrail_CapsGermanAtIntermediate()
    {
        Assert.Equal("I have intermediate German and native English.",
            GuardrailValidator.EnforceGermanLevel("I have fluent German and native English."));
    }

    [Fact]
    public void Guardrail_EnsuresAvailabilityIsStated()
    {
        var body = GuardrailValidator.EnsureAvailability("I would love to join your team.");
        Assert.Contains(JobomateConstants.AvailabilityText, body);
    }

    [Fact]
    public void ParseSubjectBody_ReadsJson()
    {
        var (subject, body) = DraftGenerator.ParseSubjectBody(
            "{\"subject\":\"Application: Growth Lead\",\"body\":\"Dear team, ...\"}", "fallback");
        Assert.Equal("Application: Growth Lead", subject);
        Assert.StartsWith("Dear team", body);
    }

    [Fact]
    public void CoverLetterPdf_RendersRealPdf()
    {
        var dir = Path.Combine(Path.GetTempPath(), "jobomate-pdf-" + System.Guid.NewGuid().ToString("n"));
        try
        {
            var path = CoverLetterPdf.Render(
                "Dear Hiring Team,\n\nI am excited to apply.\n\nKind regards,\nLuke",
                CandidateProfileDefaults.Known(), "BioReach Labs", "Growth Marketing Manager", dir);

            Assert.True(File.Exists(path));
            var bytes = File.ReadAllBytes(path);
            Assert.True(bytes.Length > 1000);
            Assert.Equal("%PDF", System.Text.Encoding.ASCII.GetString(bytes, 0, 4));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }
}
