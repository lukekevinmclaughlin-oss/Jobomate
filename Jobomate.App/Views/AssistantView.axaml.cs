using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using Jobomate.Browser;
using Jobomate.Contracts;
using Jobomate.Drafting;
using Jobomate.Llm;
using Jobomate.Sources;

namespace Jobomate.Views;

/// <summary>
/// The center workspace — a MAOS-style chat that drives the two-mode job workflow. Bento home
/// when empty; multicolour user/assistant bubbles + interactive result/draft cards once running;
/// a status strip (connection / activity / tokens); and the #303030 composer with the icon
/// toolbar. Reuses every existing service (search, filters, drafting, approval, scheduler).
/// </summary>
public partial class AssistantView : UserControl
{
    // MAOS syntax palettes: warm for the user, cool for the assistant.
    private static readonly string[] WarmPalette = { "#50FA7B", "#F1FA8C", "#FFB86C", "#8BE9A0" };
    private static readonly string[] CoolPalette = { "#8BE9FD", "#82AAFF", "#BD93F9", "#FF79C6" };

    private static readonly IBrush TextBrush = Hex("#FAFAFA");
    private static readonly IBrush MutedBrush = Hex("#A1A1AA");
    private static readonly IBrush GreenBrush = Hex("#1FC95A");
    private static readonly IBrush WarnBrush = Hex("#F2BE1A");
    private static readonly IBrush Accent = Hex("#007AFF");
    private static readonly IBrush Dim = Hex("#3A3A3A");

    private readonly Random _rng = new();
    private JobomateServices _services = null!;
    private Action<string> _openSidecar = _ => { };

    private readonly List<(CheckBox Box, JobPosting Job)> _jobChecks = new();
    private readonly List<(CheckBox Box, CompanyTarget Company)> _companyChecks = new();
    private readonly List<ChatMessage> _history = new();
    private readonly List<(string Role, string Text)> _transcript = new();
    private string _threadId = "";
    private bool _loading;
    private SearchMode _mode = SearchMode.RecentJobs;
    private DispatcherTimer? _timer;
    private bool _busy;
    private bool _browsing;

    /// <summary>Raised when threads/runs change so the sidebar can refresh.</summary>
    public event Action? ThreadsChanged;

    public AssistantView() => InitializeComponent();

    public void Bind(JobomateServices services, Action<string> openSidecar)
    {
        _services = services;
        _openSidecar = openSidecar;

        SendButton.Click += (_, _) => SubmitInput();
        // Tunnel so we intercept Enter BEFORE the multiline TextBox inserts a newline.
        InputBox.AddHandler(InputElement.KeyDownEvent, OnComposerKey, RoutingStrategies.Tunnel);
        AttachButton.Click += async (_, _) => await LoadCv();
        ModelButton.Click += (_, _) => _openSidecar("settings");
        SettingsButton.Click += (_, _) => _openSidecar("settings");
        ConnectButton.Click += (_, _) => ToggleConnect();

        // Drag & drop any file onto the composer: .gguf connects a local model, CVs load the
        // profile, anything else is noted.
        DragDrop.SetAllowDrop(InputBox, true);
        InputBox.AddHandler(DragDrop.DragOverEvent, OnDragOver);
        InputBox.AddHandler(DragDrop.DropEvent, OnDrop);

        _services.StatusChanged += s => Dispatcher.UIThread.Post(() => { RunText.Text = string.IsNullOrEmpty(s) ? "Idle" : s; });
        _services.Llm.ActivityChanged += (detail, active) => Dispatcher.UIThread.Post(() =>
        {
            RunDot.Background = active ? Accent : Dim;
            if (!string.IsNullOrEmpty(detail)) RunText.Text = detail;
        });

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _timer.Tick += (_, _) => RefreshStatus();
        AttachedToVisualTree += (_, _) => { _timer.Start(); RefreshStatus(); };
        DetachedFromVisualTree += (_, _) => _timer.Stop();
    }

    /// <summary>Start a fresh chat thread (bento home).</summary>
    public void NewRun()
    {
        Conversation.Children.Clear();
        _jobChecks.Clear();
        _companyChecks.Clear();
        _transcript.Clear();
        _history.Clear();
        QuickActions.Children.Clear();
        EmptyState.IsVisible = true;
        var t = new ChatThread();
        _services.ThreadRepo.Upsert(t);
        _threadId = t.Id;
        ThreadsChanged?.Invoke();
    }

    /// <summary>Load an existing thread's conversation back into the view.</summary>
    public void LoadThread(ChatThread thread)
    {
        _threadId = thread.Id;
        Conversation.Children.Clear();
        _jobChecks.Clear();
        _companyChecks.Clear();
        _transcript.Clear();
        _history.Clear();
        QuickActions.Children.Clear();
        EmptyState.IsVisible = true;

        if (!string.IsNullOrWhiteSpace(thread.MessagesJson))
        {
            _loading = true;
            try
            {
                using var doc = JsonDocument.Parse(thread.MessagesJson);
                foreach (var el in doc.RootElement.EnumerateArray())
                {
                    var role = el.TryGetProperty("role", out var r) ? r.GetString() ?? "assistant" : "assistant";
                    var text = el.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "";
                    _transcript.Add((role, text));
                    _history.Add(new ChatMessage(role, text));
                    if (role == "user") AddUser(text); else AddAssistant(text);
                }
            }
            catch { /* skip malformed */ }
            _loading = false;
        }
    }

