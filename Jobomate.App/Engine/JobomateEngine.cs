using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
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
    private string _activeThreadId = "";

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
        EnsureActiveThread();
    }

    // ---------------------------------------------------------------- chat threads ----

    private void EnsureActiveThread()
    {
        var threads = Services.ThreadRepo.All().OrderByDescending(t => t.LastActiveAt).ToList();
        var active = threads.Count > 0 ? threads[0] : null;
        if (active is null) { active = new ChatThread(); Services.ThreadRepo.Upsert(active); }
        _activeThreadId = active.Id;
        // One-time migration: adopt any untagged jobs/drafts into the active thread so existing data stays visible.
        foreach (var j in Services.JobRepo.All().Where(j => string.IsNullOrEmpty(j.ThreadId)).ToList()) { j.ThreadId = _activeThreadId; Services.JobRepo.Upsert(j); }
        foreach (var d in Services.DraftRepo.All().Where(d => string.IsNullOrEmpty(d.ThreadId)).ToList()) { d.ThreadId = _activeThreadId; Services.DraftRepo.Upsert(d); }
        foreach (var c in Services.CompanyRepo.All().Where(c => string.IsNullOrEmpty(c.ThreadId)).ToList()) { c.ThreadId = _activeThreadId; Services.CompanyRepo.Upsert(c); }
        LoadHistory(active);
    }

    private void LoadHistory(ChatThread t)
    {
        _history.Clear();
        if (string.IsNullOrWhiteSpace(t.MessagesJson)) return;
        try
        {
            using var doc = JsonDocument.Parse(t.MessagesJson);
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                var role = el.TryGetProperty("role", out var r) ? r.GetString() ?? "" : "";
                var text = el.TryGetProperty("text", out var x) ? x.GetString() ?? "" : "";
                if (role is "user" or "assistant") _history.Add(new ChatMessage(role, text));
            }
        }
        catch { }
    }

    private void PersistThreadMessages()
    {
        var t = Services.ThreadRepo.Get(_activeThreadId);
        if (t is null) return;
        t.MessagesJson = JsonSerializer.Serialize(_history.Select(m => new { role = m.Role, text = m.Content }));
        var firstUser = _history.FirstOrDefault(m => m.Role == "user");
        if (firstUser is not null && (string.IsNullOrWhiteSpace(t.Title) || t.Title == "New chat"))
            t.Title = firstUser.Content.Length <= 42 ? firstUser.Content : firstUser.Content[..42] + "…";
        t.LastActiveAt = DateTimeOffset.UtcNow;
        Services.ThreadRepo.Upsert(t);
    }

    private object ThreadView(ChatThread t) => new
    {
        id = t.Id,
        title = string.IsNullOrWhiteSpace(t.Title) ? "New chat" : t.Title,
        lastActive = t.LastActiveAt.ToUnixTimeMilliseconds(),
        active = t.Id == _activeThreadId,
        jobs = Services.JobRepo.All().Count(j => j.ThreadId == t.Id),
        drafts = Services.DraftRepo.All().Count(d => d.ThreadId == t.Id),
    };

    public object Threads() => Services.ThreadRepo.All().OrderByDescending(t => t.LastActiveAt).Select(ThreadView).ToList();

    public object NewThread()
    {
        var t = new ChatThread();
        Services.ThreadRepo.Upsert(t);
        _activeThreadId = t.Id;
        _history.Clear();
        return new { id = t.Id, title = t.Title, messages = Array.Empty<object>() };
    }

    public object SwitchThread(string id)
    {
        var t = Services.ThreadRepo.Get(id);
        if (t is null) return new { error = "thread not found" };
        _activeThreadId = id;
        LoadHistory(t);
        return ThreadMessages();
    }

    public object ThreadMessages()
    {
        var t = Services.ThreadRepo.Get(_activeThreadId);
        return new
        {
            id = _activeThreadId,
            title = t?.Title ?? "New chat",
            messages = _history.Select(m => new { role = m.Role, content = m.Content }).ToList(),
        };
    }

    public object DeleteThreads(string[] ids)
    {
        foreach (var id in ids)
        {
            if (string.IsNullOrWhiteSpace(id)) continue;
            foreach (var j in Services.JobRepo.All().Where(j => j.ThreadId == id).ToList()) Services.JobRepo.Delete(j.Id);
            foreach (var d in Services.DraftRepo.All().Where(d => d.ThreadId == id).ToList())
            {
                var em = Services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == d.Id);
                if (em is not null) Services.EmailRepo.Delete(em.Id);
                Services.DraftRepo.Delete(d.Id);
            }
            Services.ThreadRepo.Delete(id);
        }
        if (ids.Contains(_activeThreadId) || Services.ThreadRepo.Get(_activeThreadId) is null) EnsureActiveThread();
        return new { deleted = ids.Length, active = _activeThreadId };
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
        var myDrafts = s.DraftRepo.All().Where(d => d.ThreadId == _activeThreadId).ToList();
        var hasCv = HasCv();
        return new
        {
            connected = LlmConfigured(),
            model = s.LlmConfig.ResolvedModel() ?? "",
            connectionType = s.LlmConfig.ConnectionType.ToString(),
            provider = s.LlmConfig.ApiProvider.ToString(),
            dryRun = s.BuildEmailSender().IsDryRun,
            emailProvider = s.EmailConfig.Provider.ToString(),
            status = s.Status,
            threadId = _activeThreadId,
            jobs = s.JobRepo.All().Count(j => j.ThreadId == _activeThreadId),
            companies = s.CompanyRepo.All().Count(c => c.ThreadId == _activeThreadId),
            draftsPending = myDrafts.Count(d => d.Status == DraftStatus.Draft),
            draftsApproved = myDrafts.Count(d => d.Status == DraftStatus.Approved),
            queued = s.QueueRepo.All().Count(i => i.Status == SendStatus.Pending),
            tokens = (pt ?? 0) + (ct ?? 0),
            hasCv,
            profileName = hasCv ? s.Profile.FullName : "",
            profileHeadline = hasCv ? s.Profile.Headline : "",
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
        if (_history.Count > 40) _history.RemoveRange(0, _history.Count - 40);
        PersistThreadMessages();
        return new { text = clean, actions };
    }

    /// <summary>True only when a CV is genuinely loaded (a document is on file). The assistant must not
    /// claim or invent the user's name unless this holds.</summary>
    private bool HasCv()
    {
        var p = Services.Profile;
        return !string.IsNullOrEmpty(p.CvDocumentId) && Services.Profiles.CvDocument(p.CvDocumentId) is not null;
    }

    private List<ChatMessage> BuildMessages(string userText)
    {
        var p = Services.Profile;
        var hasCv = HasCv();
        var who = hasCv && !string.IsNullOrWhiteSpace(p.FullName)
            ? $"The user's name is {p.FullName}{(string.IsNullOrWhiteSpace(p.Headline) ? "" : " — " + p.Headline)}{(string.IsNullOrWhiteSpace(p.Location) ? "" : ", based in " + p.Location)} (from their loaded CV). "
              + "Do NOT open every message with \"Hi <name>\"; use their name only occasionally and when it reads naturally."
            : "No CV is loaded, so you do NOT know the user's name — never invent, guess or assume a name, and do not greet them by a name.";

        var myJobs = Services.JobRepo.All().Where(j => j.ThreadId == _activeThreadId).ToList();
        var myDrafts = Services.DraftRepo.All().Where(d => d.ThreadId == _activeThreadId).ToList();
        var myCompanies = Services.CompanyRepo.All().Where(c => c.ThreadId == _activeThreadId).ToList();
        var state = $"Current state (this chat): {myJobs.Count} job postings collected, {myCompanies.Count} companies collected, {myDrafts.Count(d => d.Status == DraftStatus.Draft)} drafts pending, {myDrafts.Count(d => d.Status == DraftStatus.Approved)} approved.";

        var collected = "";
        if (myJobs.Count > 0)
        {
            var rows = myJobs.OrderByDescending(j => j.Included).ThenByDescending(j => j.RankScore).Take(25)
                .Select(j => $"- {j.Title}{(string.IsNullOrWhiteSpace(j.Company) ? "" : " @ " + j.Company)}{(string.IsNullOrWhiteSpace(j.Location) ? "" : " (" + j.Location + ")")}");
            collected = "\n\nJob postings already collected in this chat (real, in the app — to display them use [[ACTION:list]], don't re-search):\n" + string.Join("\n", rows);
        }
        if (myCompanies.Count > 0)
        {
            var rows = myCompanies.Take(25).Select(c => $"- {c.Name}{(string.IsNullOrWhiteSpace(c.Website) ? "" : " — " + c.Website)}");
            collected += "\n\nCompanies already collected in this chat (for unsolicited applications):\n" + string.Join("\n", rows);
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
        if (g == BrowserGoal.Companies) { foreach (var c in result.Companies) c.ThreadId = _activeThreadId; Services.CompanyRepo.UpsertAll(result.Companies); }
        else { foreach (var j in result.Jobs) j.ThreadId = _activeThreadId; Services.JobRepo.UpsertAll(result.Jobs); }
        run.Status = SearchRunStatus.Completed; run.CompletedAt = DateTimeOffset.UtcNow; run.ResultCount = result.Count;
        Services.SearchRunRepo.Upsert(run);
        return new { jobs = result.Jobs.Count, companies = result.Companies.Count, summary = result.Summary };
    }

    // ---------------------------------------------------------------- repos (read) ----

    public object Jobs() => Services.JobRepo.All()
        .Where(j => j.ThreadId == _activeThreadId)
        .OrderByDescending(j => j.Included).ThenByDescending(j => j.RankScore)
        .Select(j => new { id = j.Id, title = j.Title, company = j.Company, location = j.Location, url = j.SourceUrl, email = j.ContactEmail, included = j.Included }).ToList();

    public object Companies() => Services.CompanyRepo.All().Where(c => c.ThreadId == _activeThreadId)
        .Select(c => new { id = c.Id, name = c.Name, website = c.Website, location = c.Location, email = c.RecruitingEmail, contact = c.ContactStatus.ToString() }).ToList();

    public object DeleteCompanies(string[] ids, bool all)
    {
        var targets = all ? Services.CompanyRepo.All().Where(c => c.ThreadId == _activeThreadId).Select(c => c.Id).ToList() : ids.ToList();
        foreach (var id in targets) Services.CompanyRepo.Delete(id);
        return new { deleted = targets.Count };
    }

    public object Drafts() => Services.DraftRepo.All().Where(d => d.ThreadId == _activeThreadId).Select(d =>
    {
        var email = Services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == d.Id);
        return new { id = d.Id, company = d.Company, role = d.RoleTitle, status = d.Status.ToString(), to = email?.ToAddress ?? "", subject = email?.Subject ?? "", body = email?.Body ?? "", coverLetter = d.CoverLetterText ?? "" };
    }).ToList();

    /// <summary>Bulk delete. With ids: those rows. Without ids (all=true): every job in the active chat.</summary>
    public object DeleteJobs(string[] ids, bool all)
    {
        var targets = all ? Services.JobRepo.All().Where(j => j.ThreadId == _activeThreadId).Select(j => j.Id).ToList() : ids.ToList();
        foreach (var id in targets) Services.JobRepo.Delete(id);
        return new { deleted = targets.Count };
    }

    public object DeleteDrafts(string[] ids, bool all)
    {
        var targets = all ? Services.DraftRepo.All().Where(d => d.ThreadId == _activeThreadId).Select(d => d.Id).ToList() : ids.ToList();
        foreach (var id in targets)
        {
            var em = Services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == id);
            if (em is not null) Services.EmailRepo.Delete(em.Id);
            Services.DraftRepo.Delete(id);
        }
        return new { deleted = targets.Count };
    }

    // ---------------------------------------------------------------- repos (manage / write) ----

    /// <summary>Edit a collected posting in place, or toggle whether it's included in drafting.</summary>
    public object UpdateJob(string id, string? title, string? company, string? location, string? email, string? url, bool? included)
    {
        var j = Services.JobRepo.Get(id);
        if (j is null) return new { error = "job not found" };
        if (title is not null) j.Title = title;
        if (company is not null) j.Company = company;
        if (location is not null) j.Location = location;
        if (email is not null) j.ContactEmail = email;
        if (url is not null) j.SourceUrl = url;
        if (included.HasValue) j.Included = included.Value;
        Services.JobRepo.Upsert(j);
        return new { ok = true };
    }

    public object DeleteJob(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) return new { error = "id required" };
        Services.JobRepo.Delete(id);
        return new { ok = true };
    }

    /// <summary>Edit a draft's role/company/status and the associated email's recipient/subject/body.</summary>
    public object UpdateDraft(string id, string? role, string? company, string? to, string? subject, string? bodyText, string? status, string? coverLetter = null)
    {
        var d = Services.DraftRepo.Get(id);
        if (d is null) return new { error = "draft not found" };
        if (role is not null) d.RoleTitle = role;
        if (company is not null) d.Company = company;
        if (coverLetter is not null) { d.CoverLetterText = coverLetter; d.EditedByUser = true; }
        if (status is not null && Enum.TryParse<DraftStatus>(status, true, out var st)) d.Status = st;
        var emailEdited = to is not null || subject is not null || bodyText is not null;
        if (emailEdited) d.EditedByUser = true;
        Services.DraftRepo.Upsert(d);

        if (emailEdited)
        {
            var email = Services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == d.Id);
            if (email is not null)
            {
                if (to is not null) email.ToAddress = to;
                if (subject is not null) email.Subject = subject;
                if (bodyText is not null) email.Body = bodyText;
                Services.EmailRepo.Upsert(email);
            }
        }
        return new { ok = true };
    }

    public object DeleteDraft(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) return new { error = "id required" };
        var email = Services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == id);
        if (email is not null) Services.EmailRepo.Delete(email.Id);
        Services.DraftRepo.Delete(id);
        return new { ok = true };
    }

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
            var companies = ids.Length > 0
                ? ids.Select(i => Services.CompanyRepo.Get(i)).Where(c => c is not null).Select(c => c!).ToList()
                : Services.CompanyRepo.All().Where(c => c.ThreadId == _activeThreadId).ToList();
            foreach (var c in companies)
            {
                if (ct.IsCancellationRequested) break;
                var res = configured ? await SafeDraftAsync(() => gen.ForCompanyAsync(profile, c, cv), () => DraftGenerator.OfflineForCompany(profile, c, cv)).ConfigureAwait(false)
                                     : DraftGenerator.OfflineForCompany(profile, c, cv);
                Persist(new ApplicationDraft { Kind = ApplicationKind.Unsolicited, CompanyTargetId = c.Id, Company = c.Name, RoleTitle = "Speculative application", ThreadId = _activeThreadId }, res);
                made++;
            }
        }
        else
        {
            var jobs = ids.Length > 0
                ? ids.Select(i => Services.JobRepo.Get(i)).Where(j => j is not null).Select(j => j!).ToList()
                : Services.JobRepo.All().Where(j => j.ThreadId == _activeThreadId).ToList();
            foreach (var j in jobs)
            {
                if (ct.IsCancellationRequested) break;
                var res = configured ? await SafeDraftAsync(() => gen.ForJobAsync(profile, j, cv), () => DraftGenerator.OfflineForJob(profile, j, cv)).ConfigureAwait(false)
                                     : DraftGenerator.OfflineForJob(profile, j, cv);
                Persist(new ApplicationDraft { Kind = ApplicationKind.JobApplication, JobPostingId = j.Id, Company = j.Company, RoleTitle = j.Title, ThreadId = _activeThreadId }, res);
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
