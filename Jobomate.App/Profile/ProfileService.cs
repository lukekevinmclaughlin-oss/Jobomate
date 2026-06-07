using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Llm;
using Jobomate.Persistence;

namespace Jobomate.Profile;

/// <summary>
/// Loads/stores the candidate profile and CV documents. Importing a CV copies it
/// into the app-data folder, extracts text, builds a profile (seeded from the known
/// background), optionally enriches it with the configured LLM, and always enforces
/// the honesty guards before persisting.
/// </summary>
public sealed class ProfileService
{
    private readonly Repository<CandidateProfile> _profiles;
    private readonly Repository<CandidateDocument> _documents;

    public ProfileService(Repository<CandidateProfile> profiles, Repository<CandidateDocument> documents)
    {
        _profiles = profiles;
        _documents = documents;
    }

    public CandidateProfile Current() => _profiles.Get("profile") ?? CandidateProfileDefaults.Known();

    public void Save(CandidateProfile profile) => _profiles.Upsert(ProfileBuilder.EnforceGuards(profile));

    public CandidateDocument? CvDocument(string id) => _documents.Get(id);

    /// <summary>Copy a CV into app data and extract its text.</summary>
    public CandidateDocument ImportCv(string sourcePath)
    {
        var dir = JobomatePaths.EnsureDir(JobomatePaths.DocumentsDir);
        var fileName = Path.GetFileName(sourcePath);
        var dest = Path.Combine(dir, $"{DateTime.UtcNow:yyyyMMddHHmmss}-{fileName}");
        File.Copy(sourcePath, dest, overwrite: true);

        var doc = new CandidateDocument
        {
            Kind = DocumentKind.Cv,
            FileName = fileName,
            OriginalPath = sourcePath,
            StoredPath = dest,
            ContentType = Path.GetExtension(fileName).ToLowerInvariant() == ".pdf" ? "application/pdf" : "text/plain",
            ExtractedText = CvTextExtractor.ExtractText(dest),
        };
        _documents.Upsert(doc);
        return doc;
    }

    /// <summary>Import a CV and build (and persist) the candidate profile from it.</summary>
    public async Task<CandidateProfile> BuildFromCvAsync(
        string sourcePath, LlmClient? llm, LlmConnectionConfig? cfg, CancellationToken ct = default)
    {
        var doc = ImportCv(sourcePath);
        var profile = ProfileBuilder.FromCvText(doc.ExtractedText);
        profile.CvDocumentId = doc.Id;

        if (llm is not null && cfg is not null && !string.IsNullOrWhiteSpace(doc.ExtractedText))
        {
            try { profile = await EnrichWithLlmAsync(profile, doc.ExtractedText, llm, cfg, ct).ConfigureAwait(false); }
            catch { /* best-effort; the seeded profile is already correct */ }
        }

        profile = ProfileBuilder.EnforceGuards(profile);
        _profiles.Upsert(profile);
        return profile;
    }

    private static async Task<CandidateProfile> EnrichWithLlmAsync(
        CandidateProfile seed, string cvText, LlmClient llm, LlmConnectionConfig cfg, CancellationToken ct)
    {
        var prompt =
            "Extract the candidate's full name and location, a concise professional summary (2-3 sentences), a short " +
            "headline, and up to 12 key skills from this CV. " +
            "Return ONLY minified JSON: {\"fullName\":\"...\",\"location\":\"...\",\"summary\":\"...\",\"headline\":\"...\",\"skills\":[\"...\"]}. " +
            "Use only facts present in the CV. Never mention layoffs, health, therapy, or any personal circumstances.\n\nCV:\n" +
            Truncate(cvText, 8000);

        var resp = await llm.CompleteAsync(
            cfg,
            new[]
            {
                new ChatMessage("system", "You extract structured facts from a CV and output JSON only."),
                new ChatMessage("user", prompt),
            },
            new LlmCallOptions(MaxOutputTokens: 700),
            ct).ConfigureAwait(false);

        var json = ExtractJsonObject(resp);
        if (json is null) return seed;

        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.TryGetProperty("fullName", out var fn) && fn.GetString() is { Length: > 0 } fullName)
                seed.FullName = fullName.Trim();
            if (string.IsNullOrWhiteSpace(seed.Location) && root.TryGetProperty("location", out var lo) && lo.GetString() is { Length: > 0 } location)
                seed.Location = location.Trim();
            if (root.TryGetProperty("summary", out var s) && s.GetString() is { Length: > 0 } summary)
                seed.Summary = summary;
            if (root.TryGetProperty("headline", out var h) && h.GetString() is { Length: > 0 } headline)
                seed.Headline = headline;
            if (root.TryGetProperty("skills", out var sk) && sk.ValueKind == JsonValueKind.Array)
            {
                var skills = sk.EnumerateArray()
                    .Select(e => e.GetString())
                    .Where(x => !string.IsNullOrWhiteSpace(x))
                    .Select(x => x!)
                    .ToList();
                if (skills.Count > 0) seed.Skills = skills;
            }
        }
        catch { /* keep the seed on malformed JSON */ }

        return seed;
    }

    private static string? ExtractJsonObject(string text)
    {
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        return start >= 0 && end > start ? text[start..(end + 1)] : null;
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
