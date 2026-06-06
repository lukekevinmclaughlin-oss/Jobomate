using System.Collections.Generic;
using System.Linq;
using Jobomate.Contracts;
using Jobomate.Filters;
using Xunit;

namespace Jobomate.Tests;

public class FilterTests
{
    private static List<LanguageRequirement> Req(params (string Lang, LanguageRequirementKind Kind, string Ev)[] items) =>
        items.Select(i => new LanguageRequirement { Language = i.Lang, Kind = i.Kind, Evidence = i.Ev }).ToList();

    // ----- Strict language filtering -----

    [Fact]
    public void EnglishOnly_Excludes_GermanRequired()
    {
        var reqs = Req(("German", LanguageRequirementKind.Required, "Verhandlungssichere Deutschkenntnisse erforderlich."));
        var (decision, _) = LanguageFilter.Evaluate(reqs, new[] { "English" }, LanguageMatchMode.StrictRequired);
        Assert.Equal(LanguageInclusionDecision.Excluded, decision);
    }

    [Fact]
    public void PreferredLanguage_DoesNotExclude()
    {
        var reqs = Req(
            ("English", LanguageRequirementKind.Required, "Business-fluent English is required."),
            ("German", LanguageRequirementKind.Preferred, "German is a plus."));
        var (decision, _) = LanguageFilter.Evaluate(reqs, new[] { "English" }, LanguageMatchMode.StrictRequired);
        Assert.Equal(LanguageInclusionDecision.Included, decision);
    }

    [Fact]
    public void UnclearLanguage_ExcludedInStrict_IncludedWhenEnabled()
    {
        var reqs = new List<LanguageRequirement>(); // no evidence → unclear
        Assert.Equal(LanguageInclusionDecision.Excluded,
            LanguageFilter.Evaluate(reqs, new[] { "English" }, LanguageMatchMode.StrictRequired).Decision);
        Assert.Equal(LanguageInclusionDecision.Flagged,
            LanguageFilter.Evaluate(reqs, new[] { "English" }, LanguageMatchMode.IncludeUnclear).Decision);
    }

    [Fact]
    public void EvidencelessRequirement_TreatedAsUnclear()
    {
        // The model returned a language with no quoted phrase → must not be trusted.
        var reqs = Req(("German", LanguageRequirementKind.Required, ""));
        var (decision, _) = LanguageFilter.Evaluate(reqs, new[] { "English" }, LanguageMatchMode.StrictRequired);
        Assert.Equal(LanguageInclusionDecision.Excluded, decision); // unclear → excluded in strict
    }

    [Fact]
    public void EnglishRequired_Accepted_IsIncluded()
    {
        var reqs = Req(("English", LanguageRequirementKind.Required, "Fluent English required."));
        var (decision, _) = LanguageFilter.Evaluate(reqs, new[] { "English" }, LanguageMatchMode.StrictRequired);
        Assert.Equal(LanguageInclusionDecision.Included, decision);
    }

    // ----- Dedup -----

    [Fact]
    public void Dedupe_CollapsesSameRoleAcrossSources_KeepsHighestConfidence()
    {
        var a = Finalize(new JobPosting { Company = "BioReach", Title = "Growth Marketing Manager", Source = "Arbeitnow", ConfidenceScore = 0.6 });
        var b = Finalize(new JobPosting { Company = "bioreach", Title = "growth marketing manager", Source = "Greenhouse", ConfidenceScore = 0.9 });
        var c = Finalize(new JobPosting { Company = "Helix", Title = "Product Marketing", Source = "Lever", ConfidenceScore = 0.8 });

        var result = JobDeduplicator.Dedupe(new[] { a, b, c });

        Assert.Equal(2, result.Count);
        Assert.Contains(result, j => j.Company == "bioreach" && j.Source == "Greenhouse"); // highest confidence kept
    }

    // ----- Work location -----

    [Theory]
    [InlineData(WorkLocationType.Remote, true)]
    [InlineData(WorkLocationType.OnSite, false)]
    public void WorkLocationFilter_RespectsSelection(WorkLocationType jobType, bool expectedInclude)
    {
        var (include, _) = WorkLocationFilter.Evaluate(jobType, new[] { WorkLocationType.Remote, WorkLocationType.Hybrid }, includeUnclear: true);
        Assert.Equal(expectedInclude, include);
    }

    // ----- Start date vs 1 Oct 2026 -----

    [Fact]
    public void StartDate_EarlierFixedStart_IsRisk()
    {
        var job = new JobPosting { EarliestStart = new System.DateOnly(2026, 7, 1) };
        Assert.Equal(StartDateRisk.Risk, StartDateEvaluator.Evaluate(job));
    }

    [Fact]
    public void StartDate_OnOrAfterAvailability_IsCompatible()
    {
        var job = new JobPosting { EarliestStart = new System.DateOnly(2026, 11, 1) };
        Assert.Equal(StartDateRisk.Compatible, StartDateEvaluator.Evaluate(job));
    }

    [Fact]
    public void Ranking_RespectsAvailability_CompatibleAboveRisk()
    {
        var compatible = new JobPosting { Company = "A", Title = "Compatible role", StartDateRisk = StartDateRisk.Compatible, LanguageDecision = LanguageInclusionDecision.Included, Included = true };
        var risky = new JobPosting { Company = "B", Title = "Risky role", StartDateRisk = StartDateRisk.Risk, LanguageDecision = LanguageInclusionDecision.Included, Included = true };

        var ranked = JobRanker.Rank(new[] { risky, compatible });

        Assert.Equal("Compatible role", ranked[0].Title);
    }

    // ----- End-to-end pipeline -----

    [Fact]
    public void Pipeline_ExcludesGermanRequired_RanksCompatibleFirst_ForEnglishOnly()
    {
        var prefs = new SearchPreferences { AcceptedLanguages = { }, LanguageMode = LanguageMatchMode.StrictRequired };
        prefs.AcceptedLanguages.Clear();
        prefs.AcceptedLanguages.Add("English");

        var english = Finalize(new JobPosting
        {
            Company = "BioReach", Title = "Growth Marketing Manager", WorkLocation = WorkLocationType.Remote,
            ConfidenceScore = 0.9, LanguageRequirements = Req(("English", LanguageRequirementKind.Required, "Fluent English required.")),
        });
        var german = Finalize(new JobPosting
        {
            Company = "MünchenBio", Title = "Marketing Manager", WorkLocation = WorkLocationType.OnSite,
            ConfidenceScore = 0.9, LanguageRequirements = Req(("German", LanguageRequirementKind.Required, "Deutschkenntnisse erforderlich.")),
        });

        var result = new FilterPipeline().Process(new[] { english, german }, prefs);

        var en = result.First(j => j.Company == "BioReach");
        var de = result.First(j => j.Company == "MünchenBio");
        Assert.True(en.Included);
        Assert.False(de.Included);
        Assert.Equal("BioReach", result[0].Company); // included + ranked first
    }

    private static JobPosting Finalize(JobPosting j) => Jobomate.Sources.JobNormalization.Finalize(j);
}
