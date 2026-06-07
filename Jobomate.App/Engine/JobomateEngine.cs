using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Browser;
using Jobomate.Contracts;
using Jobomate.Drafting;
using Jobomate.Llm;
using Jobomate.Scheduling;
using Jobomate.Sources;

namespace Jobomate.Engine;

/// <summary>
/// Headless orchestration for the merged (Electron-shell) app: a thin, UI-free port of the flows the
/// Avalonia AssistantView used to drive — chat + directives, CV load, browser research, drafting,
/// approval, scheduling, email preparation — all returning plain data the React UI renders. Reuses
/// the existing <see cref="JobomateServices"/> stack unchanged; drives the in-app browser through the
/// same LmBrowser client (which talks to the Electron control server on port 9222).
/// </summary>
public sealed class JobomateEngine
{
    public JobomateServices Services { get; } = new();
    private readonly List<ChatMessage> _history = new();

    public JobomateEngine()
    {
        // Optional injection path (headless/dev, or when the parent app wants to hand the engine its key
        // without a Keychain round-trip): JOBOMATE_LLM_KEY stores the key for the configured provider
        // and marks the connection live.
        var key = Environment.GetEnvironmentVariable("JOBOMATE_LLM_KEY");
        if (!string.IsNullOrWhiteSpace(key))
        {
            try
            {
                Services.Credentials.StoreApiKey(LlmClient.ApiKeyName(Services.LlmConfig.ApiProvider), key);
                var c = Services.LlmConfig;
                if (!c.Connected) { c.Connected = true; Services.SaveLlmConfig(c); }
            }
            catch { }
        }
    }

    // ---------------------------------------------------------------- config / status ----

    public bool LlmConfigured()
    {
        var c = Services.LlmConfig;
        if (!c.Connected) return false;
        return c.ConnectionType switch
        {
            AppConnectionType.ApiKey => !string.IsNullOrEmpty(Services.Credentials.GetApiKey(LlmClient.ApiKeyName(c.ApiProvider))),
            AppConnectionType.LocalServer => !string.IsNullOrWhiteSpace(c.LocalServerUrl),
            AppConnectionType.LocalAI => !string.IsNullOrWhiteSpace(c.LocalAIModelPath),
            AppConnectionType.CliPipe => !string.IsNullOrWhiteSpace(c.CliCommand),
            AppConnectionType.Terminal => !string.IsNullOrWhiteSpace(c.TerminalCommand),
            _ => true,
        };
    }

    public object Status()
    {
        var s = Services;
        var (pt, ct, _) = s.CostLedger.Totals();
        var drafts = s.DraftRepo.All();
        return new
        {
            connected = LlmConfigured(),
            model = s.LlmConfig.ResolvedModel() ?? "",
            connectionType = s.LlmConfig.ConnectionType.ToString(),
            provider = s.LlmConfig.ApiProvider.ToString(),
            dryRun = s.BuildEmailSender().IsDryRun,
            emailProvider = s.EmailConfig.Provider.ToString(),
            status = s.Status,
            jobs = s.JobRepo.Count(),
            companies = s.CompanyRepo.Count(),
            draftsPending = drafts.Count(d => d.Status == DraftStatus.Draft),
            draftsApproved = drafts.Count(d => d.Status == DraftStatus.Approved),
            queued = s.QueueRepo.All().Count(i => i.Status == SendStatus.Pending),
            tokens = (pt ?? 0) + (ct ?? 0),
            profileName = s.Profile.FullName,
            profileHeadline = s.Profile.Headline,
            sites = s.Preferences.SearchSites,
            persona = s.Preferences.LlmPersona,
            browserRunning = s.Browser.IsRunning,
            browserStatus = s.Browser.Status,
            needsUser = s.Browser.NeedsUserReason,
        };
    }

    public void SetApiKey(string provider, string key)
    {
        if (Enum.TryParse<AppApiProvider>(provider, true, out var p) && !string.IsNullOrWhiteSpace(key))
            Services.Credentials.StoreApiKey(LlmClient.ApiKeyName(p), key);
    }

    public object ConnectLlm(bool connect)
    {
        var c = Services.LlmConfig;
        c.Connected = connect;
        Services.SaveLlmConfig(c);
        return Status();
    }

    // ---------------------------------------------------------------- chat ----

