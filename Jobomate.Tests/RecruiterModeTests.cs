using System;
using System.Linq;
using Jobomate.Contracts;
using Jobomate.Drafting;
using Jobomate.Filters;
using Jobomate.Llm;
using Xunit;

namespace Jobomate.Tests;

/// <summary>
/// Covers the dual-purpose mode: in recruiter mode the same pipeline flips to candidate sourcing
/// + outreach. The draft prompts are pure, so we assert their framing changes with the mode.
/// </summary>
public class RecruiterModeTests
{
    private static string PromptText(System.Collections.Generic.IReadOnlyList<ChatMessage> msgs) =>
        string.Join("\n", msgs.Select(m => m.Content));

    [Fact]
    public void Preferences_DefaultMode_IsJobSeeker()
    {
        Assert.Equal(AppMode.JobSeeker, new SearchPreferences().Mode);
    }

    [Fact]
    public void EmailPrompt_RecruiterMode_WritesCandidateOutreach()
    {
        var prev = DraftPromptBuilder.Mode;
        try
        {
            var role = new CandidateProfile { Headline = "Senior Backend Engineer", Skills = { "Go", "Kubernetes" } };
            var candidate = new JobPosting { Title = "Staff Engineer", Company = "Acme Corp", Location = "Berlin" };

            DraftPromptBuilder.Mode = AppMode.Recruiter;
            var recruiter = PromptText(DraftPromptBuilder.EmailPrompt(role, candidate));

            DraftPromptBuilder.Mode = AppMode.JobSeeker;
            var seeker = PromptText(DraftPromptBuilder.EmailPrompt(role, candidate));

            // Recruiter framing: outreach to a candidate, role-brief block present.
            Assert.Contains("outreach", recruiter, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("candidate", recruiter, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("hiring for", recruiter, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("Acme Corp", recruiter); // candidate's current employer surfaced

            // Job-seeker framing is distinct: an application FROM the candidate.
            Assert.Contains("application email", seeker, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("recruiting outreach", seeker, StringComparison.OrdinalIgnoreCase);
            Assert.NotEqual(recruiter, seeker);
        }
        finally { DraftPromptBuilder.Mode = prev; }
    }

    [Fact]
    public void RecruiterGuardrails_ForbidInventingCandidateFacts()
    {
        var prev = DraftPromptBuilder.Mode;
        try
        {
            DraftPromptBuilder.Mode = AppMode.Recruiter;
            var text = PromptText(DraftPromptBuilder.EmailPrompt(
                new CandidateProfile { Headline = "Data Lead" },
                new JobPosting { Title = "Analyst", Company = "X" }));

            Assert.Contains("never invent", text, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("privacy", text, StringComparison.OrdinalIgnoreCase);
        }
        finally { DraftPromptBuilder.Mode = prev; }
    }

    [Fact]
    public void CoverLetterPrompt_RecruiterMode_IsRoleOverview_NotCandidateLetter()
    {
        var prev = DraftPromptBuilder.Mode;
        try
        {
            DraftPromptBuilder.Mode = AppMode.Recruiter;
            var text = PromptText(DraftPromptBuilder.CoverLetterPrompt(
                new CandidateProfile { Headline = "Platform Engineer" },
                new JobPosting { Title = "n/a" }));

            Assert.Contains("role overview", text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("cover letter", text, StringComparison.OrdinalIgnoreCase);
        }
        finally { DraftPromptBuilder.Mode = prev; }
    }
}
