using System;
using System.IO;
using System.Linq;
using Jobomate.Contracts;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

namespace Jobomate.Drafting;

/// <summary>Renders a cover letter to a clean A4 PDF via QuestPDF (Community license).</summary>
public static class CoverLetterPdf
{
    static CoverLetterPdf()
    {
        QuestPDF.Settings.License = LicenseType.Community;
    }

    public static string Render(string coverLetterText, CandidateProfile profile, string company, string roleTitle, string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        var safeCompany = new string((company ?? "company").Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray());
        if (safeCompany.Length == 0) safeCompany = "company";
        var path = Path.Combine(outputDir, $"CoverLetter-{safeCompany}-{DateTime.UtcNow:yyyyMMddHHmmss}.pdf");

        Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.Margin(2, Unit.Centimetre);
                page.DefaultTextStyle(x => x.FontSize(11).FontFamily("Helvetica").FontColor(Colors.Black));

                page.Header().Column(col =>
                {
                    col.Item().Text(profile.FullName).FontSize(18).SemiBold();
                    var contact = string.Join("  ·  ",
                        new[] { profile.Headline, profile.Location, profile.Email }.Where(s => !string.IsNullOrWhiteSpace(s)));
                    if (contact.Length > 0) col.Item().Text(contact).FontSize(9.5f).FontColor(Colors.Grey.Darken1);
                });

                page.Content().PaddingVertical(16).Column(col =>
                {
                    col.Spacing(10);
                    col.Item().Text(DateTime.UtcNow.ToString("d MMMM yyyy")).FontSize(10).FontColor(Colors.Grey.Darken1);
                    if (!string.IsNullOrWhiteSpace(roleTitle) || !string.IsNullOrWhiteSpace(company))
                        col.Item().Text($"Re: {roleTitle}{(string.IsNullOrWhiteSpace(company) ? "" : " — " + company)}").SemiBold();

                    foreach (var para in SplitParagraphs(coverLetterText))
                        col.Item().Text(para).LineHeight(1.35f);
                });

                page.Footer().AlignCenter().Text($"Available to start from {JobomateConstants.AvailabilityText}")
                    .FontSize(9).FontColor(Colors.Grey.Medium);
            });
        }).GeneratePdf(path);

        return path;
    }

    private static string[] SplitParagraphs(string text)
    {
        var paras = (text ?? "").Replace("\r\n", "\n")
            .Split(new[] { "\n\n" }, StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Trim())
            .Where(p => p.Length > 0)
            .ToArray();
        return paras.Length > 0 ? paras : new[] { (text ?? "").Trim() };
    }
}