    public async Task<object> ChatAsync(string text, CancellationToken ct = default)
    {
        text = (text ?? "").Trim();
        if (text.Length == 0) return new { text = "", actions = Array.Empty<string>() };
        if (!LlmConfigured())
            return new { text = "Connect a model first (Settings → LLM) — then I can answer and run your job hunt.", actions = new[] { "settings" } };

        var messages = BuildMessages(text);
        string resp;
        try { resp = await Services.Llm.CompleteAsync(Services.LlmConfig, messages, new LlmCallOptions(MaxOutputTokens: 1000), ct).ConfigureAwait(false); }
        catch (Exception ex) { return new { text = "The model hit a problem: " + ex.Message, actions = Array.Empty<string>() }; }

        var (clean, actions) = ParseDirectives(resp ?? "");
        _history.Add(new ChatMessage("user", text));
        _history.Add(new ChatMessage("assistant", clean));
        if (_history.Count > 24) _history.RemoveRange(0, _history.Count - 24);
        return new { text = clean, actions };
    }

    private List<ChatMessage> BuildMessages(string userText)
    {
        var p = Services.Profile;
        var who = string.IsNullOrWhiteSpace(p.FullName) && string.IsNullOrWhiteSpace(p.Headline)
            ? "The user has not loaded a CV yet — if they want to apply for jobs, suggest loading one."
            : $"The user is {p.FullName}{(string.IsNullOrWhiteSpace(p.Headline) ? "" : " — " + p.Headline)}{(string.IsNullOrWhiteSpace(p.Location) ? "" : ", based in " + p.Location)}.";

        var drafts = Services.DraftRepo.All();
        var jobCount = Services.JobRepo.Count();
        var companyCount = Services.CompanyRepo.Count();
        var state = $"Current state: {jobCount} job postings collected, {companyCount} companies collected, {drafts.Count(d => d.Status == DraftStatus.Draft)} drafts pending, {drafts.Count(d => d.Status == DraftStatus.Approved)} approved.";

        var collected = "";
        if (jobCount > 0)
        {
            var rows = Services.JobRepo.All().OrderByDescending(j => j.Included).ThenByDescending(j => j.RankScore).Take(25)
                .Select(j => $"- {j.Title}{(string.IsNullOrWhiteSpace(j.Company) ? "" : " @ " + j.Company)}{(string.IsNullOrWhiteSpace(j.Location) ? "" : " (" + j.Location + ")")}");
            collected = "\n\nJob postings already collected (real, in the app — to display them use [[ACTION:list]], don't re-search):\n" + string.Join("\n", rows);
        }
        else if (companyCount > 0)
        {
            var rows = Services.CompanyRepo.All().Take(25).Select(c => $"- {c.Name}{(string.IsNullOrWhiteSpace(c.Website) ? "" : " — " + c.Website)}");
            collected = "\n\nCompanies already collected (real — to display use [[ACTION:list]]):\n" + string.Join("\n", rows);
        }

        var system =
            "You are the Jobomate assistant — a warm, capable copilot inside a job-search and application-automation browser. " +
            "Answer the user fully and naturally on ANY topic. " + who + " " + state + " " +
            "You also have specialised tools. When the user clearly wants one, append the matching directive on its OWN line at the very end of your reply — choose only from:\n" +
            "[[ACTION:research]] — drive the in-app browser to collect job postings from the user's sites\n" +
            "[[ACTION:companies]] — drive the browser to collect companies for speculative/unsolicited applications\n" +
            "[[ACTION:list]] — show the postings/companies already collected\n" +
            "[[ACTION:draft]] — draft tailored applications for the collected postings (you review before anything sends)\n" +
            "[[ACTION:prepare]] — put the application emails in the user's Gmail (open Gmail; they log in)\n" +
            "[[ACTION:approve]] — approve all pending drafts\n" +
            "[[ACTION:send]] — send due items (dry-run unless a real email account is connected)\n" +
            "[[ACTION:settings]] — open settings\n" +
            "Only add a directive when the user actually asks for that action; otherwise reply normally with no directive. " +
            "When drafting, never invent the user's skills, employers, titles, or experience. Keep replies concise.";

        var persona = Services.Preferences.LlmPersona;
        if (!string.IsNullOrWhiteSpace(persona))
            system += "\n\nThe user's guidelines/persona — follow them closely:\n" + persona.Trim();
        var sites = Services.Preferences.SearchSites;
        if (sites.Count > 0)
            system += "\n\nThe user scoped your research to these sites:\n" + string.Join("\n", sites);
        system += collected;

        var msgs = new List<ChatMessage> { new("system", system) };
        msgs.AddRange(_history.TakeLast(16));
        msgs.Add(new ChatMessage("user", userText));
        return msgs;
    }

    private static (string Text, List<string> Actions) ParseDirectives(string resp)
    {
        var actions = new List<string>();
        var rx = new Regex(@"\[\[ACTION:\s*(\w+)\s*\]\]", RegexOptions.IgnoreCase);
        foreach (Match m in rx.Matches(resp)) actions.Add(m.Groups[1].Value.ToLowerInvariant());
        var text = rx.Replace(resp, "").Trim();
        return (text, actions);
    }

