using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using UglyToad.PdfPig;

namespace Jobomate.Profile;

/// <summary>
/// Best-effort text extraction from a loaded CV. PDF goes through PdfPig; DOCX
/// is unzipped and read from word/document.xml; RTF control words are stripped;
/// plain text/markdown is read directly. Any failure returns an empty string so
/// the caller falls back to the known candidate background (per the spec).
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
                ".docx" => ExtractDocx(path!),
                ".rtf" => ExtractRtf(path!),
                // Old binary .doc format is not supported — it requires Word Interop
                // or a third-party library (e.g. Aspose, Tika). The caller will fall
                // back to the known candidate background.
                ".doc" => "",
                ".txt" or ".md" or ".text" => File.ReadAllText(path!).Trim(),
                _ => "",
            };
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// Extract readable text from ANY file the user drops into the chat, for use as LLM context.
    /// Rich documents (PDF / DOCX / RTF) go through the dedicated extractors; everything else
    /// (TXT, MD, CSV, JSON, HTML, source code, logs, …) is read as UTF-8 text. Files that look
    /// binary (NUL bytes / mostly non-printable — images, archives, executables) return "" so the
    /// caller can tell the user the current text model can't read them.
    /// </summary>
    public static string ExtractAnyText(string? path)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return "";

            var ext = Path.GetExtension(path).ToLowerInvariant();
            switch (ext)
            {
                case ".pdf": return ExtractPdf(path!);
                case ".docx": return ExtractDocx(path!);
                case ".rtf": return ExtractRtf(path!);
                case ".doc": return ""; // legacy binary Word — unsupported
            }

            var bytes = File.ReadAllBytes(path!);
            if (bytes.Length == 0 || LooksBinary(bytes)) return "";
            // Strip a UTF-8 BOM if present, then decode.
            var start = (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) ? 3 : 0;
            return Encoding.UTF8.GetString(bytes, start, bytes.Length - start).Trim();
        }
        catch
        {
            return "";
        }
    }

    /// <summary>Heuristic: sample the first 8 KB — any NUL byte, or &gt;30% control/non-text bytes, means binary.</summary>
    private static bool LooksBinary(byte[] bytes)
    {
        int n = Math.Min(bytes.Length, 8192), nonText = 0;
        for (int i = 0; i < n; i++)
        {
            byte b = bytes[i];
            if (b == 0) return true;
            if (b < 0x20 && b != 0x09 && b != 0x0A && b != 0x0D) nonText++;
        }
        return nonText > n * 0.30;
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

    /// <summary>
    /// Extract text from a DOCX file. A DOCX is a ZIP archive containing XML;
    /// we read word/document.xml and collect all text nodes.
    /// </summary>
    private static string ExtractDocx(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        var docEntry = zip.GetEntry("word/document.xml");
        if (docEntry is null) return "";

        using var stream = docEntry.Open();
        var doc = XDocument.Load(stream);
        // Word namespace: http://schemas.openxmlformats.org/wordprocessingml/2006/main
        XNamespace w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        var paragraphs = doc.Descendants(w + "p");
        var sb = new StringBuilder();
        foreach (var p in paragraphs)
        {
            var texts = p.Descendants(w + "t").Select(t => t.Value);
            var line = string.Concat(texts);
            if (!string.IsNullOrWhiteSpace(line))
                sb.AppendLine(line.Trim());
        }
        return sb.ToString().Trim();
    }

    /// <summary>
    /// Extract plain text from RTF by stripping control words, groups, and
    /// destination blocks. This is a best-effort regex approach; complex RTF
    /// with embedded objects will degrade but still produce readable text.
    /// </summary>
    private static string ExtractRtf(string path)
    {
        var rtf = File.ReadAllText(path);

        // Remove entire groups that are known destinations (fonttbl, colortbl, stylesheet, etc.).
        rtf = Regex.Replace(rtf, @"\{\\\w+tbl.*?\}", "", RegexOptions.Singleline);
        // Remove group braces (recursive-ish: replace innermost groups first via loop).
        var prev = "";
        while (rtf != prev)
        {
            prev = rtf;
            rtf = Regex.Replace(rtf, @"\{[^{}]*\}", "");
        }
        // Strip remaining control words: backslash + letters + optional space.
        rtf = Regex.Replace(rtf, @"\\[a-zA-Z]+\s?", " ");
        // Strip hex escapes: \'xx
        rtf = Regex.Replace(rtf, @"\\'[0-9a-fA-F]{2}", " ");
        // Strip unicode escapes: \uNNNN
        rtf = Regex.Replace(rtf, @"\\u\d+\??", " ");
        // Collapse whitespace and trim.
        rtf = Regex.Replace(rtf, @"\s+", " ").Trim();
        return rtf;
    }
}
