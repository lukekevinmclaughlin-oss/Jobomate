using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Filters;
using Jobomate.Llm;
using Jobomate.Sources;

namespace Jobomate.Browser;

public enum BrowserGoal { JobPostings, Companies }

public sealed class BrowserRunResult
{
    public List<JobPosting> Jobs { get; } = new();
    public List<CompanyTarget> Companies { get; } = new();
    public int Steps { get; set; }
    public string Summary { get; set; } = "";
    public bool Cancelled { get; set; }
    public int Count => Jobs.Count + Companies.Count;
}

/// <summary>
/// The provider-agnostic browser-automation agent. Given a starting URL and a goal (collect job
/// postings, or collect companies for unsolicited applications), it drives the <see cref="LmBrowser"/>
/// in a loop: observe the page → ask the connected LLM for the next action → act / extract → repeat,
/// until it has enough or runs out of steps. It uses <see cref="LlmClient.CompleteAsync"/>, so it
/// works with any of the six LLM connection types — exactly like the chat. On any login or CAPTCHA
/// it pauses and waits for the user to handle it in the visible browser window, then resumes.
/// </summary>
public sealed class BrowserAgent
{
    private readonly LlmClient _llm;
    private readonly Func<LlmConnectionConfig> _config;
    private readonly LmBrowser _browser;
    private readonly SearchPreferences _prefs;
    private readonly CandidateProfile _profile;
    private readonly Action<string> _onProgress;
    private readonly Action<string> _onAssistant;

    public BrowserAgent(
        LlmClient llm,
        Func<LlmConnectionConfig> config,
        LmBrowser browser,
        SearchPreferences prefs,
        CandidateProfile profile,
        Action<string> onProgress,
        Action<string> onAssistant)
    {
        _llm = llm;
        _config = config;
        _browser = browser;
        _prefs = prefs;
        _profile = profile;
        _onProgress = onProgress;
        _onAssistant = onAssistant;
    }