    // ---------------------------------------------------------------- CV ----

    public async Task<object> LoadCvAsync(string path, CancellationToken ct = default)
    {
        var llm = LlmConfigured() ? Services.Llm : null;
        var cfg = LlmConfigured() ? Services.LlmConfig : null;
        var profile = await Services.Profiles.BuildFromCvAsync(path, llm, cfg, ct).ConfigureAwait(false);
        Services.SaveProfile(profile);
        return new { name = profile.FullName, headline = profile.Headline, location = profile.Location, skills = profile.Skills.Count, languages = profile.Languages.Select(l => l.Language + ":" + l.Level) };
    }

    // ---------------------------------------------------------------- research (browser agent) ----

    public async Task<object> ResearchAsync(string goal, string? startUrl, Action<string> onProgress, CancellationToken ct = default)
    {
        if (!LlmConfigured()) return new { error = "Connect a model first — the browser is driven by your connected model." };
        var g = goal == "companies" ? BrowserGoal.Companies : BrowserGoal.JobPostings;
        var sites = Services.Preferences.SearchSites;
        var url = !string.IsNullOrWhiteSpace(startUrl) ? startUrl!
            : sites.Count > 0 ? sites[0]
            : g == BrowserGoal.Companies ? "https://www.google.com/search?q=companies+hiring"
            : "https://www.linkedin.com/jobs/";

        var run = new SearchRun { Mode = g == BrowserGoal.Companies ? SearchMode.Unsolicited : SearchMode.RecentJobs, Status = SearchRunStatus.Running };
        Services.SearchRunRepo.Upsert(run);
        var agent = Services.BuildBrowserAgent(onProgress, onProgress);
        var result = await agent.RunAsync(url, g, 25, run.Id, ct).ConfigureAwait(false);
        if (g == BrowserGoal.Companies) Services.CompanyRepo.UpsertAll(result.Companies);
        else Services.JobRepo.UpsertAll(result.Jobs);
        run.Status = SearchRunStatus.Completed; run.CompletedAt = DateTimeOffset.UtcNow; run.ResultCount = result.Count;
        Services.SearchRunRepo.Upsert(run);
        return new { jobs = result.Jobs.Count, companies = result.Companies.Count, summary = result.Summary };
    }

    // ---------------------------------------------------------------- repos (read) ----

    public object Jobs() => Services.JobRepo.All()
        .OrderByDescending(j => j.Included).ThenByDescending(j => j.RankScore)
        .Select(j => new { id = j.Id, title = j.Title, company = j.Company, location = j.Location, url = j.SourceUrl, email = j.ContactEmail, included = j.Included }).ToList();

    public object Companies() => Services.CompanyRepo.All()
        .Select(c => new { id = c.Id, name = c.Name, website = c.Website, location = c.Location, email = c.RecruitingEmail }).ToList();

