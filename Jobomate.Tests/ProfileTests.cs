using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
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
        Assert.Null(profile.AvailabilityFrom); // available anytime by default
        // Neutral default: no fabricated persona — English present, nothing profession-specific.
        Assert.Contains(profile.Languages, l => l.Language.Equals("English", StringComparison.OrdinalIgnoreCase));
        Assert.Empty(profile.Industries);
    }

    [Fact]
    public void FromCvText_RealText_IsNotFallback()
    {
        var text = string.Join("\n", Enumerable.Repeat(
            "Luke McLaughlin — Growth marketing leader in Munich with SEO, CRM and AI workflow experience.", 6));

        var profile = ProfileBuilder.FromCvText(text);

        Assert.False(profile.FromFallback);
        Assert.Null(profile.AvailabilityFrom); // available anytime by default
    }

    [Fact]
    public void EnforceGuards_NeverClaimsGermanFluency()
    {
        var profile = new CandidateProfile
        {
            Languages =
            {
                new CandidateLanguage { Language = "German", Level = "fluent" },
                new CandidateLanguage { Language = "English", Level = "native" },
            },
        };

        ProfileBuilder.EnforceGuards(profile);

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

    [Fact]
    public void CvTextExtractor_ExtractsDocxParagraphs()
    {
        var path = Path.Combine(Path.GetTempPath(), $"jobomate-test-{Guid.NewGuid():n}.docx");
        WriteMinimalDocx(path, "Jane Doe", "Senior Backend Engineer — Berlin", "Skills: C#, Python, Kubernetes");
        try
        {
            var text = CvTextExtractor.ExtractText(path);
            Assert.Contains("Jane Doe", text);
            Assert.Contains("Senior Backend Engineer", text);
            Assert.Contains("Kubernetes", text);
            // One paragraph per line.
            Assert.Equal(3, text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void CvTextExtractor_StripsRtfControlWords()
    {
        var path = Path.Combine(Path.GetTempPath(), $"jobomate-test-{Guid.NewGuid():n}.rtf");
        File.WriteAllText(path,
            @"{\rtf1\ansi\deff0{\fonttbl{\f0 Arial;}}\f0\fs24 Jane Doe\par Backend Engineer\par Skills: C#, Python\par}");
        try
        {
            var text = CvTextExtractor.ExtractText(path);
            Assert.Contains("Jane Doe", text);
            Assert.Contains("Backend Engineer", text);
            Assert.Contains("Python", text);
            // Control words like \rtf1, \ansi, \fonttbl must be gone.
            Assert.DoesNotContain("rtf1", text);
            Assert.DoesNotContain("fonttbl", text);
            Assert.DoesNotContain("Arial", text); // font table destination stripped
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void CvTextExtractor_UnsupportedDoc_ReturnsEmpty()
    {
        var path = Path.Combine(Path.GetTempPath(), $"jobomate-test-{Guid.NewGuid():n}.doc");
        File.WriteAllText(path, "binary-ish content");
        try
        {
            Assert.Equal("", CvTextExtractor.ExtractText(path));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void CvTextExtractor_MissingFile_ReturnsEmpty()
    {
        Assert.Equal("", CvTextExtractor.ExtractText("/no/such/file.docx"));
        Assert.Equal("", CvTextExtractor.ExtractText(null));
    }

    /// <summary>Write a minimal valid DOCX (a ZIP with word/document.xml) holding one paragraph per line.</summary>
    private static void WriteMinimalDocx(string path, params string[] paragraphs)
    {
        const string w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        var body = new StringBuilder();
        foreach (var p in paragraphs)
            body.Append($"<w:p><w:r><w:t xml:space=\"preserve\">{System.Security.SecurityElement.Escape(p)}</w:t></w:r></w:p>");
        var docXml = $"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"{w}\"><w:body>{body}</w:body></w:document>";

        using var zip = ZipFile.Open(path, ZipArchiveMode.Create);
        var entry = zip.CreateEntry("word/document.xml");
        using var s = new StreamWriter(entry.Open(), new UTF8Encoding(false));
        s.Write(docXml);
    }
}