    public async Task<BrowserRunResult> RunAsync(string startUrl, BrowserGoal goal, int targetCount, string searchRunId, CancellationToken ct = default)
    {
        var result = new BrowserRunResult();
        // Recruiter mode sources people; "candidates" != "companies" so the page extractor still runs
        // its generic row harvester (title/company/location/desc/url), which fits a people listing too.
        var kind = goal == BrowserGoal.Companies ? "companies"
                 : _prefs.Mode == AppMode.Recruiter ? "candidates"
                 : "jobs";
        var jobs = new List<JsonElement>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var history = new List<string>();
        const int maxSteps = 18;

        if (!await _browser.EnsureStartedAsync(ct).ConfigureAwait(false))
        {
            result.Summary = "Couldn't start the LLM Browser.";
            return result;
        }
        if (!string.IsNullOrWhiteSpace(startUrl))
            await _browser.OpenAsync(startUrl, ct).ConfigureAwait(false);

        var step = 0;
        for (; step < maxSteps && jobs.Count < targetCount; step++)
        {
            if (ct.IsCancellationRequested) { result.Cancelled = true; break; }

            var obsJson = await _browser.ObserveAsync(ct).ConfigureAwait(false);
            JsonElement obs;
            try { obs = JsonDocument.Parse(obsJson).RootElement; }
            catch { history.Add($"step {step + 1}: page snapshot failed"); continue; }

            if (obs.TryGetProperty("needsUser", out var nu) && nu.ValueKind == JsonValueKind.True)
            {
                var reason = obs.TryGetProperty("reason", out var r) ? (r.GetString() ?? "login/verification") : "login/verification";
                _browser.FlagNeedsUser(reason);
                _onAssistant($"The site needs you to handle “{reason}”. I’ve opened the LLM Browser — please complete it there, then click “Resume — I’ve handled it”. I never bypass logins or CAPTCHAs.");
                _onProgress("Paused — waiting for you to log in / verify in the browser");
                await _browser.WaitForResumeAsync(ct).ConfigureAwait(false);
                continue; // re-observe after the user resumes
            }

            var messages = BuildMessages(goal, kind, obsJson, jobs.Count, targetCount, step + 1, maxSteps, history);

            string resp;
            try
            {
                resp = await _llm.CompleteAsync(_config(), messages, new LlmCallOptions(MaxOutputTokens: 400, Temperature: 0), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { result.Cancelled = true; break; }
            catch (Exception ex) { _onAssistant("The model hit a problem while browsing: " + ex.Message); break; }

            var act = ParseAction(resp);
            if (act is null)
            {
                // Model didn't return a parseable action — default to extracting what's on screen.
                act = new AgentAction("extract", 0, "", "", false, "no parseable action");
            }

            _onProgress($"Step {step + 1}/{maxSteps}: {act.Describe()} · {jobs.Count} {kind} so far");

            if (act.Action == "finish") { history.Add($"step {step + 1}: finish"); break; }

            if (act.Action == "extract")
            {
                var raw = await _browser.ExtractAsync(kind, ct).ConfigureAwait(false);
                var added = 0;
                try
                {
                    foreach (var it in JsonDocument.Parse(raw).RootElement.EnumerateArray())
                    {
                        var key = KeyFor(goal, it);
                        if (string.IsNullOrWhiteSpace(key) || !seen.Add(key)) continue;
                        jobs.Add(it.Clone());
                        added++;
                    }
                }
                catch { }
                history.Add($"step {step + 1}: extracted {added} new {kind} (total {jobs.Count})");
                _onProgress($"Extracted {added} new {kind} (total {jobs.Count})");
            }
            else
            {
                var res = await _browser.ActAsync(act.Action, act.Index, act.Text, act.Direction, act.Enter, ct).ConfigureAwait(false);
                history.Add($"step {step + 1}: {act.Describe()} -> {res}");
            }

            if (history.Count > 8) history.RemoveRange(0, history.Count - 8);
        }

        result.Steps = step;
        MaterializeResults(goal, jobs, searchRunId, result);
        result.Summary = goal == BrowserGoal.Companies
            ? $"Collected {result.Companies.Count} company target(s) in {step} step(s)."
            : _prefs.Mode == AppMode.Recruiter
                ? $"Sourced {result.Jobs.Count} candidate(s) in {step} step(s)."
                : $"Collected {result.Jobs.Count} job posting(s) in {step} step(s).";
        return result;
    }

    // ---- LLM prompting ----

    private List<ChatMessage> BuildMessages(BrowserGoal goal, string kind, string obsJson, int collected, int target, int step, int maxSteps, List<string> history)
    {
        var recruiter = _prefs.Mode == AppMode.Recruiter;
        var goalText = goal == BrowserGoal.Companies
            ? (recruiter
                ? "build a list of COMPANIES the recruiter could source candidates from"
                : "build a list of COMPANIES the user could send a speculative / unsolicited job application to")
            : (recruiter
                ? "build a list of CANDIDATES (individual people) who fit the role the recruiter is hiring for — each with their name/headline, current employer, and a profile link"
                : "build a list of JOB POSTINGS the user could apply to");

        string who;
        if (recruiter)
            who = string.IsNullOrWhiteSpace(_profile.Headline)
                ? "No role brief is loaded yet; source generally strong candidates and capture their headline + current employer."
                : $"The recruiter is hiring for: {_profile.Headline}{(string.IsNullOrWhiteSpace(_profile.Location) ? "" : " (" + _profile.Location + ")")}. Required skills: {string.Join(", ", _profile.Skills)}. Look for people who match.";
        else
            who = string.IsNullOrWhiteSpace(_profile.FullName) && string.IsNullOrWhiteSpace(_profile.Headline)
                ? "The user has not loaded a CV yet."
                : $"The user is {_profile.FullName}{(string.IsNullOrWhiteSpace(_profile.Headline) ? "" : " — " + _profile.Headline)}.";

        var sb = new StringBuilder();
        sb.Append("You are operating a real web browser (the Jobomate LM Browser) to ").Append(goalText).Append(" for the user. ");
        sb.Append("The user is logged in where needed and handles any CAPTCHA. ").Append(who).Append(' ');
        sb.Append("Each turn you receive a JSON snapshot of the CURRENT page with: url, title, a text digest, ");
        sb.Append("`links` (indexed clickable elements: {i,t,h}) and `inputs` (indexed text fields: {i,ph}). ");
        sb.Append("Reply with EXACTLY ONE JSON object and nothing else — choose one action:\n");
        sb.Append("{\"action\":\"navigate\",\"url\":\"https://…\"} — load a specific URL\n");
        sb.Append("{\"action\":\"type\",\"index\":N,\"text\":\"…\",\"enter\":true} — type into input N (e.g. a search box) and press Enter\n");
        sb.Append("{\"action\":\"click\",\"index\":N} — click link N (a job/company, a 'Next' page, an 'Apply', etc.)\n");
        sb.Append("{\"action\":\"scroll\",\"direction\":\"down\"} — reveal more results on the page\n");
        sb.Append("{\"action\":\"extract\"} — harvest all ").Append(kind).Append(" currently on this page into the list\n");
        sb.Append("{\"action\":\"finish\"} — stop; the list is good enough\n");
        if (goal == BrowserGoal.Companies)
            sb.Append("Strategy: reach a page that LISTS individual employers/companies (a directory, a 'companies' page, or search results). ");
        else if (recruiter)
            sb.Append("Strategy: reach a page that LISTS individual PEOPLE / CANDIDATES — each row showing a person's name or headline AND ideally their current employer (e.g. a professional-network people search, a talent directory, or conference/community member lists). ");
        else
            sb.Append("Strategy: reach a page that LISTS individual JOB POSTINGS — each row showing a specific role title AND a company. ");
        sb.Append("If the current page is a homepage, a category index, or just navigation (e.g. links like 'Programming', 'Design', 'Find Jobs'), do NOT extract yet — first `click` into a category/listing or `type` a search and Enter. ");
        sb.Append("Only `extract` once you can see actual ").Append(kind).Append(". After extracting, go to the next page (click 'Next' or scroll) and `extract` again, ");
        sb.Append("until you have about ").Append(target).Append(' ').Append(kind).Append(" or there are no more, then `finish`. Do not invent data — only extract what the page shows. ");
        if (!string.IsNullOrWhiteSpace(_prefs.LlmPersona))
            sb.Append("\n\nUser guidelines/persona (follow them): ").Append(_prefs.LlmPersona.Trim());
        if (_prefs.SearchSites.Count > 0)
            sb.Append("\n\nPreferred sites to search within: ").Append(string.Join(", ", _prefs.SearchSites));

        var user = new StringBuilder();
        user.Append("Step ").Append(step).Append('/').Append(maxSteps).Append(". Collected so far: ").Append(collected).Append('/').Append(target).Append(" ").Append(kind).Append(".\n");
        if (history.Count > 0)
            user.Append("Recent actions:\n").Append(string.Join("\n", history)).Append('\n');
        user.Append("Current page snapshot:\n").Append(obsJson);
        user.Append("\nRespond with one JSON action only.");

        return new List<ChatMessage>
        {
            new("system", sb.ToString()),
            new("user", user.ToString()),
        };
    }

    private sealed record AgentAction(string Action, int Index, string Text, string Direction, bool Enter, string Raw)
    {
        public string Describe() => Action switch
        {
            "navigate" => "navigate → " + Text,
            "click" => "click link #" + Index,
            "type" => $"type “{Text}” into #{Index}" + (Enter ? " + Enter" : ""),
            "scroll" => "scroll " + Direction,
            "extract" => "extract",
            "finish" => "finish",
            _ => Action,
        };
    }

    private static AgentAction? ParseAction(string resp)
    {
        if (string.IsNullOrWhiteSpace(resp)) return null;
        var json = ExtractFirstJsonObject(resp);
        if (json is null) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var action = (root.TryGetProperty("action", out var a) ? a.GetString() : null)?.Trim().ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(action)) return null;
            var index = root.TryGetProperty("index", out var i) && i.TryGetInt32(out var iv) ? iv : 0;
            var url = root.TryGetProperty("url", out var u) ? u.GetString() ?? "" : "";
            var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
            if (action == "navigate" && string.IsNullOrWhiteSpace(text)) text = url;
            var dir = root.TryGetProperty("direction", out var d) ? (d.GetString() ?? "down") : "down";
            var enter = root.TryGetProperty("enter", out var e) && (e.ValueKind == JsonValueKind.True || (e.ValueKind == JsonValueKind.String && e.GetString() == "true"));
            return new AgentAction(action, index, text, dir, enter, json);
        }
        catch { return null; }
    }

