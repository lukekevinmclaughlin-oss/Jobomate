using System;
using System.IO;
using System.Linq;
using Jobomate.Contracts;
using Jobomate.Profile;
using Xunit;

namespace Jobomate.Tests;

public class ProfileTests
{
    [Fact]
    public void FromCvText_Empty_FallsBackToKnownBackground()
    {
        var profile = ProfileBuilder.FromCvText("");

        Assert.True(profile.FromFallback);
        Assert.Equal(JobomateConstants.AvailabilityDate, profile.AvailabilityFrom);
        Assert.Contains(profile.Languages, l =>
            l.Language.Equals("German", StringComparison.OrdinalIgnoreCase) &&
            l.Level == JobomateConstants.GermanLevel);
        Assert.True(profile.YearsExperience >= 10);
    }

    [Fact]
    public void FromCvText_RealText_IsNotFallback()
    {
        var text = string.Join("\n", Enumerable.Repeat(
            "Luke McLaughlin — Growth marketing leader in Munich with SEO, CRM and AI workflow experience.", 6));

        var profile = ProfileBuilder.FromCvText(text);

        Assert.False(profile.FromFallback);
        Assert.Equal(JobomateConstants.AvailabilityDate, profile.AvailabilityFrom);
    }

    [Fact]
    public void EnforceGuards_NeverClaimsGermanFluency_AndClampsAvailability()
    {
        var profile = new CandidateProfile
        {
            AvailabilityFrom = new DateOnly(2026, 1, 1), // earlier than the hard date
            Languages =
            {
                new CandidateLanguage { Language = "German", Level = "fluent" },
                new CandidateLanguage { Language = "English", Level = "native" },
            },
        };

        ProfileBuilder.EnforceGuards(profile);

        Assert.Equal(JobomateConstants.AvailabilityDate, profile.AvailabilityFrom);
        var german = profile.Languages.First(l => l.Language == "German");
        Assert.Equal(JobomateConstants.GermanLevel, german.Level);
    }

    [Fact]
    public void CvTextExtractor_ReadsDefaultCv_WhenPresent()
    {
        const string cv = "/Users/lukemclaughlin/Documents/Career/2026/Luke_McLaughlin_CV_2026.pdf";
        if (!File.Exists(cv)) return; // environment-dependent; skip when absent

        var text = CvTextExtractor.ExtractText(cv);
        Assert.True(text.Length > 100, "Expected meaningful extracted CV text.");
    }
}
