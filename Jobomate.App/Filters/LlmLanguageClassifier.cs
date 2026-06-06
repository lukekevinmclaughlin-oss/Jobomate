using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Llm;
using Jobomate.Sources;

namespace Jobomate.Filters;

/// <summary>
/// Uses the LLM to classify a posting's language requirements <b>with evidence</b>. The
/// model must quote the exact phrase that justifies each language; entries without
/// evidence are dropped so the posting stays "unclear" (the model is never allowed to guess).
/// </summary>
public sealed class LlmLanguageClassifier
{
    private readonly LlmClient _llm;
    private readonly LlmConnectionConfig _cfg;

    public LlmLanguageClassifier(LlmClient llm, LlmConnectionConfig cfg)
    {
        _llm = llm;
        _cfg = cfg;
    }

    public async Task ClassifyAsync(JobPosting job, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(job.RawDescription)) return;

        var prompt =
            "From the job posting below, identify the required and preferred (nice-to-have) human languages.\n" +
            "For EVERY language you list you MUST quote the exact phrase from the posting as evidence.\n" +
            "Do NOT guess: if a language requirement is not explicitly stated in the text, do not include it.\n" +
            "Return ONLY JSON: {\"required\":[{\"language\":\"\",\"evidence\":\"\"}],\"preferred\":[{\"language\":\"\",\"evidence\":\"\"}]}.\n\n" +
            "Posting:\n" + Truncate(job.RawDescription, 6000);

        string resp;
        try
        {
            resp = await _llm.CompleteAsync(_cfg,
                new[]
                {
                    new ChatMessage("system", "You classify language requirements from job postings and output JSON only. You never invent requirements."),
                    new ChatMessage("user", prompt),
                },
                new LlmCallOptions(MaxOutputTokens: 500), ct).ConfigureAwait(false);
        }
        catch
        {
            return; // leave the posting unclear on any error
        }

        var json = ExtractObject(resp);
        if (json is null) return;

        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var reqs = new List<LanguageRequirement>();
            reqs.AddRange(Read(root, "required", LanguageRequirementKind.Required));
            reqs.AddRange(Read(root, "preferred", LanguageRequirementKind.Preferred));
            if (reqs.Count > 0) job.LanguageRequirements = reqs;
        }
        catch { /* malformed JSON → leave unclear */ }
    }

    private static IEnumerable<LanguageRequirement> Read(JsonElement root, string prop, LanguageRequirementKind kind)
    {
        if (!root.TryGetProperty(prop, out var arr) || arr.ValueKind != JsonValueKind.Array) yield break;
        foreach (var el in arr.EnumerateArray())
        {
            var language = JsonX.Str(el, "language");
            var evidence = JsonX.Str(el, "evidence");
            // Enforce the no-guess rule: require both a language and a quoted phrase.
            if (string.IsNullOrWhiteSpace(language) || string.IsNullOrWhiteSpace(evidence)) continue;
            yield return new LanguageRequirement { Language = language, Kind = kind, Evidence = evidence };
        }
    }

    private static string? ExtractObject(string text)
    {
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        return start >= 0 && end > start ? text[start..(end + 1)] : null;
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
