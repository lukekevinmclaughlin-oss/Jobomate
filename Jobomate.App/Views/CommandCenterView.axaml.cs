using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using Jobomate.Contracts;
using Jobomate.Drafting;
using Jobomate.Extension;
using Jobomate.Llm;
using Jobomate.Sources;

namespace Jobomate.Views;

/// <summary>
/// The chat-centric command center. The assistant drives the two-mode workflow
/// conversationally: it asks which mode, shows the generated job/company lists inline for
/// approval, drafts applications, and offers to connect the browser extension and send the
/// approved list gradually. The big conversation area is the hero of the UI.
/// </summary>
public partial class CommandCenterView : UserControl
{
    private static readonly IBrush TextBrush = Hex("#FAFAFA");
    private static readonly IBrush MutedBrush = Hex("#A1A1AA");
    private static readonly IBrush AccentBrush = Hex("#007AFF");
    private static readonly IBrush GreenBrush = Hex("#1FC95A");
    private static readonly IBrush WarnBrush = Hex("#F2BE1A");

    private JobomateServices _services = null!;
    private Action _onOpenDetails = () => { };

    private readonly List<(CheckBox Box, JobPosting Job)> _jobChecks = new();
    private readonly List<(CheckBox Box, CompanyTarget Company)> _companyChecks = new();
    private SearchMode _mode = SearchMode.RecentJobs;

    public CommandCenterView() => InitializeComponent();

    public void Bind(JobomateServices services, Action onOpenDetails)
    {
        _services = services;
        _onOpenDetails = onOpenDetails;

        SendButton.Click += (_, _) => SubmitInput();
        InputBox.KeyDown += (_, e) => { if (e.Key == Avalonia.Input.Key.Enter) { SubmitInput(); e.Handled = true; } };

        Greet();
    }

    // ----- conversation building blocks -----