    private void EnsureThread()
    {
        if (!string.IsNullOrEmpty(_threadId)) return;
        var t = new ChatThread();
        _services.ThreadRepo.Upsert(t);
        _threadId = t.Id;
        ThreadsChanged?.Invoke();
    }

    private void Record(string role, string text)
    {
        if (_loading) return;
        _transcript.Add((role, text));
        PersistThread();
    }

    private void PersistThread()
    {
        if (string.IsNullOrEmpty(_threadId)) return;
        var t = _services.ThreadRepo.Get(_threadId);
        if (t is null) return;
        t.MessagesJson = JsonSerializer.Serialize(_transcript.Select(m => new { role = m.Role, text = m.Text }));
        var firstUser = _transcript.FirstOrDefault(m => m.Role == "user").Text;
        if (!string.IsNullOrWhiteSpace(firstUser)) t.Title = firstUser.Length <= 42 ? firstUser : firstUser[..42] + "…";
        t.LastActiveAt = DateTimeOffset.UtcNow;
        _services.ThreadRepo.Upsert(t);
        ThreadsChanged?.Invoke();
    }

    private void LogRun(int resultCount)
    {
        _services.SearchRunRepo.Upsert(new SearchRun
        {
            ThreadId = _threadId,
            Mode = _mode,
            ResultCount = resultCount,
            Status = SearchRunStatus.Completed,
            CompletedAt = DateTimeOffset.UtcNow,
        });
        ThreadsChanged?.Invoke();
    }

    // ----- status strip -----

    private void ToggleConnect()
    {
        var c = _services.LlmConfig;
        if (c.Connected)
        {
            c.Connected = false;
            _services.SaveLlmConfig(c);
            AddAssistant("Disconnected the model — chat falls back to local guidance until you reconnect.");
        }
        else
        {
            if (!HasCredentials(c)) { _openSidecar("settings"); return; }
            c.Connected = true;
            _services.SaveLlmConfig(c);
            AddAssistant($"Connected **{c.ResolvedModel() ?? "the model"}**. You can chat with it now — and it can run Jobomate's tools for you.");
        }
        RefreshStatus();
    }

    private bool HasCredentials(LlmConnectionConfig c) => c.ConnectionType switch
    {
        AppConnectionType.ApiKey => !string.IsNullOrEmpty(_services.Credentials.GetApiKey(LlmClient.ApiKeyName(c.ApiProvider))),
        AppConnectionType.LocalServer => !string.IsNullOrWhiteSpace(c.LocalServerUrl),
        AppConnectionType.LocalAI => !string.IsNullOrWhiteSpace(c.LocalAIModelPath),
        AppConnectionType.CliPipe => !string.IsNullOrWhiteSpace(c.CliCommand),
        AppConnectionType.Terminal => !string.IsNullOrWhiteSpace(c.TerminalCommand),
        _ => true,
    };

    private void RefreshStatus()
    {
        try
        {
            var connected = LlmConfigured();
            ConnText.Text = connected ? _services.LlmConfig.ResolvedModel() ?? "Connected" : "No model";
            ConnDot.Background = connected ? GreenBrush : Hex("#9CA3AF");
            ConnectButton.Content = _services.LlmConfig.Connected ? "Disconnect" : "Connect";

            var (pt, cmp, cost) = _services.CostLedger.Totals();
            var tokens = (pt ?? 0) + (cmp ?? 0);
            TokensText.Text = tokens > 0 ? $"{tokens:N0} tok{(cost is { } c ? $" · ${c:0.000}" : "")}" : "0 tok";

            var live = _services.EmailConfig.Tested && _services.EmailConfig.Provider != EmailProviderKind.DryRun;
            StatusDryRun.Text = live
                ? $"Live · {_services.EmailConfig.Provider} · approval required before every send"
                : "Dry-run · nothing sends without approval";
        }
        catch { /* best effort */ }
    }

    // ----- conversation building blocks (MAOS rendering) -----

    private void ShowConversation()
    {
        if (EmptyState.IsVisible) EmptyState.IsVisible = false;
    }

    private void AddUser(string text) { AddBubble(text, WarmPalette, HorizontalAlignment.Right, "#13233A", new Thickness(64, 0, 0, 0)); Record("user", text); }
    private void AddAssistant(string text) { AddBubble(text, CoolPalette, HorizontalAlignment.Left, "#0E0E12", new Thickness(0, 0, 64, 0)); Record("assistant", text); }

