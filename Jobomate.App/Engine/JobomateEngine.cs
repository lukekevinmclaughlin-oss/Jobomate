using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Browser;
using Jobomate.Contracts;
using Jobomate.Drafting;
using Jobomate.Filters;
using Jobomate.Llm;
using Jobomate.Persistence;
using Jobomate.Profile;
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
            // Companies and attachments are also thread-scoped — delete them too so a removed chat leaves
            // no orphaned rows behind (previously companies/attachments accumulated forever as DB cruft).
            foreach (var c in Services.CompanyRepo.All().Where(c => c.ThreadId == id).ToList()) Services.CompanyRepo.Delete(c.Id);
            foreach (var a in Services.AttachmentRepo.All().Where(a => a.ThreadId == id).ToList()) Services.AttachmentRepo.Delete(a.Id);
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
            mode = s.Preferences.Mode.ToString(),
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
            attachments = s.AttachmentRepo.All().Count(a => a.ThreadId == _activeThreadId),
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
        var recruiter = Mode == AppMode.Recruiter;

        var who = hasCv && !string.IsNullOrWhiteSpace(p.FullName)
            ? $"The user's name is {p.FullName}{(string.IsNullOrWhiteSpace(p.Headline) ? "" : " — " + p.Headline)}{(string.IsNullOrWhiteSpace(p.Location) ? "" : ", based in " + p.Location)} (from their loaded CV). "
              + "Do NOT open every message with \"Hi <name>\"; use their name only occasionally and when it reads naturally."
            : "No CV is loaded, so you do NOT know the user's name — never invent, guess or assume a name, and do not greet them by a name.";

        var myJobs = Services.JobRepo.All().Where(j => j.ThreadId == _activeThreadId).ToList();
        var myDrafts = Services.DraftRepo.All().Where(d => d.ThreadId == _activeThreadId).ToList();
        var myCompanies = Services.CompanyRepo.All().Where(c => c.ThreadId == _activeThreadId).ToList();

        // Domain vocabulary flips with the mode; the underlying pipeline is identical.
        var rowNoun = recruiter ? "candidates" : "job postings";
        var draftNoun = recruiter ? "outreach messages" : "drafts";
        var briefNoun = recruiter ? "role brief" : "CV";
        var state = $"Current state (this chat): {myJobs.Count} {rowNoun} collected, {myCompanies.Count} companies collected, {myDrafts.Count(d => d.Status == DraftStatus.Draft)} {draftNoun} pending, {myDrafts.Count(d => d.Status == DraftStatus.Approved)} approved.";

        var collected = "";
        if (myJobs.Count > 0)
        {
            var rows = myJobs.OrderByDescending(j => j.Included).ThenByDescending(j => j.RankScore).Take(25)
                .Select(j => $"- {j.Title}{(string.IsNullOrWhiteSpace(j.Company) ? "" : (recruiter ? " @ " : " @ ") + j.Company)}{(string.IsNullOrWhiteSpace(j.Location) ? "" : " (" + j.Location + ")")}");
            var label = recruiter
                ? "Candidates already sourced in this chat (real, in the app — title is their headline/role, company is their current employer; to display them use [[ACTION:list]], don't re-search):"
                : "Job postings already collected in this chat (real, in the app — to display them use [[ACTION:list]], don't re-search):";
            collected = "\n\n" + label + "\n" + string.Join("\n", rows);
        }
        if (myCompanies.Count > 0)
        {
            var rows = myCompanies.Take(25).Select(c => $"- {c.Name}{(string.IsNullOrWhiteSpace(c.Website) ? "" : " — " + c.Website)}");
            collected += (recruiter
                ? "\n\nTarget companies in this chat (places to source candidates from):\n"
                : "\n\nCompanies already collected in this chat (for unsolicited applications):\n") + string.Join("\n", rows);
        }

        string system;
        if (recruiter)
        {
            system =
                "You are the Jobomate assistant — a warm, capable RECRUITING copilot inside a sourcing-and-outreach browser. " +
                "You help an HR professional / recruiter find strong CANDIDATES for a role they are hiring for, then draft personalised outreach. " +
                "Answer the user fully and naturally on ANY topic. " + who + " " + state + " " +
                $"The loaded \"{briefNoun}\" describes the ROLE the recruiter is hiring for (its title, requirements, and the hiring company) — treat the profile facts as the role, not the user's own CV. " +
                "You also have specialised tools. When the user clearly wants one, append the matching directive on its OWN line at the very end of your reply — choose only from:\n" +
                "[[ACTION:research]] — drive the in-app browser to source CANDIDATES (people) matching the role from the user's sites\n" +
                "[[ACTION:companies]] — drive the browser to collect TARGET COMPANIES to source candidates from\n" +
                "[[ACTION:list]] — show the candidates already sourced\n" +
                "[[ACTION:draft]] — draft personalised outreach messages to the sourced candidates (you review before anything sends)\n" +
                "[[ACTION:prepare]] — put the outreach emails in the user's Gmail (open Gmail; they log in)\n" +
                "[[ACTION:approve]] — approve all pending outreach\n" +
                "[[ACTION:send]] — send due outreach (dry-run unless a real email account is connected)\n" +
                "[[ACTION:settings]] — open settings\n" +
                "Only add a directive when the user actually asks for that action; otherwise reply normally with no directive. " +
                "When drafting outreach, never invent a candidate's skills or experience, and never overstate the role or company. Be professional, specific, and respectful of the candidate's time and privacy. Keep replies concise.";
        }
        else
        {
            system =
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
        }

        var persona = Services.Preferences.LlmPersona;
        if (!string.IsNullOrWhiteSpace(persona))
            system += "\n\nThe user's guidelines/persona — follow them closely:\n" + persona.Trim();
        var sites = Services.Preferences.SearchSites;
        if (sites.Count > 0)
            system += "\n\nThe user scoped your research to these sites:\n" + string.Join("\n", sites);
        system += collected;

        // Files the user dropped into this chat — give their text to the model so it can read and apply
        // them (answer questions about them, use a brief/spec/spreadsheet when drafting, etc.). Bounded
        // so a large attachment can't crowd out the rest of the prompt.
        var myAttachments = Services.AttachmentRepo.All()
            .Where(a => a.ThreadId == _activeThreadId && a.Chars > 0)
            .OrderBy(a => a.DateAdded)
            .ToList();
        if (myAttachments.Count > 0)
        {
            const int totalCap = 120_000;
            var used = 0;
            system += "\n\nThe user attached the following file(s) to this chat. Treat them as authoritative " +
                      "context: read them, and use them when relevant to answer or draft. Do not claim a file " +
                      "is empty unless its content below truly is.";
            foreach (var a in myAttachments)
            {
                if (used >= totalCap) { system += $"\n\n[Attachment \"{a.Name}\" omitted — context limit reached]"; continue; }
                var slice = a.Text.Length > totalCap - used ? a.Text.Substring(0, totalCap - used) + "\n…[truncated]" : a.Text;
                used += slice.Length;
                system += $"\n\n===== Attached file: {a.Name} =====\n{slice}";
            }
        }

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
        var profile = await Services.Profiles.BuildFromCvAsync(path, llm, cfg, ct, Mode).ConfigureAwait(false);
        Services.SaveProfile(profile);
        return new { name = profile.FullName, headline = profile.Headline, location = profile.Location, skills = profile.Skills.Count, languages = profile.Languages.Select(l => l.Language + ":" + l.Level) };
    }

    // ---------------------------------------------------------------- chat attachments ----

    /// <summary>Per-file cap on stored text so one huge file can't blow the model's context window.</summary>
    private const int AttachmentCharCap = 60_000;

    /// <summary>
    /// Ingest a file the user dropped into the chat: extract its text and store it against the active
    /// thread so the connected model can read and apply it. Any file type is accepted; binary files
    /// (images, archives) yield no text and are reported as unreadable rather than failing.
    /// </summary>
    public object AttachFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            return new { error = "File not found." };

        var name = Path.GetFileName(path);
        var text = CvTextExtractor.ExtractAnyText(path);
        var truncated = text.Length > AttachmentCharCap;
        if (truncated) text = text.Substring(0, AttachmentCharCap);

        var att = new ChatAttachment
        {
            ThreadId = _activeThreadId,
            Name = name,
            SourcePath = path,
            Text = text,
            Chars = text.Length,
        };
        Services.AttachmentRepo.Upsert(att);
        return new { id = att.Id, name, chars = att.Chars, readable = att.Chars > 0, truncated };
    }

    public object Attachments() => Services.AttachmentRepo.All()
        .Where(a => a.ThreadId == _activeThreadId)
        .OrderBy(a => a.DateAdded)
        .Select(a => new { id = a.Id, name = a.Name, chars = a.Chars, readable = a.Chars > 0 })
        .ToList();

    public object DeleteAttachment(string id)
    {
        Services.AttachmentRepo.Delete(id);
        return new { deleted = 1 };
    }

    // ---------------------------------------------------------------- research (browser agent) ----

    public async Task<object> ResearchAsync(string goal, string? startUrl, Action<string> onProgress, CancellationToken ct = default)
    {
        if (!LlmConfigured()) return new { error = "Connect a model first — the browser is driven by your connected model." };
        var g = goal == "companies" ? BrowserGoal.Companies : BrowserGoal.JobPostings;
        var recruiter = Mode == AppMode.Recruiter;
        var sites = Services.Preferences.SearchSites;
        var url = !string.IsNullOrWhiteSpace(startUrl) ? startUrl!
            : sites.Count > 0 ? sites[0]
            : g == BrowserGoal.Companies ? "https://www.google.com/search?q=companies+hiring"
            : recruiter ? "https://www.linkedin.com/search/results/people/"
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
        .Select(j => new { id = j.Id, title = j.Title, company = j.Company, location = j.Location, url = j.SourceUrl, email = j.ContactEmail, included = j.Included, fitScore = j.FitScore, fitExplanation = j.FitExplanation }).ToList();

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
        return new { id = d.Id, kind = d.Kind == ApplicationKind.Unsolicited ? "speculative" : "job", company = d.Company, role = d.RoleTitle, status = d.Status.ToString(), to = email?.ToAddress ?? "", subject = email?.Subject ?? "", body = email?.Body ?? "", coverLetter = d.CoverLetterText ?? "" };
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

    /// <summary>The active app mode (job seeker vs recruiter).</summary>
    public AppMode Mode => Services.Preferences.Mode;

    /// <summary>Switch between job-seeker and recruiter mode (persisted). Unknown values are ignored.</summary>
    public object SetMode(string mode)
    {
        if (Enum.TryParse<AppMode>(mode, true, out var m))
        {
            var p = Services.Preferences;
            p.Mode = m;
            Services.SavePreferences(p);
        }
        return Status();
    }

    // ---------------------------------------------------------------- job fit scoring -------

    /// <summary>Build the fit-scoring prompt for a job against the current candidate profile.</summary>
    internal static string BuildFitPrompt(CandidateProfile profile, JobPosting job) =>
        "Score how well this job fits the candidate on a scale of 0-100.\n" +
        "Reply with ONLY: SCORE: <number>\nEXPLANATION: <one short sentence why>.\n\n" +
        $"CANDIDATE\nHeadline: {profile.Headline}\nSummary: {profile.Summary}\n" +
        $"Skills: {string.Join(", ", profile.Skills)}\n" +
        $"Languages: {string.Join(", ", profile.Languages.Select(l => l.Language + " (" + l.Level + ")"))}\n" +
        $"Experience: {profile.YearsExperience}y\n\n" +
        $"JOB\nTitle: {job.Title}\nCompany: {job.Company}\nLocation: {job.Location}\n" +
        $"Description: {Truncate(job.RawDescription, 4000)}";

    /// <summary>Parse the LLM's "SCORE: n / EXPLANATION: ..." reply into a clamped score + explanation.</summary>
    internal static (double FitScore, string Explanation) ParseFitResponse(string? resp)
    {
        var scoreMatch = Regex.Match(resp ?? "", @"SCORE:\s*(\d+)");
        var explanationMatch = Regex.Match(resp ?? "", @"EXPLANATION:\s*(.+)");
        var fitScore = scoreMatch.Success && double.TryParse(scoreMatch.Groups[1].Value, out var s) ? Math.Clamp(s, 0, 100) : 0d;
        var explanation = explanationMatch.Success ? explanationMatch.Groups[1].Value.Trim() : "";
        return (fitScore, explanation);
    }

    /// <summary>Score a single job; returns true on a successful LLM scoring, false on any failure.</summary>
    private async Task<bool> ScoreJobFitCore(JobPosting job)
    {
        try
        {
            var resp = await Services.Llm.CompleteAsync(
                Services.LlmConfig,
                new[]
                {
                    new ChatMessage("system", "You score job-candidate fit. Reply with SCORE and EXPLANATION only."),
                    new ChatMessage("user", BuildFitPrompt(Services.Profile, job)),
                },
                new LlmCallOptions(MaxOutputTokens: 200),
                CancellationToken.None).ConfigureAwait(false);

            var (fitScore, explanation) = ParseFitResponse(resp);
            job.FitScore = fitScore;
            job.FitExplanation = explanation;
            Services.JobRepo.Upsert(job);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Ask the configured LLM to score how well a job matches the candidate (0–100).</summary>
    public async Task<object> ScoreJobFit(string jobId)
    {
        var job = Services.JobRepo.Get(jobId);
        if (job is null) return new { error = "job not found" };
        if (!LlmConfigured()) return new { error = "Connect a model first" };

        return await ScoreJobFitCore(job).ConfigureAwait(false)
            ? new { fitScore = job.FitScore, explanation = job.FitExplanation }
            : new { error = "Scoring failed" };
    }

    /// <summary>Score every job in the active thread (sequentially; counts only successful scorings).</summary>
    public async Task<object> ScoreAllJobs()
    {
        if (!LlmConfigured()) return new { error = "Connect a model first" };
        var jobs = Services.JobRepo.All().Where(j => j.ThreadId == _activeThreadId).ToList();
        var scored = 0;
        foreach (var j in jobs)
            if (await ScoreJobFitCore(j).ConfigureAwait(false)) scored++;
        return new { scored, of = jobs.Count };
    }

    // ---------------------------------------------------------------- application tracker -------

    /// <summary>All application records for the active thread, with related job/draft info.</summary>
    public object Tracker()
    {
        var records = Services.RecordRepo.All()
            .Where(r => r.ThreadId == _activeThreadId)
            .OrderByDescending(r => r.LastUpdateAt)
            .Select(r => new
            {
                id = r.Id,
                company = r.Company,
                roleTitle = r.RoleTitle,
                status = r.Status.ToString(),
                createdAt = r.CreatedAt.ToString("o"),
                lastUpdateAt = r.LastUpdateAt.ToString("o"),
                appliedAt = r.AppliedAt?.ToString("o"),
                notes = r.Notes,
            })
            .ToList();
        return records;
    }

    /// <summary>Update a tracker record's status and optional notes. A null <paramref name="notes"/> leaves notes unchanged.</summary>
    public object UpdateTracker(string id, string status, string? notes)
    {
        var r = Services.RecordRepo.Get(id);
        if (r is null) return new { error = "record not found" };
        if (!string.IsNullOrWhiteSpace(status) && Enum.TryParse<TrackerStatus>(status, true, out var st))
            r.Status = st;
        if (notes is not null) r.Notes = notes;
        r.LastUpdateAt = DateTimeOffset.UtcNow;
        if (r.Status == TrackerStatus.Sent && r.AppliedAt is null)
            r.AppliedAt = DateTimeOffset.UtcNow;
        Services.RecordRepo.Upsert(r);
        return new { ok = true };
    }

    // ---------------------------------------------------------------- cost ledger -------

    /// <summary>Snapshot of every LLM call cost with per-call details and totals.</summary>
    public object Costs()
    {
        var totals = Services.CostLedger.Totals();
        return new
        {
            records = Services.CostLedger.Snapshot().Select(r => new
            {
                adapter = r.Adapter,
                model = r.Model,
                promptTokens = r.PromptTokens,
                completionTokens = r.CompletionTokens,
                usdCost = r.UsdCost,
                at = r.At.ToString("o"),
            }).ToList(),
            totals = new
            {
                promptTokens = totals.PromptTokens,
                completionTokens = totals.CompletionTokens,
                usdCost = totals.UsdCost,
            },
        };
    }

    // ---------------------------------------------------------------- cover letter PDF -------

    /// <summary>Generate a cover letter PDF for a given draft.</summary>
    public async Task<object> GenerateCoverLetterPdf(string draftId)
    {
        var draft = Services.DraftRepo.Get(draftId);
        if (draft is null) return new { error = "draft not found" };
        if (string.IsNullOrWhiteSpace(draft.CoverLetterText))
            return new { error = "This draft has no cover letter text yet — draft or edit it first." };

        var pdfPath = await Task.Run(() => CoverLetterPdf.Render(
            draft.CoverLetterText,
            Services.Profile,
            draft.Company,
            draft.RoleTitle,
            JobomatePaths.DocumentsDir)).ConfigureAwait(false);

        draft.CoverLetterPdfPath = pdfPath;
        Services.DraftRepo.Upsert(draft);

        return new { path = pdfPath };
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