    private void AddAssistant(string text)
    {
        var bubble = new Border { Classes = { "bubble" } };
        bubble.Child = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, Foreground = TextBrush };
        Conversation.Children.Add(bubble);
        ScrollEnd();
    }

    private void AddUser(string text)
    {
        var bubble = new Border { Classes = { "bubble-user" } };
        bubble.Child = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, Foreground = TextBrush };
        Conversation.Children.Add(bubble);
        ScrollEnd();
    }

    private void AddCard(Control content)
    {
        var card = new Border { Classes = { "card" }, HorizontalAlignment = HorizontalAlignment.Stretch };
        card.Child = content;
        Conversation.Children.Add(card);
        ScrollEnd();
    }

    private void SetActions(params (string Label, Action OnClick)[] actions)
    {
        QuickActions.Children.Clear();
        var first = true;
        foreach (var (label, onClick) in actions)
        {
            var btn = new Button { Content = label, Margin = new Thickness(0, 0, 8, 0) };
            btn.Classes.Add(first ? "accent" : "ghost");
            btn.Click += (_, _) => onClick();
            QuickActions.Children.Add(btn);
            first = false;
        }
    }

    private void ScrollEnd() =>
        Dispatcher.UIThread.Post(() => Scroller.Offset = new Vector(0, Scroller.Extent.Height), DispatcherPriority.Background);

    // ----- flow -----

    private void Greet()
    {
        AddAssistant(
            "Hi — I'm your Jobomate assistant. I work in the background, but you see and approve everything before " +
            "anything is sent. Available from 1 October 2026 is baked into every application.\n\n" +
            "Which would you like to do?");
        SetActions(
            ("①  Recent job postings", () => StartMode(SearchMode.RecentJobs)),
            ("②  Unsolicited applications", () => StartMode(SearchMode.Unsolicited)));
    }

    public void StartMode(SearchMode mode)
    {
        _mode = mode;
        AddUser(mode == SearchMode.RecentJobs ? "Find recent job postings for me." : "Build an unsolicited application list.");

        var p = _services.Preferences;
        var langs = string.Join(", ", p.AcceptedLanguages);
        var work = p.WorkLocations.Count == 0 ? "any" : string.Join(", ", p.WorkLocations);
        AddAssistant(
            $"{(mode == SearchMode.RecentJobs ? "Recent job postings" : "Unsolicited applications")} — here's the criteria I'll use:\n" +
            $"• Accepted languages: {langs}  (mode: {p.LanguageMode})\n" +
            $"• Location: {p.Location}\n" +
            $"• Work type: {work}\n" +
            (mode == SearchMode.RecentJobs ? "• Keywords: growth marketing biotech (editable in Details)\n" : "• Industries: " + string.Join(", ", _services.Profile.Industries) + "\n") +
            "\nRun it now, or adjust the filters first?");
        SetActions(
            ("Run it now", () => _ = RunSearch()),
            ("Adjust filters", () => _onOpenDetails()));
    }

    private async Task RunSearch()
    {
        SetActions();
        AddAssistant(_mode == SearchMode.RecentJobs
            ? "Searching reputable sources, then ranking and explaining each match…"
            : "Researching suitable employers and looking for official recruiting emails…");

        try
        {
            if (_mode == SearchMode.RecentJobs) await RunJobSearch();
            else await RunCompanyResearch();
        }
        catch (Exception ex)
        {
            AddAssistant("Sorry — the search hit a problem: " + ex.Message);
        }
    }

    private async Task RunJobSearch()
    {
        var prefs = _services.Preferences;
        var request = new JobSearchRequest
        {
            Keywords = "growth marketing biotech",
            Location = prefs.Location,
            AcceptedLanguages = prefs.AcceptedLanguages,
            Limit = 60,
            GreenhouseCompanies = prefs.GreenhouseCompanies,
            LeverCompanies = prefs.LeverCompanies,
        };
        JobSources.ApplyAdzunaKeys(request, _services.Credentials);

        var raw = await _services.JobSearch.SearchAsync(request);
        var processed = _services.Filters.Process(raw, prefs);
        var jobs = processed.ToList();
        _services.JobRepo.UpsertAll(jobs);

        var included = jobs.Where(j => j.Included).ToList();
        AddAssistant($"Found {jobs.Count} postings; {included.Count} pass your filters. Tick the ones you want and I'll draft tailored applications with cover letters.");

        _jobChecks.Clear();
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Header($"{included.Count} matches (of {jobs.Count})"));
        foreach (var job in jobs.OrderByDescending(j => j.Included).ThenByDescending(j => j.RankScore).Take(25))
        {
            var cb = new CheckBox { IsChecked = job.Included };
            cb.Content = JobRowContent(job);
            _jobChecks.Add((cb, job));
            panel.Children.Add(cb);
        }
        AddCard(panel);

        SetActions(
            ("Draft applications for selected", () => _ = GenerateJobDrafts()),
            ("Select all included", SelectAllIncludedJobs),
            ("Research more in my browser", ConnectExtension));
    }

    private async Task RunCompanyResearch()
    {
        var prefs = _services.Preferences;
        var sources = new List<ICompanyResearchSource> { new MockCompanyResearchSource() };
        if (LlmConfigured())
            sources.Add(new LlmCompanyResearchSource(_services.Llm, _services.LlmConfig, _services.Profile, new CompanyEmailFinder(_services.Http)));
        var research = new CompanyResearchService(sources);
        var companies = (await research.ResearchAsync(new CompanyResearchRequest
        {
            Industries = _services.Profile.Industries,
            Geographies = new List<string> { prefs.Location },
            AcceptedLanguages = prefs.AcceptedLanguages,
        })).ToList();
        _services.CompanyRepo.UpsertAll(companies);

        var withEmail = companies.Count(c => c.ContactStatus == ContactStatus.HasEmail);
        AddAssistant($"Found {companies.Count} companies; {withEmail} have an official recruiting email. " +
                     "Ones marked “needs manual contact” won't be scheduled. Tick the ones to approach.");

        _companyChecks.Clear();
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Header($"{companies.Count} companies"));
        foreach (var company in companies)
        {
            var cb = new CheckBox { IsChecked = company.ContactStatus == ContactStatus.HasEmail };
            cb.Content = CompanyRowContent(company);
            _companyChecks.Add((cb, company));
            panel.Children.Add(cb);
        }
        AddCard(panel);

        SetActions(
            ("Draft applications for selected", () => _ = GenerateCompanyDrafts()),
            ("Adjust filters", () => _onOpenDetails()));
    }

    private void SelectAllIncludedJobs()
    {
        foreach (var (box, job) in _jobChecks) box.IsChecked = job.Included;
    }

    private async Task GenerateJobDrafts()
    {
        var chosen = _jobChecks.Where(c => c.Box.IsChecked == true).Select(c => c.Job).ToList();
        if (chosen.Count == 0) { AddAssistant("Pick at least one posting first."); return; }
        AddUser($"Draft applications for {chosen.Count} role(s).");
        await GenerateDrafts(chosen.Count, async (profile, cv, gen) =>
        {
            foreach (var job in chosen)
            {
                var result = LlmConfigured()
                    ? await TryDraft(() => gen.ForJobAsync(profile, job, cv), () => DraftGenerator.OfflineForJob(profile, job, cv))
                    : DraftGenerator.OfflineForJob(profile, job, cv);
                Persist(new ApplicationDraft { Kind = ApplicationKind.JobApplication, JobPostingId = job.Id, Company = job.Company, RoleTitle = job.Title }, result);
            }
        });
    }

    private async Task GenerateCompanyDrafts()
    {
        var chosen = _companyChecks.Where(c => c.Box.IsChecked == true).Select(c => c.Company).ToList();
        if (chosen.Count == 0) { AddAssistant("Pick at least one company first."); return; }
        AddUser($"Draft applications for {chosen.Count} company(ies).");
        await GenerateDrafts(chosen.Count, async (profile, cv, gen) =>
        {
            foreach (var company in chosen)
            {
                var result = LlmConfigured()
                    ? await TryDraft(() => gen.ForCompanyAsync(profile, company, cv), () => DraftGenerator.OfflineForCompany(profile, company, cv))
                    : DraftGenerator.OfflineForCompany(profile, company, cv);
                Persist(new ApplicationDraft { Kind = ApplicationKind.Unsolicited, CompanyTargetId = company.Id, Company = company.Name, RoleTitle = "Speculative application" }, result);
            }
        });
    }

    private async Task GenerateDrafts(int count, Func<CandidateProfile, CandidateDocument?, DraftGenerator, Task> generate)
    {
        SetActions();
        AddAssistant($"Drafting {count} application(s){(LlmConfigured() ? " with your LLM" : "")}… every draft states your 1 October 2026 availability and uses only your CV facts.");

        var profile = _services.Profile;
        var cv = string.IsNullOrEmpty(profile.CvDocumentId) ? null : _services.Profiles.CvDocument(profile.CvDocumentId);
        var generator = _services.BuildDraftGenerator();
        try { await generate(profile, cv, generator); }
        catch (Exception ex) { AddAssistant("Draft generation problem: " + ex.Message); }

        AddAssistant("Here are the drafts. Approve the ones you're happy with — nothing sends until you approve, and it stays dry-run until you connect a real email account.");
        RenderDraftCards();
        SetActions(
            ("Approve all", ApproveAll),
            ("Schedule approved", ScheduleApproved),
            ("Send due now", () => _ = SendDue()),
            ("Connect browser extension", ConnectExtension));
    }

    private void Persist(ApplicationDraft draft, DraftResult result)
    {
        draft.CoverLetterText = result.CoverLetter;
        _services.DraftRepo.Upsert(draft);
        var email = result.Email;
        email.ApplicationDraftId = draft.Id;
        _services.EmailRepo.Upsert(email);
        _services.Audit.Record("draft", "generated", $"{draft.Company} — {draft.RoleTitle}");
    }

    private void RenderDraftCards()
    {
        foreach (var draft in _services.DraftRepo.All().Where(d => d.Status == DraftStatus.Draft))
        {
            var email = _services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == draft.Id);
            var panel = new StackPanel { Spacing = 6 };
            panel.Children.Add(new TextBlock { Text = $"{draft.Company} — {draft.RoleTitle}", FontWeight = FontWeight.SemiBold, Foreground = TextBrush });
            panel.Children.Add(new TextBlock { Text = "To: " + (email?.ToAddress ?? "(no recipient — needs manual contact)"), Foreground = MutedBrush, FontSize = 12 });
            panel.Children.Add(new TextBlock { Text = "Subject: " + (email?.Subject ?? ""), Foreground = TextBrush, FontSize = 12.5, TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(new TextBlock { Text = Preview(email?.Body ?? "", 260), Foreground = MutedBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap });

            var status = new TextBlock { Text = "Status: Draft", Foreground = WarnBrush, FontSize = 12 };
            var row = new WrapPanel();
            row.Children.Add(MakeBtn("Approve", "accent", () => { _services.Approval.Approve(draft.Id); status.Text = "Status: Approved ✓"; status.Foreground = GreenBrush; }));
            row.Children.Add(MakeBtn("Reject", "ghost", () => { _services.Approval.Reject(draft.Id); status.Text = "Status: Rejected"; status.Foreground = MutedBrush; }));
            row.Children.Add(MakeBtn("Edit in Details", "ghost", () => _onOpenDetails()));
            panel.Children.Add(row);
            panel.Children.Add(status);

            AddCard(panel);
        }
    }

    private void ApproveAll()
    {
        var ids = _services.DraftRepo.All().Where(d => d.Status == DraftStatus.Draft).Select(d => d.Id).ToList();
        var n = _services.Approval.ApproveBatch(ids);
        AddUser("Approve all.");
        AddAssistant($"Approved {n} draft(s). I can schedule them to send gradually (≤8/day, spaced out, quiet hours respected), or connect your browser to research more.");
    }

    private void ScheduleApproved()
    {
        var queue = _services.BuildQueueService();
        var approved = _services.DraftRepo.All().Where(d => d.Status == DraftStatus.Approved).ToList();
        var scheduled = approved.Count(d => queue.Enqueue(d.Id) is not null);
        AddUser("Schedule the approved applications.");
        AddAssistant($"Scheduled {scheduled} of {approved.Count}. They'll go out gradually through your own email — and it's dry-run until you connect a real account. " +
                     "Watch progress under Details → Queue & Tracker, or click “Send due now”.");
    }

    private async Task SendDue()
    {
        var runner = _services.BuildSendRunner();
        var sent = await runner.RunDueAsync();
        var dry = _services.BuildEmailSender().IsDryRun;
        AddAssistant($"{(dry ? "Dry-run: recorded" : "Sent")} {sent} due item(s). Queue: {runner.State}. {runner.LastMessage}");
    }

    private void ConnectExtension()
    {
        AddUser("Connect my browser.");
        if (_services.Extension.IsConnected)
        {
            AddAssistant("Your browser extension is already connected. Use Details → Browser to research specific URLs, or click the Jobomate extension on any job page and “Send this job to Jobomate”.");
            return;
        }
        var (ok, message, path) = ExtensionInstaller.Install();
        AddAssistant((ok ? "Installing the Jobomate Chrome extension. " : "Couldn't write the extension: ") + message +
                     (ok ? $"\n\nFolder to load: {path}\n\nOnce loaded it connects automatically. On any login or CAPTCHA it pauses and asks you to take over, then resumes." : ""));
    }

    // ----- input -----

    private void SubmitInput()
    {
        var text = (InputBox.Text ?? "").Trim();
        if (text.Length == 0) return;
        InputBox.Text = "";
        AddUser(text);
        Interpret(text.ToLowerInvariant());
    }

    private void Interpret(string t)
    {
        if (t.Contains("unsolicited") || t.Contains("speculative") || t == "2") { StartMode(SearchMode.Unsolicited); return; }
        if (t.Contains("recent") || t.Contains("posting") || t.Contains("job") || t == "1") { StartMode(SearchMode.RecentJobs); return; }
        if (t.Contains("run") || t.Contains("search") || t.Contains("go")) { _ = RunSearch(); return; }
        if (t.Contains("approve")) { ApproveAll(); return; }
        if (t.Contains("schedule")) { ScheduleApproved(); return; }
        if (t.Contains("send")) { _ = SendDue(); return; }
        if (t.Contains("browser") || t.Contains("extension") || t.Contains("chrome")) { ConnectExtension(); return; }
        AddAssistant("Tell me “recent” or “unsolicited” to start, or use the buttons above. You can also say “run”, “approve”, “schedule”, or “send”.");
    }

    // ----- helpers -----

    private Control JobRowContent(JobPosting job)
    {
        var sp = new StackPanel { Spacing = 1, Margin = new Thickness(4, 0, 0, 0) };
        sp.Children.Add(new TextBlock { Text = job.Title, FontWeight = FontWeight.SemiBold, Foreground = TextBrush, TextWrapping = TextWrapping.Wrap });
        sp.Children.Add(new TextBlock { Text = $"{job.Company} · {job.Location} · {job.WorkLocation}", Foreground = MutedBrush, FontSize = 12 });
        sp.Children.Add(new TextBlock
        {
            Text = $"{(job.Included ? "✓ included" : "✕ excluded")} · language: {job.LanguageDecision} · start: {job.StartDateRisk}",
            Foreground = job.Included ? GreenBrush : MutedBrush,
            FontSize = 11.5,
        });
        sp.Children.Add(new TextBlock { Text = job.LanguageDecisionReason, Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap });
        return sp;
    }

    private Control CompanyRowContent(CompanyTarget company)
    {
        var sp = new StackPanel { Spacing = 1, Margin = new Thickness(4, 0, 0, 0) };
        sp.Children.Add(new TextBlock { Text = company.Name, FontWeight = FontWeight.SemiBold, Foreground = TextBrush });
        sp.Children.Add(new TextBlock { Text = $"{company.Industry} · {company.Location}", Foreground = MutedBrush, FontSize = 12 });
        var has = company.ContactStatus == ContactStatus.HasEmail;
        sp.Children.Add(new TextBlock
        {
            Text = has ? $"✓ {company.RecruitingEmail}" : "needs manual contact — not scheduled",
            Foreground = has ? GreenBrush : WarnBrush,
            FontSize = 11.5,
            TextWrapping = TextWrapping.Wrap,
        });
        return sp;
    }

    private Button MakeBtn(string label, string cls, Action onClick)
    {
        var b = new Button { Content = label, Margin = new Thickness(0, 6, 8, 0) };
        b.Classes.Add(cls);
        b.Click += (_, _) => onClick();
        return b;
    }

    private TextBlock Header(string text) => new() { Text = text, FontWeight = FontWeight.SemiBold, Foreground = TextBrush, Margin = new Thickness(0, 0, 0, 4) };

    private static string Preview(string s, int max) => string.IsNullOrEmpty(s) ? "" : (s.Length <= max ? s : s[..max] + "…");

    private bool LlmConfigured()
    {
        var c = _services.LlmConfig;
        return c.ConnectionType switch
        {
            AppConnectionType.ApiKey => !string.IsNullOrEmpty(_services.Credentials.GetApiKey(LlmClient.ApiKeyName(c.ApiProvider))),
            AppConnectionType.LocalServer => !string.IsNullOrWhiteSpace(c.LocalServerUrl),
            AppConnectionType.LocalAI => !string.IsNullOrWhiteSpace(c.LocalAIModelPath),
            _ => false,
        };
    }

    private static async Task<DraftResult> TryDraft(Func<Task<DraftResult>> llm, Func<DraftResult> offline)
    {
        try { return await llm(); } catch { return offline(); }
    }

    private static IBrush Hex(string hex) => new SolidColorBrush(Color.Parse(hex));
}
