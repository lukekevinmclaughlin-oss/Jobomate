using System;
using System.Collections.Generic;
using System.Linq;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using Jobomate.Browser;
using Jobomate.Contracts;
using Jobomate.Filters;
using Jobomate.Scheduling;

namespace Jobomate.Views;

/// <summary>
/// The MAOS-style sidecar: tahoe-panel chrome (accent-dot header, sidecar-chrome close), a pill
/// selector, and a content host that swaps between the job-automation panels —
/// Activity, Approval wall, Queue &amp; tracker, Browser sandbox, and Settings.
/// </summary>
public partial class SidecarView : UserControl
{
    private static readonly IBrush TextBrush = Hex("#FAFAFA");
    private static readonly IBrush MutedBrush = Hex("#A1A1AA");
    private static readonly IBrush GreenBrush = Hex("#1FC95A");
    private static readonly IBrush WarnBrush = Hex("#F2BE1A");

    private static readonly (string Key, string Label)[] Panels =
    {
        ("activity", "Activity"),
        ("approval", "Approval"),
        ("queue", "Queue"),
        ("browser", "Browser"),
        ("settings", "Settings"),
    };

    private JobomateServices _services = null!;
    private SendRunner? _runner;
    private DispatcherTimer? _timer;
    private string _current = "activity";
    private ItemsControl? _activityList;
    private TextBlock? _browserStatus;
    private Button? _browserResume;

    public event Action? CloseRequested;

    /// <summary>Raised when the user clicks “Let assistant take over” in the Browser panel. The host
    /// forwards it to the chat so the run shows there. The string is the URL to open first (empty =
    /// drive whatever page is already open, e.g. after the user logged in).</summary>
    public event Action<BrowserGoal, string>? TakeOverRequested;

    public SidecarView() => InitializeComponent();

