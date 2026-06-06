using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Llm;

namespace Jobomate.Sources;

/// <summary>Offline sample employers for unsolicited mode (no keys/LLM needed).</summary>
public sealed class MockCompanyResearchSource : ICompanyResearchSource
{
    public string Name => "Sample employers (offline)";

    public Task<IReadOnlyList<CompanyTarget>> ResearchAsync(CompanyResearchRequest request, CancellationToken ct = default)
    {
        var list = new List<CompanyTarget>
        {
            new() { Name = "Helix Therapeutics", Website = "https://helixtx.example", Industry = "Biotech",
                Location = "Munich", RecruitingEmail = "talent@helixtx.example", RecruitingEmailEvidence = "Published on careers page",
                ContactStatus = ContactStatus.HasEmail, FitScore = 0.82,
                FitExplanation = "B2B biotech in Munich — strong match for AI-driven growth marketing." },
            new() { Name = "GenomEU", Website = "https://genomeu.example", Industry = "Life sciences",
                Location = "EU (remote)", RecruitingEmail = "careers@genomeu.example", RecruitingEmailEvidence = "Published on jobs page",
                ContactStatus = ContactStatus.HasEmail, FitScore = 0.74,
                FitExplanation = "Remote-first life-science company; demand-gen and SEO focus." },
            new() { Name = "MünchenBio GmbH", Website = "https://muenchenbio.example", Industry = "Biotech",
                Location = "Munich", ContactStatus = ContactStatus.NeedsManualContact, FitScore = 0.68,
                FitExplanation = "Local Munich biotech; no published recruiting email found — needs manual contact.",
                RiskNotes = "No official application email located." },
        };
        return Task.FromResult<IReadOnlyList<CompanyTarget>>(list.Take(request.Limit <= 0 ? 20 : request.Limit).ToList());
    }
}

/// <summary>
/// Uses the configured LLM to propose suitable employers, then verifies a *published*
/// recruiting email via <see cref="CompanyEmailFinder"/>. Emails are never invented;
/// companies without a published address are marked "Needs manual contact".
/// </summary>
public sealed class LlmCompanyResearchSource : ICompanyResearchSource
{
    private readonly LlmClient _llm;
    private readonly LlmConnectionConfig _cfg;
    private readonly CandidateProfile _profile;
    private readonly CompanyEmailFinder _emailFinder;

    public LlmCompanyResearchSource(LlmClient llm, LlmConnectionConfig cfg, CandidateProfile profile, CompanyEmailFinder emailFinder)
    {
        _llm = llm;
        _cfg = cfg;
        _profile = profile;
        _emailFinder = emailFinder;
    }

    public string Name => "LLM company research";

    public async Task<IReadOnlyList<CompanyTarget>> ResearchAsync(CompanyResearchRequest request, CancellationToken ct = default)
    {
        var limit = request.Limit <= 0 ? 12 : request.Limit;
        var prompt =
            $"Propose up to {limit} real companies that would be a strong fit for this candidate for an unsolicited application.\n" +
            $"Candidate: {_profile.Headline}; {_profile.YearsExperience}+ yrs; based in {_profile.Location}; " +
            $"industries: {string.Join(", ", _profile.Industries)}; available from {JobomateConstants.AvailabilityText}.\n" +
            $"Target industries: {string.Join(", ", request.Industries.DefaultIfEmpty("biotech, life sciences"))}. " +
            $"Geography: {string.Join(", ", request.Geographies.DefaultIfEmpty("Germany, EU, remote"))}.\n" +
            "Return ONLY a JSON array of objects: [{\"name\":\"\",\"website\":\"\",\"industry\":\"\",\"location\":\"\",\"why\":\"\"}]. " +
            "Use real companies with real public websites. Do not invent email addresses. Do not mention any personal circumstances.";

        var resp = await _llm.CompleteAsync(_cfg,
            new[]
            {
                new ChatMessage("system", "You are a precise B2B market-research assistant. Output JSON only."),
                new ChatMessage("user", prompt),
            },
            new LlmCallOptions(MaxOutputTokens: 1200), ct).ConfigureAwait(false);

        var json = ExtractArray(resp);
        if (json is null) return Array.Empty<CompanyTarget>();

        var targets = new List<CompanyTarget>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                if (ct.IsCancellationRequested) break;
                var name = JsonX.Str(el, "name");
                if (string.IsNullOrWhiteSpace(name)) continue;

                var website = JsonX.Str(el, "website");
                var target = new CompanyTarget
                {
                    Name = name,
                    Website = website,
                    Industry = JsonX.Str(el, "industry"),
                    Location = JsonX.Str(el, "location"),
                    FitExplanation = JsonX.Str(el, "why"),
                    FitScore = 0.6,
                    ContactStatus = ContactStatus.NeedsManualContact,
                };

                if (!string.IsNullOrWhiteSpace(website))
                {
                    var (email, evidence, status) = await _emailFinder.FindAsync(website, ct).ConfigureAwait(false);
                    target.RecruitingEmail = email;
                    target.RecruitingEmailEvidence = evidence;
                    target.ContactStatus = status;
                    if (status == ContactStatus.NeedsManualContact)
                        target.RiskNotes = "No published recruiting email found — needs manual contact.";
                }

                targets.Add(target);
                if (targets.Count >= limit) break;
            }
        }
        catch { /* malformed JSON */ }

        return targets;
    }

    private static string? ExtractArray(string text)
    {
        var start = text.IndexOf('[');
        var end = text.LastIndexOf(']');
        return start >= 0 && end > start ? text[start..(end + 1)] : null;
    }
}

/// <summary>Aggregates company-research sources and dedups by normalized name.</summary>
public sealed class CompanyResearchService
{
    private readonly IReadOnlyList<ICompanyResearchSource> _sources;
    public CompanyResearchService(IEnumerable<ICompanyResearchSource> sources) => _sources = sources.ToList();

    public IReadOnlyList<string> SourceNames => _sources.Select(s => s.Name).ToList();

    public async Task<IReadOnlyList<CompanyTarget>> ResearchAsync(CompanyResearchRequest request, CancellationToken ct = default)
    {
        var all = new List<CompanyTarget>();
        foreach (var source in _sources)
        {
            try { all.AddRange(await source.ResearchAsync(request, ct).ConfigureAwait(false)); }
            catch { /* one failing source must not break research */ }
        }

        return all
            .GroupBy(c => JobNormalization.NormalizeToken(c.Name))
            .Select(g => g.First())
            .ToList();
    }
}