    public object Drafts() => Services.DraftRepo.All().Select(d =>
    {
        var email = Services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == d.Id);
        return new { id = d.Id, company = d.Company, role = d.RoleTitle, status = d.Status.ToString(), to = email?.ToAddress ?? "", subject = email?.Subject ?? "", body = email?.Body ?? "" };
    }).ToList();

    // ---------------------------------------------------------------- drafting ----

    public async Task<object> DraftAsync(string kind, string[] ids, CancellationToken ct = default)
    {
        var profile = Services.Profile;
        var cv = string.IsNullOrEmpty(profile.CvDocumentId) ? null : Services.Profiles.CvDocument(profile.CvDocumentId);
        var gen = Services.BuildDraftGenerator();
        var configured = LlmConfigured();
        var made = 0;

        if (kind == "company")
        {
            var companies = ids.Length > 0 ? ids.Select(i => Services.CompanyRepo.Get(i)).Where(c => c is not null).Select(c => c!).ToList() : Services.CompanyRepo.All().ToList();
            foreach (var c in companies)
            {
                if (ct.IsCancellationRequested) break;
                var res = configured ? await SafeDraftAsync(() => gen.ForCompanyAsync(profile, c, cv), () => DraftGenerator.OfflineForCompany(profile, c, cv)).ConfigureAwait(false)
                                     : DraftGenerator.OfflineForCompany(profile, c, cv);
                Persist(new ApplicationDraft { Kind = ApplicationKind.Unsolicited, CompanyTargetId = c.Id, Company = c.Name, RoleTitle = "Speculative application" }, res);
                made++;
            }
        }
        else
        {
            var jobs = ids.Length > 0 ? ids.Select(i => Services.JobRepo.Get(i)).Where(j => j is not null).Select(j => j!).ToList() : Services.JobRepo.All().ToList();
            foreach (var j in jobs)
            {
                if (ct.IsCancellationRequested) break;
                var res = configured ? await SafeDraftAsync(() => gen.ForJobAsync(profile, j, cv), () => DraftGenerator.OfflineForJob(profile, j, cv)).ConfigureAwait(false)
                                     : DraftGenerator.OfflineForJob(profile, j, cv);
                Persist(new ApplicationDraft { Kind = ApplicationKind.JobApplication, JobPostingId = j.Id, Company = j.Company, RoleTitle = j.Title }, res);
                made++;
            }
        }
        return new { drafted = made };
    }

    private static async Task<DraftResult> SafeDraftAsync(Func<Task<DraftResult>> online, Func<DraftResult> offline)
    {
        try { return await online().ConfigureAwait(false); } catch { return offline(); }
    }

    private void Persist(ApplicationDraft draft, DraftResult result)
    {
        draft.CoverLetterText = result.CoverLetter;
        Services.DraftRepo.Upsert(draft);
        var email = result.Email; email.ApplicationDraftId = draft.Id;
        Services.EmailRepo.Upsert(email);
    }

    // ---------------------------------------------------------------- approval / send ----

    public object Approve(string[] ids)
    {
        var n = ids.Length > 0 ? Services.Approval.ApproveBatch(ids.ToList())
                               : Services.Approval.ApproveBatch(Services.DraftRepo.All().Where(d => d.Status == DraftStatus.Draft).Select(d => d.Id).ToList());
        return new { approved = n };
    }

    public object Schedule()
    {
        var queue = Services.BuildQueueService();
        var approved = Services.DraftRepo.All().Where(d => d.Status == DraftStatus.Approved).ToList();
        var n = approved.Count(d => queue.Enqueue(d.Id) is not null);
        return new { scheduled = n, of = approved.Count };
    }

    private SendRunner? _sendRunner;
    public async Task<object> SendDueAsync()
    {
        _sendRunner ??= Services.BuildSendRunner();
        var sent = await _sendRunner.RunDueAsync().ConfigureAwait(false);
        var dry = Services.BuildEmailSender().IsDryRun;
        return new { sent, dryRun = dry, state = _sendRunner.State.ToString(), message = _sendRunner.LastMessage };
    }

    // ---------------------------------------------------------------- browser + email ----

    public async Task<object> OpenBrowserAsync(string url, CancellationToken ct = default)
        => new { ok = await Services.Browser.OpenAsync(url, ct).ConfigureAwait(false), url = Services.Browser.CurrentUrl };

    public object BrowserStatus() => new { running = Services.Browser.IsRunning, status = Services.Browser.Status, needsUser = Services.Browser.NeedsUserReason, url = Services.Browser.CurrentUrl };

    public object ResumeBrowser() { Services.Browser.Resume(); return BrowserStatus(); }

    public async Task<object> PrepareEmailsAsync(CancellationToken ct = default)
    {
        var emails = Services.EmailRepo.All().Where(e => !string.IsNullOrWhiteSpace(e.ToAddress)).ToList();
        await Services.Browser.OpenAsync("https://mail.google.com/", ct).ConfigureAwait(false);
        return new { ready = emails.Count };
    }

    public async Task<object> CreateGmailDraftsAsync(CancellationToken ct = default)
    {
        var emails = Services.EmailRepo.All().Where(e => !string.IsNullOrWhiteSpace(e.ToAddress)).ToList();
        if (emails.Count == 0) return new { created = 0, error = "no emails with a recipient" };
        if (!await Services.Browser.IsGmailLoggedInAsync(ct).ConfigureAwait(false))
            return new { created = 0, error = "not signed into Gmail in the browser" };
        var ok = 0;
        foreach (var e in emails)
        {
            if (ct.IsCancellationRequested) break;
            try { if (await Services.Browser.ComposeGmailDraftAsync(e.ToAddress, e.Subject, e.Body, ct).ConfigureAwait(false)) ok++; } catch { }
        }
        return new { created = ok, of = emails.Count };
    }

    // ---------------------------------------------------------------- preferences ----

    public void SaveSites(IEnumerable<string> sites) { var p = Services.Preferences; p.SearchSites = sites.Where(s => !string.IsNullOrWhiteSpace(s)).Distinct().ToList(); Services.SavePreferences(p); }
    public void SavePersona(string persona) { var p = Services.Preferences; p.LlmPersona = persona ?? ""; Services.SavePreferences(p); }
}
