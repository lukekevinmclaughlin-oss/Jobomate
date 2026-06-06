using System.Linq;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Sources;
using Xunit;

namespace Jobomate.Tests;

public class SourceTests
{
    [Theory]
    [InlineData("This role is fully remote.", WorkLocationType.Remote)]
    [InlineData("Hybrid — 2 days in office in Munich.", WorkLocationType.Hybrid)]
    [InlineData("Position based on-site in Berlin.", WorkLocationType.OnSite)]
    [InlineData("We are a friendly team building great things.", WorkLocationType.Unclear)]
    public void ClassifyWorkLocation_Works(string text, WorkLocationType expected)
    {
        Assert.Equal(expected, JobNormalization.ClassifyWorkLocation(text).Type);
    }

    [Theory]
    [InlineData("https://boards.greenhouse.io/acmebio/jobs/123", AtsKind.Greenhouse, "acmebio")]
    [InlineData("https://jobs.lever.co/helixtx/abc-def", AtsKind.Lever, "helixtx")]
    [InlineData("https://example.com/careers", AtsKind.Unknown, "")]
    public void AtsDetector_DetectsKindAndSlug(string url, AtsKind kind, string slug)
    {
        var (k, s) = AtsDetector.Detect(url);
        Assert.Equal(kind, k);
        Assert.Equal(slug, s);
    }

    [Fact]
    public void HtmlScraper_ParsesJsonLdJobPosting()
    {
        const string html = """
        <html><head>
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"JobPosting",
         "title":"Growth Marketing Manager",
         "hiringOrganization":{"@type":"Organization","name":"BioReach"},
         "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Munich","addressCountry":"DE"}},
         "jobLocationType":"TELECOMMUTE",
         "datePosted":"2026-05-01",
         "description":"Drive growth. Fluent English required."}
        </script></head><body></body></html>
        """;

        var jobs = HtmlScraper.ParseJsonLdJobs(html, "https://bioreach.example/jobs/1", "Career page");

        Assert.Single(jobs);
        Assert.Equal("Growth Marketing Manager", jobs[0].Title);
        Assert.Equal("BioReach", jobs[0].Company);
        Assert.Contains("Munich", jobs[0].Location);
        Assert.Equal(WorkLocationType.Remote, jobs[0].WorkLocation);
    }

    [Fact]
    public void ManualImport_FromCsv_ParsesRowsAndLanguages()
    {
        const string csv =
            "company,title,location,url,email,languages,work\n" +
            "BioReach,Growth Lead,Munich,https://x.example/1,jobs@bioreach.example,English;German,remote\n" +
            "Helix,Product Marketing,Berlin,,,English,onsite\n";

        var jobs = ManualImport.FromCsv(csv);

        Assert.Equal(2, jobs.Count);
        Assert.Equal("BioReach", jobs[0].Company);
        Assert.Equal("jobs@bioreach.example", jobs[0].ContactEmail);
        Assert.Equal(ApplicationMethod.Email, jobs[0].ApplicationMethod);
        Assert.Equal(WorkLocationType.Remote, jobs[0].WorkLocation);
        Assert.Equal(2, jobs[0].LanguageRequirements.Count);
        Assert.Equal(WorkLocationType.OnSite, jobs[1].WorkLocation);
    }

    [Fact]
    public void ManualImport_FromPastedText_DetectsEmail()
    {
        var job = ManualImport.FromPastedText("Growth Marketing Manager at BioReach\nApply: jobs@bioreach.example");
        Assert.Equal("jobs@bioreach.example", job.ContactEmail);
        Assert.Equal(ApplicationMethod.Email, job.ApplicationMethod);
    }

    [Fact]
    public async Task MockJobSource_ReturnsMixedPostings()
    {
        var jobs = await new MockJobSource().SearchAsync(new JobSearchRequest());

        Assert.True(jobs.Count >= 6);
        Assert.Contains(jobs, j => j.LanguageRequirements.Any(l => l.Language == "German" && l.Kind == LanguageRequirementKind.Required));
        Assert.Contains(jobs, j => j.LanguageRequirements.Any(l => l.Language == "English" && l.Kind == LanguageRequirementKind.Required));
        Assert.All(jobs, j => Assert.False(string.IsNullOrEmpty(j.DedupKey)));
    }
}