    private static string? ExtractFirstJsonObject(string s)
    {
        var start = s.IndexOf('{');
        if (start < 0) return null;
        var depth = 0;
        var inStr = false;
        var esc = false;
        for (var k = start; k < s.Length; k++)
        {
            var c = s[k];
            if (inStr)
            {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
            }
            else
            {
                if (c == '"') inStr = true;
                else if (c == '{') depth++;
                else if (c == '}') { depth--; if (depth == 0) return s.Substring(start, k - start + 1); }
            }
        }
        return null;
    }

    // ---- mapping to domain models ----

    private static string KeyFor(BrowserGoal goal, JsonElement it)
    {
        string S(string p) => it.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        return goal == BrowserGoal.Companies
            ? S("name").Trim().ToLowerInvariant()
            : (S("title") + "|" + S("url")).Trim().ToLowerInvariant();
    }

    private void MaterializeResults(BrowserGoal goal, List<JsonElement> items, string runId, BrowserRunResult result)
    {
        foreach (var it in items)
        {
            string S(string p) => it.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
            if (goal == BrowserGoal.Companies)
            {
                var name = S("name").Trim();
                if (string.IsNullOrWhiteSpace(name)) continue;
                result.Companies.Add(new CompanyTarget
                {
                    Name = name,
                    Website = S("website"),
                    CareersUrl = S("website"),
                    Location = S("location"),
                    Notes = "Collected by the LLM Browser (your logged-in LM Browser session).",
                    SearchRunId = runId,
                });
            }
            else
            {
                var title = S("title").Trim();
                if (string.IsNullOrWhiteSpace(title)) continue;
                var desc = S("description");
                var email = EmailIn(desc);
                var url = S("url");
                var job = new JobPosting
                {
                    Source = "LLM Browser",
                    SourceUrl = url,
                    Company = S("company"),
                    Title = title,
                    Location = S("location"),
                    RawDescription = desc,
                    ContactEmail = email,
                    ApplicationMethod = string.IsNullOrWhiteSpace(email) ? ApplicationMethod.Portal : ApplicationMethod.Email,
                    PortalUrl = string.IsNullOrWhiteSpace(email) ? url : "",
                    ConfidenceScore = 0.6,
                    ExtractionNotes = "Collected by the LLM Browser (your logged-in LM Browser session).",
                    SearchRunId = runId,
                };
                result.Jobs.Add(JobNormalization.Finalize(job));
            }
        }
    }

    private static readonly Regex EmailRx = new(@"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", RegexOptions.Compiled);
    private static string EmailIn(string s)
    {
        var m = EmailRx.Match(s ?? "");
        return m.Success ? m.Value : "";
    }
}