    public void Bind(JobomateServices services)
    {
        _services = services;
        CloseButton.Click += (_, _) => CloseRequested?.Invoke();
        _services.Browser.Changed += () => Dispatcher.UIThread.Post(RefreshBrowserUi);

        foreach (var (key, label) in Panels)
        {
            var btn = new Button { Content = label, Tag = key, Margin = new Thickness(0, 0, 6, 6) };
            btn.Classes.Add("tahoe-pill");
            btn.Click += (_, _) => Show(key);
            Selector.Children.Add(btn);
        }

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) };
        _timer.Tick += (_, _) => Tick();
        AttachedToVisualTree += (_, _) => _timer.Start();
        DetachedFromVisualTree += (_, _) => _timer.Stop();

        Show("activity");
    }

    public void Show(string key)
    {
        _current = key;
        SidecarTitle.Text = Panels.FirstOrDefault(p => p.Key == key).Label ?? "Sidecar";
        foreach (var child in Selector.Children.OfType<Button>())
            child.Background = (string?)child.Tag == key ? Hex("#16243C") : null;

        ContentHost.Content = key switch
        {
            "approval" => BuildApproval(),
            "queue" => BuildQueue(),
            "browser" => BuildBrowser(),
            "settings" => BuildSettings(),
            _ => BuildActivity(),
        };
    }

    private void Tick()
    {
        if (_current == "activity" && _activityList is not null)
            _activityList.ItemsSource = RecentActivity();
    }

    // ----- Activity -----

    private Control BuildActivity()
    {
        var sp = new StackPanel { Spacing = 10 };

        var jobs = _services.JobRepo.Count();
        var drafts = _services.DraftRepo.All();
        var queued = _services.QueueRepo.All().Count(i => i.Status == SendStatus.Pending);
        sp.Children.Add(Card(new StackPanel
        {
            Spacing = 4,
            Children =
            {
                Caption("NOW"),
                new TextBlock { Text = string.IsNullOrEmpty(_services.Status) ? "Ready" : _services.Status, Foreground = TextBrush, FontWeight = FontWeight.SemiBold, FontSize = 13.5, TextWrapping = TextWrapping.Wrap },
                new TextBlock { Text = $"{jobs} jobs · {drafts.Count(d => d.Status == DraftStatus.Draft)} drafts · {drafts.Count(d => d.Status == DraftStatus.Approved)} approved · {queued} queued", Foreground = MutedBrush, FontSize = 11.5 },
            },
        }));

        sp.Children.Add(Caption("RECENT ACTIVITY"));
        _activityList = new ItemsControl { ItemsSource = RecentActivity() };
        _activityList.ItemTemplate = new Avalonia.Controls.Templates.FuncDataTemplate<string>((s, _) =>
            new TextBlock { Text = s, Foreground = MutedBrush, FontSize = 10.5, FontFamily = new FontFamily("Menlo, monospace"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 2) });
        sp.Children.Add(_activityList);
        return sp;
    }

    private List<string> RecentActivity() => _services.Audit.Recent(40)
        .Select(e => $"{e.At.ToLocalTime():HH:mm:ss}  {e.Category}/{e.Action}  {Trunc(e.Target, 34)}")
        .ToList();

    // ----- Approval wall -----

    private Control BuildApproval()
    {
        var sp = new StackPanel { Spacing = 10 };
        sp.Children.Add(new TextBlock { Text = "Approval wall", Foreground = TextBrush, FontWeight = FontWeight.SemiBold, FontSize = 14 });
        sp.Children.Add(new TextBlock { Text = "Nothing sends until you approve — and it stays dry-run until you connect a real email account.", Foreground = MutedBrush, FontSize = 11.5, TextWrapping = TextWrapping.Wrap });

        // Assistant guidelines / persona — the LLM treats this as its own rules for chat + drafting.
        sp.Children.Add(Caption("ASSISTANT GUIDELINES & PERSONA"));
        var personaBox = new TextBox
        {
            Text = _services.Preferences.LlmPersona,
            AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 92, FontSize = 12.5,
            Watermark = "e.g. \"Only fully-remote roles. Emphasise my leadership and shipping record. Warm, concise tone. Skip companies under 50 people.\"",
        };
        var personaStatus = new TextBlock { Foreground = MutedBrush, FontSize = 11 };
        sp.Children.Add(Card(new StackPanel
        {
            Spacing = 6,
            Children =
            {
                new TextBlock { Text = "Your rules for the assistant — it follows these as its persona and guidelines, in both chat and the application drafts it writes.", Foreground = MutedBrush, FontSize = 11.5, TextWrapping = TextWrapping.Wrap },
                personaBox,
                Pill("Save guidelines", "accent", () => { var p = _services.Preferences; p.LlmPersona = personaBox.Text ?? ""; _services.SavePreferences(p); personaStatus.Text = "Saved — the assistant will follow these."; }),
                personaStatus,
            },
        }));

        sp.Children.Add(Caption("DRAFTS"));

        var drafts = _services.DraftRepo.All().Where(d => d.Status == DraftStatus.Draft).ToList();
        if (drafts.Count == 0)
            sp.Children.Add(new TextBlock { Text = "No drafts waiting. Generate some from the chat first.", Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(0, 6, 0, 0) });

        foreach (var draft in drafts)
        {
            var email = _services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == draft.Id);
            var status = new TextBlock { Text = "Status: Draft", Foreground = WarnBrush, FontSize = 11.5 };
            var body = new StackPanel
            {
                Spacing = 5,
                Children =
                {
                    new TextBlock { Text = $"{draft.Company} — {draft.RoleTitle}", Foreground = TextBrush, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap },
                    new TextBlock { Text = "To: " + (email?.ToAddress ?? "(no recipient — needs manual contact)"), Foreground = MutedBrush, FontSize = 11.5 },
                    new TextBlock { Text = "Subject: " + (email?.Subject ?? ""), Foreground = TextBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap },
                    new TextBox { Text = email?.Body ?? "", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 90, MaxHeight = 160, FontSize = 12 },
                },
            };
            var bodyBox = (TextBox)body.Children[3];
            var row = new WrapPanel();
            row.Children.Add(Pill("Approve", "accent", () => { if (email is not null) { email.Body = bodyBox.Text ?? ""; _services.EmailRepo.Upsert(email); } _services.Approval.Approve(draft.Id); status.Text = "Status: Approved ✓"; status.Foreground = GreenBrush; }));
            row.Children.Add(Pill("Reject", "ghost", () => { _services.Approval.Reject(draft.Id); status.Text = "Status: Rejected"; status.Foreground = MutedBrush; }));
            body.Children.Add(row);
            body.Children.Add(status);
            sp.Children.Add(Card(body));
        }

        if (drafts.Count > 0)
        {
            var actions = new WrapPanel { Margin = new Thickness(0, 4, 0, 0) };
            actions.Children.Add(Pill("Approve all", "accent", () => { _services.Approval.ApproveBatch(drafts.Select(d => d.Id).ToList()); Show("approval"); }));
            actions.Children.Add(Pill("Schedule approved", "ghost", () => { var q = _services.BuildQueueService(); foreach (var d in _services.DraftRepo.All().Where(x => x.Status == DraftStatus.Approved)) q.Enqueue(d.Id); Show("queue"); }));
            sp.Children.Add(actions);
        }
        return sp;
    }

    // ----- Queue & tracker -----

    private Control BuildQueue()
    {
        _runner ??= _services.BuildSendRunner();
        var sp = new StackPanel { Spacing = 10 };
        sp.Children.Add(new TextBlock { Text = "Queue & tracker", Foreground = TextBrush, FontWeight = FontWeight.SemiBold, FontSize = 14 });

        var statusText = new TextBlock { Text = $"Queue: {_runner.State}", Foreground = MutedBrush, FontSize = 11.5, TextWrapping = TextWrapping.Wrap };
        var controls = new WrapPanel();
        controls.Children.Add(Pill("Send due now", "accent", async () =>
        {
            var sent = await _runner!.RunDueAsync();
            var dry = _services.BuildEmailSender().IsDryRun;
            statusText.Text = $"{(dry ? "Dry-run: recorded" : "Sent")} {sent}. Queue: {_runner.State}. {_runner.LastMessage}";
            Show("queue");
        }));
        controls.Children.Add(Pill("Pause", "ghost", () => { _runner!.Pause(); statusText.Text = $"Queue: {_runner.State}"; }));
        controls.Children.Add(Pill("Resume", "ghost", () => { _runner!.Resume(); statusText.Text = $"Queue: {_runner.State}"; }));
        controls.Children.Add(Pill("Cancel", "ghost", () => { _runner!.Cancel(); statusText.Text = $"Queue: {_runner.State}"; }));
        sp.Children.Add(controls);
        sp.Children.Add(statusText);

        sp.Children.Add(Caption("APPROVED QUEUE / OUTBOX"));
        var queue = _services.QueueRepo.All().OrderBy(i => i.ScheduledAt).ToList();
        if (queue.Count == 0) sp.Children.Add(new TextBlock { Text = "Nothing scheduled yet.", Foreground = MutedBrush, FontSize = 12 });
        foreach (var item in queue)
        {
            var draft = _services.DraftRepo.Get(item.ApplicationDraftId);
            sp.Children.Add(Card(new StackPanel
            {
                Spacing = 2,
                Children =
                {
                    new TextBlock { Text = draft?.Company ?? item.ApplicationDraftId, Foreground = TextBrush, FontWeight = FontWeight.SemiBold, FontSize = 13, TextWrapping = TextWrapping.Wrap },
                    new TextBlock { Text = $"scheduled {item.ScheduledAt.ToLocalTime():ddd dd MMM HH:mm}", Foreground = MutedBrush, FontSize = 11 },
                    new TextBlock { Text = item.Status.ToString(), Foreground = item.Status == SendStatus.Sent ? GreenBrush : WarnBrush, FontSize = 11.5 },
                },
            }));
        }

        sp.Children.Add(Caption("APPLICATION TRACKER"));
        var records = _services.RecordRepo.All().OrderByDescending(r => r.LastUpdateAt).Take(20).ToList();
        if (records.Count == 0) sp.Children.Add(new TextBlock { Text = "No applications tracked yet.", Foreground = MutedBrush, FontSize = 12 });
        foreach (var r in records)
            sp.Children.Add(new TextBlock { Text = $"{r.Company} — {r.Status}  ·  {r.LastUpdateAt.ToLocalTime():dd MMM HH:mm}", Foreground = MutedBrush, FontSize = 11.5, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 1, 0, 1) });
        return sp;
    }

    // ----- Browser sandbox -----

    private Control BuildBrowser()
    {
        var sp = new StackPanel { Spacing = 10 };
        sp.Children.Add(new TextBlock { Text = "LLM Browser", Foreground = TextBrush, FontWeight = FontWeight.SemiBold, FontSize = 14 });
        sp.Children.Add(new TextBlock
        {
            Text = "A real WebKit browser built into Jobomate. Open a site, log in or solve any CAPTCHA yourself, then let your connected model take over to collect job postings — or companies for unsolicited applications. No extension and no separate Chrome, and it never bypasses a login or CAPTCHA.",
            Foreground = MutedBrush, FontSize = 11.5, TextWrapping = TextWrapping.Wrap,
        });

        // Persistent search scope — the sites the assistant prefers to use.
        sp.Children.Add(Caption("SEARCH SCOPE — SITES TO USE (one per line)"));
        var sitesBox = new TextBox
        {
            Text = string.Join("\n", _services.Preferences.SearchSites),
            AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 70, FontSize = 12,
            Watermark = "www.linkedin.com/jobs/\nweworkremotely.com\nboards.greenhouse.io/acme",
        };
        sp.Children.Add(sitesBox);

        List<string> ReadSites() => (sitesBox.Text ?? "").Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(NormalizeUrl).Where(u => u is not null).Select(u => u!).Distinct().ToList();
        void SaveSites() { var p = _services.Preferences; p.SearchSites = ReadSites(); _services.SavePreferences(p); }

        // Address to open in the LLM Browser.
        sp.Children.Add(Caption("OPEN THIS ADDRESS"));
        var addr = new TextBox
        {
            Text = _services.Preferences.SearchSites.FirstOrDefault() ?? "",
            Watermark = "https://www.linkedin.com/jobs/  ·  any job board or company careers page",
            FontSize = 12,
        };
        sp.Children.Add(addr);

        // What to collect.
        sp.Children.Add(Caption("WHAT SHOULD THE ASSISTANT COLLECT?"));
        var jobsRb = new RadioButton { Content = "Job postings to apply to", GroupName = "browsergoal", IsChecked = true, Foreground = TextBrush, FontSize = 12.5 };
        var compRb = new RadioButton { Content = "Companies for unsolicited applications", GroupName = "browsergoal", Foreground = TextBrush, FontSize = 12.5 };
        sp.Children.Add(new StackPanel { Spacing = 2, Children = { jobsRb, compRb } });
        BrowserGoal Goal() => compRb.IsChecked == true ? BrowserGoal.Companies : BrowserGoal.JobPostings;

        var status = new TextBlock { Foreground = MutedBrush, FontSize = 11.5, TextWrapping = TextWrapping.Wrap };
        var resume = Pill("Resume — I've handled it", "accent", () => _services.Browser.Resume());
        _browserStatus = status;
        _browserResume = resume;
        RefreshBrowserUi();

        var row = new WrapPanel();
        row.Children.Add(Pill("Open browser", "ghost", async () =>
        {
            var url = NormalizeUrl(addr.Text ?? "");
            if (url is null) { status.Text = "Type an address to open first."; return; }
            SaveSites();
            status.Text = "Opening the LLM Browser…";
            await _services.Browser.OpenAsync(url);
            RefreshBrowserUi();
        }));
        row.Children.Add(Pill("Let assistant take over", "accent", () =>
        {
            SaveSites();
            // If the browser is already open (e.g. the user just logged in), drive the current page;
            // otherwise hand over the typed address so the assistant opens it first.
            var url = _services.Browser.IsRunning ? "" : (NormalizeUrl(addr.Text ?? "") ?? "");
            TakeOverRequested?.Invoke(Goal(), url);
        }));
        row.Children.Add(Pill("Save sites", "ghost", () =>
        {
            SaveSites();
            var s = ReadSites();
            status.Text = s.Count == 0 ? "Cleared — the assistant can use any site." : $"Saved {s.Count} site(s): {string.Join(", ", s.Select(ShortUrl))}.";
        }));
        sp.Children.Add(row);

        sp.Children.Add(Card(new StackPanel { Spacing = 6, Children = { Caption("STATUS"), status, resume } }));
        return sp;
    }

    private void RefreshBrowserUi()
    {
        if (_browserStatus is null) return;
        var b = _services.Browser;
        if (b.NeedsUserReason is { Length: > 0 } reason)
        {
            _browserStatus.Text = "⏸ Action needed — " + reason + "  (handle it in the browser window, then Resume)";
            _browserStatus.Foreground = WarnBrush;
            if (_browserResume is not null) _browserResume.IsVisible = true;
        }
        else
        {
            _browserStatus.Text = b.IsRunning ? "● " + b.Status : "○ " + (string.IsNullOrEmpty(b.Status) ? "Not started" : b.Status);
            _browserStatus.Foreground = b.IsRunning ? GreenBrush : MutedBrush;
            if (_browserResume is not null) _browserResume.IsVisible = false;
        }
    }

    // ----- Settings -----

    private Control BuildSettings()
    {
        var sp = new StackPanel { Spacing = 16 };

        var conn = new ConnectionSettingsHost();
        conn.Bind(_services);
        sp.Children.Add(conn);

        // Email account
        sp.Children.Add(Divider());
        sp.Children.Add(new TextBlock { Text = "Email account", Foreground = TextBrush, FontWeight = FontWeight.SemiBold, FontSize = 14 });
        var emailGroup = new StackPanel { Spacing = 6 };
        var providers = new (EmailProviderKind Kind, string Label)[]
        {
            (EmailProviderKind.DryRun, "Dry run (never sends)"),
            (EmailProviderKind.Smtp, "SMTP"),
            (EmailProviderKind.GmailOAuth, "Gmail (OAuth)"),
            (EmailProviderKind.MicrosoftGraph, "Microsoft 365 (Graph)"),
        };
        var emailRadios = new List<(RadioButton Rb, EmailProviderKind Kind)>();
        foreach (var (kind, label) in providers)
        {
            var rb = new RadioButton { Content = label, GroupName = "email", IsChecked = _services.EmailConfig.Provider == kind };
            emailRadios.Add((rb, kind));
            emailGroup.Children.Add(rb);
        }
        var emailStatus = new TextBlock { Foreground = MutedBrush, FontSize = 11.5 };
        emailGroup.Children.Add(Pill("Save email account", "accent", () =>
        {
            var chosen = emailRadios.First(r => r.Rb.IsChecked == true).Kind;
            var cfg = _services.EmailConfig;
            cfg.Provider = chosen;
            cfg.Tested = chosen == EmailProviderKind.DryRun;
            _services.SaveEmailConfig(cfg);
            emailStatus.Text = chosen == EmailProviderKind.DryRun ? "Saved — dry-run (safe)." : "Saved. SMTP/OAuth need their own credentials before sending.";
        }));
        emailGroup.Children.Add(emailStatus);
        sp.Children.Add(emailGroup);

        // Candidate profile
        sp.Children.Add(Divider());
        sp.Children.Add(new TextBlock { Text = "Candidate profile", Foreground = TextBrush, FontWeight = FontWeight.SemiBold, FontSize = 14 });
        var p = _services.Profile;
        var name = LabeledBox("Full name", p.FullName);
        var headline = LabeledBox("Headline", p.Headline);
        var location = LabeledBox("Location", p.Location);
        var summary = LabeledBox("Summary", p.Summary, multiline: true);
        var profStatus = new TextBlock { Foreground = MutedBrush, FontSize = 11.5 };
        var profActions = new WrapPanel();
        profActions.Children.Add(Pill("Load a CV…", "ghost", async () =>
        {
            var top = TopLevel.GetTopLevel(this);
            if (top is null) return;
            var files = await top.StorageProvider.OpenFilePickerAsync(new Avalonia.Platform.Storage.FilePickerOpenOptions { AllowMultiple = false });
            var file = files.FirstOrDefault();
            if (file is null) return;
            profStatus.Text = "Reading…";
            var built = await _services.Profiles.BuildFromCvAsync(file.Path.LocalPath, null, null);
            _services.SaveProfile(built);
            Show("settings");
        }));
        profActions.Children.Add(Pill("Save profile", "accent", () =>
        {
            var pr = _services.Profile;
            pr.FullName = name.Box.Text ?? "";
            pr.Headline = headline.Box.Text ?? "";
            pr.Location = location.Box.Text ?? "";
            pr.Summary = summary.Box.Text ?? "";
            _services.SaveProfile(pr);
            profStatus.Text = "Saved.";
        }));
        sp.Children.Add(name.Root);
        sp.Children.Add(headline.Root);
        sp.Children.Add(location.Root);
        sp.Children.Add(summary.Root);
        sp.Children.Add(profActions);
        sp.Children.Add(profStatus);

        // Search filters
        sp.Children.Add(Divider());
        sp.Children.Add(new TextBlock { Text = "Search filters", Foreground = TextBrush, FontWeight = FontWeight.SemiBold, FontSize = 14 });
        var prefs = _services.Preferences;
        var locBox = LabeledBox("Location (blank = anywhere)", prefs.Location);
        var langModes = new (string Label, LanguageMatchMode Mode)[]
        {
            ("Strict required-language match", LanguageMatchMode.StrictRequired),
            ("Include unclear language postings", LanguageMatchMode.IncludeUnclear),
            ("Include preferred-language mismatches", LanguageMatchMode.IncludePreferredMismatch),
            ("Show all, but flag mismatches", LanguageMatchMode.ShowAllFlag),
        };
        var langCombo = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var (label, _) in langModes) langCombo.Items.Add(label);
        langCombo.SelectedIndex = Math.Max(0, Array.FindIndex(langModes, m => m.Mode == prefs.LanguageMode));
        var langsBox = LabeledBox("Accepted languages (comma-separated)", string.Join(", ", prefs.AcceptedLanguages));
        var filtStatus = new TextBlock { Foreground = MutedBrush, FontSize = 11.5 };
        sp.Children.Add(locBox.Root);
        sp.Children.Add(new TextBlock { Text = "Language match mode", Foreground = MutedBrush, FontSize = 11.5 });
        sp.Children.Add(langCombo);
        sp.Children.Add(langsBox.Root);
        sp.Children.Add(Pill("Save filters", "accent", () =>
        {
            var pr = _services.Preferences;
            pr.Location = locBox.Box.Text ?? "";
            pr.LanguageMode = langModes[Math.Max(0, langCombo.SelectedIndex)].Mode;
            pr.AcceptedLanguages = (langsBox.Box.Text ?? "").Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            _services.SavePreferences(pr);
            filtStatus.Text = "Saved.";
        }));
        sp.Children.Add(filtStatus);
        return sp;
    }

    // ----- helpers -----

    private Border Card(Control child) => new()
    {
        Background = Hex("#141418"),
        BorderBrush = Hex("#222228"),
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(10),
        Padding = new Thickness(12),
        Child = child,
    };

    private Border Divider() => new() { Height = 1, Background = Hex("#1C1C1C"), Margin = new Thickness(0, 2, 0, 2) };

    private TextBlock Caption(string text) => new() { Text = text, Foreground = MutedBrush, FontSize = 10, FontWeight = FontWeight.SemiBold };

    private Button Pill(string label, string cls, Action onClick)
    {
        var b = new Button { Content = label, Margin = new Thickness(0, 4, 8, 0) };
        b.Classes.Add(cls);
        b.Click += (_, _) => onClick();
        return b;
    }

    private Button Pill(string label, string cls, Func<System.Threading.Tasks.Task> onClick)
    {
        var b = new Button { Content = label, Margin = new Thickness(0, 4, 8, 0) };
        b.Classes.Add(cls);
        b.Click += async (_, _) => await onClick();
        return b;
    }

    private (StackPanel Root, TextBox Box) LabeledBox(string label, string value, bool multiline = false)
    {
        var box = new TextBox { Text = value ?? "", FontSize = 13 };
        if (multiline) { box.AcceptsReturn = true; box.TextWrapping = TextWrapping.Wrap; box.MinHeight = 70; }
        var root = new StackPanel { Spacing = 3, Children = { new TextBlock { Text = label, Foreground = MutedBrush, FontSize = 11.5 }, box } };
        return (root, box);
    }

    private static string Trunc(string s, int n) => string.IsNullOrEmpty(s) ? "" : (s.Length <= n ? s : s[..n] + "…");

    /// <summary>Accept bare domains too — "www.google.com" → "https://www.google.com".</summary>
    private static string? NormalizeUrl(string u)
    {
        u = (u ?? "").Trim();
        if (u.Length == 0) return null;
        if (u.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || u.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return u;
        return u.Contains('.') && !u.Contains(' ') ? "https://" + u : null;
    }

    private static string ShortUrl(string u)
    {
        try { var h = new Uri(u).Host; return h.StartsWith("www.") ? h[4..] : h; }
        catch { return u; }
    }

    private static IBrush Hex(string hex) => new SolidColorBrush(Color.Parse(hex));
}
