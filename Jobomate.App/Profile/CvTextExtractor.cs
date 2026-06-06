using System;
using System.IO;
using System.Linq;
using System.Text;
using UglyToad.PdfPig;

namespace Jobomate.Profile;

/// <summary>
/// Best-effort text extraction from a loaded CV. PDF goes through PdfPig; plain
/// text/markdown is read directly. Any failure returns an empty string so the
/// caller falls back to the known candidate background (per the spec).
/// </summary>
public static class CvTextExtractor
{
    public static string ExtractText(string? path)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return "";

            var ext = Path.GetExtension(path).ToLowerInvariant();
            return ext switch
            {
                ".pdf" => ExtractPdf(path!),
                ".txt" or ".md" or ".text" => File.ReadAllText(path!).Trim(),
                _ => "",
            };
        }
        catch
        {
            return "";
        }
    }

    private static string ExtractPdf(string path)
    {
        using var doc = PdfDocument.Open(path);
        var sb = new StringBuilder();
        foreach (var page in doc.GetPages())
        {
            // GetWords() is stable across PdfPig versions and preserves word breaks.
            var words = page.GetWords();
            sb.AppendLine(string.Join(" ", words.Select(w => w.Text)));
        }
        return sb.ToString().Trim();
    }
}