    private void AddBubble(string text, string[] palette, HorizontalAlignment align, string bg, Thickness margin)
    {
        EnsureThread();
        ShowConversation();
        var bubble = new Border
        {
            Background = Hex(bg),
            BorderBrush = Hex("#1A1A1A"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(13, 10),
            Margin = margin,
            MaxWidth = 560,
            HorizontalAlignment = align,
            Child = ColoredText(text, palette),
        };
        Conversation.Children.Add(bubble);
        ScrollEnd();
    }

    private Control ColoredText(string text, string[] palette)
    {
        var tb = new SelectableTextBlock { TextWrapping = TextWrapping.Wrap, FontSize = 14, FontWeight = FontWeight.SemiBold, LineHeight = 20 };
        var lines = text.Split('\n');
        for (var li = 0; li < lines.Length; li++)
        {
            foreach (var word in lines[li].Split(' '))
                tb.Inlines!.Add(new Run(word + " ") { Foreground = Hex(palette[_rng.Next(palette.Length)]) });
            if (li < lines.Length - 1) tb.Inlines!.Add(new LineBreak());
        }
        return tb;
    }

    private void AddCard(Control content)
    {
        ShowConversation();
        var card = new Border
        {
            Background = Hex("#141418"),
            BorderBrush = Hex("#222228"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(14),
            Margin = new Thickness(0, 0, 64, 0),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Child = content,
        };
        Conversation.Children.Add(card);
        ScrollEnd();
    }

    private void SetActions(params (string Label, Action OnClick)[] actions)
    {
        QuickActions.Children.Clear();
        foreach (var (label, onClick) in actions)
        {
            var btn = new Button { Content = label, Margin = new Thickness(0, 0, 8, 6) };
            btn.Classes.Add("tahoe-pill");
            btn.Click += (_, _) => onClick();
            QuickActions.Children.Add(btn);
        }
    }

    private void ScrollEnd() => Dispatcher.UIThread.Post(() =>
    {
        Conversation.InvalidateMeasure();
        Scroller.UpdateLayout();
        Scroller.Offset = new Vector(0, Math.Max(0, Scroller.Extent.Height - Scroller.Viewport.Height));
    }, DispatcherPriority.Loaded);

    // ----- bento home -----

    private void BentoRecent_Click(object? s, Avalonia.Interactivity.RoutedEventArgs e) => StartMode(SearchMode.RecentJobs);
    private void BentoUnsolicited_Click(object? s, Avalonia.Interactivity.RoutedEventArgs e) => StartMode(SearchMode.Unsolicited);
    private void BentoBrowser_Click(object? s, Avalonia.Interactivity.RoutedEventArgs e) => _openSidecar("browser");

    // ----- flow -----

    public void StartMode(SearchMode mode)
    {
        _mode = mode;
        AddUser(mode == SearchMode.RecentJobs ? "Find recent job postings for me." : "Build an unsolicited application list.");

        var p = _services.Preferences;
        var langs = p.AcceptedLanguages.Count == 0 ? "any" : string.Join(", ", p.AcceptedLanguages);
        var work = p.WorkLocations.Count == 0 ? "any" : string.Join(", ", p.WorkLocations);
        var kw = KeywordsFor();
        var profileLine = mode == SearchMode.RecentJobs
            ? $"• Keywords: {(string.IsNullOrWhiteSpace(kw) ? "from your CV / profile — load one in Settings" : kw)}\n"
            : $"• Industries: {(_services.Profile.Industries.Count == 0 ? "from your CV / profile" : string.Join(", ", _services.Profile.Industries))}\n";
        AddAssistant(
            $"{(mode == SearchMode.RecentJobs ? "Recent job postings" : "Unsolicited applications")} — here's the criteria I'll use:\n" +
            $"• Accepted languages: {langs}  (mode: {p.LanguageMode})\n" +
            $"• Location: {(string.IsNullOrWhiteSpace(p.Location) ? "anywhere" : p.Location)}\n" +
            $"• Work type: {work}\n" +
            profileLine +
            "\nRun it now, or adjust the filters first?");
        SetActions(
            ("Run it now", () => _ = RunSearch()),
            ("Adjust filters", () => _openSidecar("settings")));
    }

    private string KeywordsFor()
    {
        var p = _services.Profile;
        if (!string.IsNullOrWhiteSpace(p.Headline)) return p.Headline;
        if (p.Skills.Count > 0) return string.Join(" ", p.Skills.Take(3));
        return "";
    }

    private async Task RunSearch()
    {
        SetActions();
        _services.SetStatus(_mode == SearchMode.RecentJobs ? "Searching jobs…" : "Researching companies…");
        AddAssistant(_mode == SearchMode.RecentJobs
            ? "Searching reputable sources, then ranking and explaining each match…"
            : "Researching suitable employers and looking for official recruiting emails…");
        try
        {
            if (_mode == SearchMode.RecentJobs) await RunJobSearch();
            else await RunCompanyResearch();
        }
        catch (Exception ex) { AddAssistant("Sorry — the search hit a problem: " + ex.Message); }
        _services.SetStatus("");
    }

    private async Task RunJobSearch()
    {
        var prefs = _services.Preferences;
        var request = new JobSearchRequest
        {
            Keywords = KeywordsFor(),
            Location = prefs.Location,
            AcceptedLanguages = prefs.AcceptedLanguages,
            Limit = 60,
            GreenhouseCompanies = prefs.GreenhouseCompanies,
            LeverCompanies = prefs.LeverCompanies,
        };
        JobSources.ApplyAdzunaKeys(request, _services.Credentials);

        var raw = await _services.JobSearch.SearchAsync(request);
        var jobs = _services.Filters.Process(raw, prefs).ToList();
        _services.JobRepo.UpsertAll(jobs);
        LogRun(jobs.Count);

        var included = jobs.Where(j => j.Included).ToList();
        AddAssistant($"Found {jobs.Count} postings; {included.Count} pass your filters. Tick the ones you want and I'll draft tailored applications with cover letters.");
        PresentJobs(jobs);
    }

    /// <summary>Render a checklist of job postings in chat with a draft action. Shared by the normal
    /// search, the LLM Browser collection, and the [[ACTION:list]] directive.</summary>
    private void PresentJobs(IReadOnlyList<JobPosting> jobs)
    {
        _jobChecks.Clear();
        var included = jobs.Count(j => j.Included);
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Header(included > 0 ? $"{included} matches (of {jobs.Count})" : $"{jobs.Count} postings"));
        foreach (var job in jobs.OrderByDescending(j => j.Included).ThenByDescending(j => j.RankScore).Take(40))
        {
            var cb = new CheckBox { IsChecked = job.Included, Content = JobRowContent(job) };
            _jobChecks.Add((cb, job));
            panel.Children.Add(cb);
        }
        AddCard(panel);

        SetActions(
            ("Draft applications for selected", () => _ = GenerateJobDrafts()),
            ("Select all", () => { foreach (var (box, _) in _jobChecks) box.IsChecked = true; }),
            ("Research in browser", () => _openSidecar("browser")));
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
        LogRun(companies.Count);

        var withEmail = companies.Count(c => c.ContactStatus == ContactStatus.HasEmail);
        AddAssistant($"Found {companies.Count} companies; {withEmail} have an official recruiting email. " +
                     "Ones marked “needs manual contact” won't be scheduled. Tick the ones to approach.");
        PresentCompanies(companies);
    }

    /// <summary>Render a checklist of companies in chat with a draft action. Shared by company
    /// research, the LLM Browser collection, and the [[ACTION:list]] directive.</summary>
    private void PresentCompanies(IReadOnlyList<CompanyTarget> companies)
    {
        _companyChecks.Clear();
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Header($"{companies.Count} companies"));
        foreach (var company in companies.Take(40))
        {
            var cb = new CheckBox { IsChecked = company.ContactStatus == ContactStatus.HasEmail, Content = CompanyRowContent(company) };
            _companyChecks.Add((cb, company));
            panel.Children.Add(cb);
        }
        AddCard(panel);

        SetActions(
            ("Draft applications for selected", () => _ = GenerateCompanyDrafts()),
            ("Select all", () => { foreach (var (box, _) in _companyChecks) box.IsChecked = true; }),
            ("Adjust filters", () => _openSidecar("settings")));
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
        _services.SetStatus($"Drafting {count} application(s)…");
        AddAssistant($"Drafting {count} application(s){(LlmConfigured() ? " with your model" : "")}… every draft uses only your CV facts.");

        var profile = _services.Profile;
        var cv = string.IsNullOrEmpty(profile.CvDocumentId) ? null : _services.Profiles.CvDocument(profile.CvDocumentId);
        var generator = _services.BuildDraftGenerator();
        try { await generate(profile, cv, generator); }
        catch (Exception ex) { AddAssistant("Draft generation problem: " + ex.Message); }

        _services.SetStatus("");
        AddAssistant("Here are the drafts. Approve the ones you're happy with in the Approval wall — nothing sends until you approve, and it stays dry-run until you connect a real email account.");
        RenderDraftCards();
        SetActions(
            ("Open approval wall", () => _openSidecar("approval")),
            ("Approve all", ApproveAll),
            ("Schedule approved", ScheduleApproved),
            ("Send due now", () => _ = SendDue()));
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
            panel.Children.Add(new TextBlock { Text = $"{draft.Company} — {draft.RoleTitle}", FontWeight = FontWeight.SemiBold, Foreground = TextBrush, TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(new TextBlock { Text = "To: " + (email?.ToAddress ?? "(no recipient — needs manual contact)"), Foreground = MutedBrush, FontSize = 12 });
            panel.Children.Add(new TextBlock { Text = "Subject: " + (email?.Subject ?? ""), Foreground = TextBrush, FontSize = 12.5, TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(new TextBlock { Text = Preview(email?.Body ?? "", 260), Foreground = MutedBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap });

            var status = new TextBlock { Text = "Status: Draft", Foreground = WarnBrush, FontSize = 12 };
            var row = new WrapPanel();
            row.Children.Add(MakeBtn("Approve", "accent", () => { _services.Approval.Approve(draft.Id); status.Text = "Status: Approved ✓"; status.Foreground = GreenBrush; }));
            row.Children.Add(MakeBtn("Reject", "ghost", () => { _services.Approval.Reject(draft.Id); status.Text = "Status: Rejected"; status.Foreground = MutedBrush; }));
            row.Children.Add(MakeBtn("Open in wall", "ghost", () => _openSidecar("approval")));
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
        AddAssistant($"Approved {n} draft(s). I can schedule them to send gradually (≤{_services.RateLimit.MaxPerDay}/day, spaced out, quiet hours respected) — open the Queue, or click “Schedule approved”.");
    }

    private void ScheduleApproved()
    {
        var queue = _services.BuildQueueService();
        var approved = _services.DraftRepo.All().Where(d => d.Status == DraftStatus.Approved).ToList();
        var scheduled = approved.Count(d => queue.Enqueue(d.Id) is not null);
        AddUser("Schedule the approved applications.");
        AddAssistant($"Scheduled {scheduled} of {approved.Count}. They go out gradually through your own email — dry-run until you connect a real account. Watch them in the Queue sidecar, or click “Send due now”.");
        _openSidecar("queue");
    }

    private async Task SendDue()
    {
        _services.SetStatus("Sending due items…");
        var runner = _services.BuildSendRunner();
        var sent = await runner.RunDueAsync();
        var dry = _services.BuildEmailSender().IsDryRun;
        AddAssistant($"{(dry ? "Dry-run: recorded" : "Sent")} {sent} due item(s). Queue: {runner.State}. {runner.LastMessage}");
        _services.SetStatus("");
    }

    private void OpenBrowserPanel()
    {
        AddUser("Open the LLM Browser.");
        _openSidecar("browser");
    }

    // ----- input -----

    private void SubmitInput()
    {
        var text = (InputBox.Text ?? "").Trim();
        if (text.Length == 0 || _busy) return;
        InputBox.Text = "";
        AddUser(text);
        if (LlmConfigured()) _ = AskLlm(text);
        else Interpret(text.ToLowerInvariant());   // no model connected → local keyword guidance
    }

    /// <summary>
    /// Send the user's message to the connected model and show its full, natural reply — exactly
    /// like MAOS. The model is not limited to job topics; it simply also has Jobomate's tools
    /// available, which it can trigger by appending an [[ACTION:…]] directive to its reply.
    /// </summary>
    private async Task AskLlm(string userText)
    {
        _busy = true;
        _services.SetStatus("Thinking…");
        try
        {
            var messages = BuildLlmMessages(userText);
            var resp = await _services.Llm.CompleteAsync(_services.LlmConfig, messages, new LlmCallOptions(MaxOutputTokens: 1000));
            var (text, actions) = ParseDirectives(resp ?? "");

            _history.Add(new ChatMessage("user", userText));
            _history.Add(new ChatMessage("assistant", string.IsNullOrWhiteSpace(text) ? (resp ?? "") : text));
            if (_history.Count > 24) _history.RemoveRange(0, _history.Count - 24);

            if (!string.IsNullOrWhiteSpace(text)) AddAssistant(text);
            foreach (var action in actions) await RunAction(action);
        }
        catch (Exception ex)
        {
            AddAssistant("I couldn't reach the model: " + ex.Message + "\n\nCheck Settings → LLM connection (or use the buttons above to run Jobomate's tools directly).");
        }
        finally
        {
            _busy = false;
            _services.SetStatus("");
        }
    }

    private List<ChatMessage> BuildLlmMessages(string userText)
    {
        var p = _services.Profile;
        var who = string.IsNullOrWhiteSpace(p.FullName) && string.IsNullOrWhiteSpace(p.Headline)
            ? "The user has not loaded a CV yet — if they want to apply for jobs, suggest loading one (the attach button, or Settings → Candidate profile)."
            : $"The user is {p.FullName}{(string.IsNullOrWhiteSpace(p.Headline) ? "" : " — " + p.Headline)}{(string.IsNullOrWhiteSpace(p.Location) ? "" : ", based in " + p.Location)}.";

        var drafts = _services.DraftRepo.All();
        var jobCount = _services.JobRepo.Count();
        var companyCount = _services.CompanyRepo.Count();
        var state = $"Current state: {jobCount} job postings collected, {companyCount} companies collected, {drafts.Count(d => d.Status == DraftStatus.Draft)} drafts pending, {drafts.Count(d => d.Status == DraftStatus.Approved)} approved.";

        // Give the model the actual collected items so it can list/discuss them instead of starting a new search.
        var collected = "";
        if (jobCount > 0)
        {
            var rows = _services.JobRepo.All()
                .OrderByDescending(j => j.Included).ThenByDescending(j => j.RankScore)
                .Take(25)
                .Select(j => $"- {j.Title}{(string.IsNullOrWhiteSpace(j.Company) ? "" : " @ " + j.Company)}{(string.IsNullOrWhiteSpace(j.Location) ? "" : " (" + j.Location + ")")}");
            collected = "\n\nJob postings already collected (these are real, in the app — do NOT invent or re-search; to display them as a checklist use [[ACTION:list]]):\n" + string.Join("\n", rows);
        }
        else if (companyCount > 0)
        {
            var rows = _services.CompanyRepo.All().Take(25).Select(c => $"- {c.Name}{(string.IsNullOrWhiteSpace(c.Website) ? "" : " — " + c.Website)}");
            collected = "\n\nCompanies already collected (real, in the app — to display them use [[ACTION:list]]):\n" + string.Join("\n", rows);
        }

        var system =
            "You are the Jobomate assistant — a warm, capable copilot inside a job-search and application-automation app. " +
            "Answer the user fully and naturally on ANY topic, just like a normal assistant. You are not restricted to job topics. " +
            who + " " + state + " " +
            "You also have specialised tools for the user's job hunt. When the user clearly wants to run one, append the matching directive on its OWN line at the very end of your reply — choose only from:\n" +
            "[[ACTION:recent]] — find & rank recent job postings\n" +
            "[[ACTION:unsolicited]] — research employers for speculative applications\n" +
            "[[ACTION:run]] — run the current search\n" +
            "[[ACTION:list]] — show the job postings / companies ALREADY collected, as a checklist in chat\n" +
            "[[ACTION:draft]] — draft tailored applications for the collected/selected postings (you review before anything sends)\n" +
            "[[ACTION:approve]] — approve all pending drafts\n" +
            "[[ACTION:schedule]] — schedule approved applications to send gradually\n" +
            "[[ACTION:send]] — send due items (dry-run unless a real email account is connected)\n" +
            "[[ACTION:browser]] — open the built-in LLM Browser panel\n" +
            "[[ACTION:research]] — drive the LLM Browser to collect job postings from the user's sites (you take over the browser)\n" +
            "[[ACTION:companies]] — drive the LLM Browser to collect companies for speculative/unsolicited applications\n" +
            "[[ACTION:settings]] — open settings\n" +
            "Only add a directive when the user actually asks for that action; otherwise just reply normally with no directive. " +
            "If the user asks to see/list the jobs you've already collected, do NOT start a new browser search — append [[ACTION:list]]. " +
            "If they ask to apply or prepare applications, append [[ACTION:draft]]. " +
            "When drafting applications, never invent the user's skills, employers, titles, or experience. Keep replies concise." +
            collected;

        var persona = _services.Preferences.LlmPersona;
        if (!string.IsNullOrWhiteSpace(persona))
            system += "\n\nThe user has given you these guidelines and persona for the job hunt — treat them as your own rules and follow them closely:\n" + persona.Trim();

        var sites = _services.Preferences.SearchSites;
        if (sites.Count > 0)
            system += "\n\nThe user has scoped your job research to ONLY these websites — pull from and search inside these (use [[ACTION:research]] to do it in the browser):\n" + string.Join("\n", sites);

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

    private async Task RunAction(string action)
    {
        switch (action)
        {
            case "recent": StartMode(SearchMode.RecentJobs); break;
            case "unsolicited": StartMode(SearchMode.Unsolicited); break;
            case "run": await RunSearch(); break;
            case "approve": ApproveAll(); break;
            case "schedule": ScheduleApproved(); break;
            case "send": await SendDue(); break;
            case "browser": _openSidecar("browser"); break;
            case "research": await RunBrowserAgent(BrowserGoal.JobPostings); break;
            case "companies": await RunBrowserAgent(BrowserGoal.Companies); break;
            case "list": ListCollected(); break;
            case "draft": await DraftCollected(); break;
            case "settings": _openSidecar("settings"); break;
        }
    }

    /// <summary>Public entry point so the Browser sidecar panel can ask the assistant to take over
    /// the LLM Browser. Pass an empty url to drive whatever page is already open (e.g. after the
    /// user has logged in); pass a url to open it first.</summary>
    public void StartBrowserRun(BrowserGoal goal, string? startUrl) => _ = RunBrowserAgent(goal, startUrl);

    /// <summary>Drive the built-in LLM Browser to collect job postings or companies. The connected
    /// model navigates a real WebKit browser; the user logs in / clears CAPTCHAs in that window.</summary>
    private async Task RunBrowserAgent(BrowserGoal goal, string? startUrlOverride = null)
    {
        if (_browsing) return;
        if (!LlmConfigured())
        {
            AddAssistant("Connect a model first (Settings → LLM) — the LLM Browser is driven by your connected model.");
            _openSidecar("settings");
            return;
        }

        var sites = _services.Preferences.SearchSites;
        var startUrl = startUrlOverride is not null
            ? startUrlOverride
            : sites.Count > 0 ? sites[0]
            : goal == BrowserGoal.Companies ? "https://www.google.com/search?q=companies+hiring"
            : "https://www.linkedin.com/jobs/";

        _browsing = true;
        var kind = goal == BrowserGoal.Companies ? "companies" : "job postings";
        _openSidecar("browser");
        AddAssistant(string.IsNullOrWhiteSpace(startUrl)
            ? $"Taking over the open LLM Browser to collect {kind}. I pause and wait for you on any login or CAPTCHA, then extract."
            : $"Opening the LLM Browser at {ShortHost(startUrl)} to collect {kind}. Log in or solve any CAPTCHA in that window — I pause and wait for you, then take over and extract.");

        var run = new SearchRun
        {
            ThreadId = _threadId,
            Mode = goal == BrowserGoal.Companies ? SearchMode.Unsolicited : SearchMode.RecentJobs,
            Status = SearchRunStatus.Running,
        };
        _services.SearchRunRepo.Upsert(run);

        var agent = _services.BuildBrowserAgent(
            onProgress: s => Dispatcher.UIThread.Post(() => _services.SetStatus(s)),
            onAssistant: s => Dispatcher.UIThread.Post(() => AddAssistant(s)));

        try
        {
            var result = await agent.RunAsync(startUrl, goal, targetCount: 25, searchRunId: run.Id);
            if (goal == BrowserGoal.Companies)
            {
                _services.CompanyRepo.UpsertAll(result.Companies);
                if (result.Companies.Count > 0)
                {
                    AddAssistant($"Collected {result.Companies.Count} compan{(result.Companies.Count == 1 ? "y" : "ies")} with the LLM Browser — here they are. Tick the ones to approach and I'll draft speculative applications.");
                    PresentCompanies(result.Companies);
                }
                else AddAssistant("I couldn't pull any companies from there. Try a different site or open the browser and navigate to a company/employer directory, then take over again.");
            }
            else
            {
                _services.JobRepo.UpsertAll(result.Jobs);
                if (result.Jobs.Count > 0)
                {
                    AddAssistant($"Collected {result.Jobs.Count} job posting(s) with the LLM Browser — here they are. Tick the ones you want and I'll draft tailored applications with cover letters.");
                    PresentJobs(result.Jobs);
                }
                else AddAssistant("I couldn't pull any postings from there. Try a different site, or open the browser and navigate to a listing page, then take over again.");
            }
            run.Status = SearchRunStatus.Completed;
            run.CompletedAt = DateTimeOffset.UtcNow;
            run.ResultCount = result.Count;
            _services.SearchRunRepo.Upsert(run);
            ThreadsChanged?.Invoke();
        }
        catch (Exception ex)
        {
            AddAssistant("LLM Browser problem: " + ex.Message);
            run.Status = SearchRunStatus.Failed;
            run.Message = ex.Message;
            _services.SearchRunRepo.Upsert(run);
        }
        finally { _browsing = false; }
        _services.SetStatus("");
    }

    private static string ShortHost(string url)
    {
        try { return new Uri(url).Host.Replace("www.", ""); } catch { return url; }
    }

    /// <summary>Render the postings/companies already collected (by the browser or a search) as a
    /// checklist in chat, so the user can review and draft from them.</summary>
    private void ListCollected()
    {
        var jobs = _services.JobRepo.All().ToList();
        if (jobs.Count > 0)
        {
            AddAssistant($"Here {(jobs.Count == 1 ? "is the 1 posting" : $"are the {jobs.Count} postings")} I've collected — tick the ones you want and I'll draft tailored applications:");
            PresentJobs(jobs);
            return;
        }
        var companies = _services.CompanyRepo.All().ToList();
        if (companies.Count > 0)
        {
            AddAssistant($"Here {(companies.Count == 1 ? "is the 1 company" : $"are the {companies.Count} companies")} I've collected — tick the ones to approach:");
            PresentCompanies(companies);
            return;
        }
        AddAssistant("I haven't collected any jobs or companies yet. Use the LLM Browser (sidebar → Browser) to gather some, then ask me to list them.");
    }

    /// <summary>Prepare applications for the collected items. If a checklist is already shown, draft
    /// the ticked ones; otherwise show the list first and let the user choose (nothing sends without
    /// approval).</summary>
    private async Task DraftCollected()
    {
        if (_jobChecks.Count == 0 && _companyChecks.Count == 0)
        {
            var jobs = _services.JobRepo.Count();
            var companies = _services.CompanyRepo.Count();
            if (jobs == 0 && companies == 0)
            {
                AddAssistant("Nothing to draft yet — collect some jobs or companies first (sidebar → Browser).");
                return;
            }
            ListCollected();
            AddAssistant("Tick the ones you want, then click “Draft applications for selected”. Every draft is kept for your review — nothing sends without your approval.");
            return;
        }
        if (_jobChecks.Count > 0) { await GenerateJobDrafts(); return; }
        if (_companyChecks.Count > 0) { await GenerateCompanyDrafts(); return; }
    }

    private void Interpret(string t)
    {
        if (t.Contains("list") || t.Contains("show me") || (t.Contains("show") && t.Contains("job"))) { ListCollected(); return; }
        if (t.Contains("draft") || t.Contains("prepare") || t.Contains("apply") || t.Contains("application")) { _ = DraftCollected(); return; }
        if (t.Contains("unsolicited") || t.Contains("speculative") || t == "2") { StartMode(SearchMode.Unsolicited); return; }
        if (t.Contains("recent") || t.Contains("posting") || t.Contains("job") || t == "1") { StartMode(SearchMode.RecentJobs); return; }
        if (t.Contains("run") || t.Contains("search") || t.Contains("go")) { _ = RunSearch(); return; }
        if (t.Contains("approve")) { ApproveAll(); return; }
        if (t.Contains("schedule")) { ScheduleApproved(); return; }
        if (t.Contains("send")) { _ = SendDue(); return; }
        if (t.Contains("browser") || t.Contains("extension") || t.Contains("chrome")) { OpenBrowserPanel(); return; }
        if (t.Contains("setting") || t.Contains("connect") || t.Contains("model")) { _openSidecar("settings"); return; }
        AddAssistant("Tell me “recent” or “unsolicited” to start, or use the buttons above. You can also say “run”, “approve”, “schedule”, or “send”.");
    }

    private async Task LoadCv()
    {
        var top = TopLevel.GetTopLevel(this);
        if (top is null) return;
        var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            AllowMultiple = false,
            FileTypeFilter = new[] { new FilePickerFileType("CV") { Patterns = new[] { "*.pdf", "*.txt", "*.md", "*.docx" } } },
        });
        var file = files.FirstOrDefault();
        if (file is null) return;
        AddAssistant("Reading your CV…");
        var profile = await _services.Profiles.BuildFromCvAsync(file.Path.LocalPath,
            LlmConfigured() ? _services.Llm : null, LlmConfigured() ? _services.LlmConfig : null);
        _services.SaveProfile(profile);
        AddAssistant(profile.FromFallback
            ? "Loaded your CV (used a heuristic profile — review it in Settings → Candidate profile)."
            : $"Loaded your CV. Profile: {profile.Headline}. Review it in Settings → Candidate profile, then pick a mode above.");
    }

    // ----- keyboard + drag/drop -----

    private void OnComposerKey(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            var shift = (e.KeyModifiers & KeyModifiers.Shift) != 0;
            if (!shift) { SubmitInput(); e.Handled = true; }   // Enter = send · Shift+Enter = newline · Cmd+Enter = send
        }
        else if (e.Key == Key.Escape)
        {
            InputBox.Text = "";
            e.Handled = true;
        }
    }

    private void OnDragOver(object? sender, DragEventArgs e) =>
        e.DragEffects = e.Data.Contains(DataFormats.Files) ? DragDropEffects.Copy : DragDropEffects.None;

    private async void OnDrop(object? sender, DragEventArgs e)
    {
        if (!e.Data.Contains(DataFormats.Files)) return;
        var files = e.Data.GetFiles();
        if (files is null) return;
        foreach (var f in files)
        {
            try { await HandleDroppedFile(f.Path.LocalPath); }
            catch (Exception ex) { AddAssistant("Couldn't use that file: " + ex.Message); }
        }
    }

    private async Task HandleDroppedFile(string path)
    {
        var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".gguf")
        {
            var cfg = _services.LlmConfig;
            cfg.ConnectionType = AppConnectionType.LocalAI;
            cfg.LocalAIModelPath = path;
            cfg.Connected = true;
            _services.SaveLlmConfig(cfg);
            RefreshStatus();
            AddAssistant($"Connected local GGUF model **{System.IO.Path.GetFileName(path)}**. It runs on a loopback OpenAI-compatible endpoint via llama.cpp (a llama-server runtime must be present on this machine). You can chat with it now.");
            return;
        }
        if (ext is ".pdf" or ".docx" or ".doc" or ".txt" or ".md" or ".rtf")
        {
            AddAssistant("Reading your CV…");
            var profile = await _services.Profiles.BuildFromCvAsync(path,
                LlmConfigured() ? _services.Llm : null, LlmConfigured() ? _services.LlmConfig : null);
            _services.SaveProfile(profile);
            AddAssistant(profile.FromFallback
                ? "Loaded the document (heuristic profile — review it in Settings → Candidate profile)."
                : $"Loaded your CV. Profile: {profile.Headline}. Pick a mode above to start, or just chat.");
            return;
        }
        AddAssistant($"Attached **{System.IO.Path.GetFileName(path)}**. (I load CVs and .gguf models directly; other files are noted but not parsed.)");
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
        if (!c.Connected) return false;   // honour Connect/Disconnect
        return c.ConnectionType switch
        {
            AppConnectionType.ApiKey => !string.IsNullOrEmpty(_services.Credentials.GetApiKey(LlmClient.ApiKeyName(c.ApiProvider))),
            AppConnectionType.LocalServer => !string.IsNullOrWhiteSpace(c.LocalServerUrl),
            AppConnectionType.LocalAI => !string.IsNullOrWhiteSpace(c.LocalAIModelPath),
            AppConnectionType.CliPipe => !string.IsNullOrWhiteSpace(c.CliCommand),
            AppConnectionType.Terminal => !string.IsNullOrWhiteSpace(c.TerminalCommand),
            _ => true,   // OAuth etc. — if marked connected, trust it
        };
    }

    private static async Task<DraftResult> TryDraft(Func<Task<DraftResult>> llm, Func<DraftResult> offline)
    {
        try { return await llm(); } catch { return offline(); }
    }

    private static IBrush Hex(string hex) => new SolidColorBrush(Color.Parse(hex));
}
