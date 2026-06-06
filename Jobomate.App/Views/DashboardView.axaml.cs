using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using Jobomate.Contracts;
using Jobomate.Drafting;
using Jobomate.Email;
using Jobomate.Extension;
using Jobomate.Filters;
using Jobomate.Llm;
using Jobomate.Llm.Local;
using Jobomate.Scheduling;
using Jobomate.Sources;
using Jobomate.ViewModels;

namespace Jobomate.Views;

public partial class DashboardView : UserControl
{
    private static readonly string[] Locations = { "Munich", "Bavaria", "Germany", "EU", "Worldwide remote", "Custom" };

    private static readonly (string Label, LanguageMatchMode Mode)[] LangModes =
    {
        ("Strict required-language match", LanguageMatchMode.StrictRequired),
        ("Include unclear language postings", LanguageMatchMode.IncludeUnclear),
        ("Include preferred-language mismatches", LanguageMatchMode.IncludePreferredMismatch),
        ("Show all, but flag mismatches", LanguageMatchMode.ShowAllFlag),
    };

    private JobomateServices _services = null!;
    private readonly List<CheckBox> _languageChecks = new();
    private SendRunner? _runner;
    private List<JobPosting> _lastJobs = new();
    private List<CompanyTarget> _lastCompanies = new();
    private DraftRow? _selectedDraft;

    public DashboardView() => InitializeComponent();

    public void Bind(JobomateServices services)
    {
        _services = services;

        PopulateProfileTab();
        PopulateSearchTab();
        PopulateSettingsTab();
        PopulateBrowserTab();
        PopulateAdvancedTab();
        RefreshDrafts();
        RefreshQueue();
        RefreshTracker();
        RefreshAudit();

        WireProfile();
        WireSearch();
        WireDrafts();
        WireQueue();
        WireSettings();
        WireAudit();
        WireBrowser();
        WireAdvanced();
    }

    // =================== PROFILE ===================

    private void PopulateProfileTab()
    {
        var p = _services.Profile;
        PName.Text = p.FullName;
        PHeadline.Text = p.Headline;
        PLocation.Text = p.Location;
        PEmail.Text = p.Email;
        PSummary.Text = p.Summary;
        PFacts.Text =
            $"Experience: {p.YearsExperience}+ years  ·  Industries: {string.Join(", ", p.Industries)}\n" +
            $"Languages: {string.Join(", ", p.Languages.Select(l => $"{l.Language} ({l.Level})"))}\n" +
            $"Available from: {JobomateConstants.AvailabilityText}  ·  Education: {string.Join("; ", p.Education)}";
    }

    private void WireProfile()
    {
        SaveProfileButton.Click += (_, _) =>
        {
            var p = _services.Profile;
            p.FullName = PName.Text ?? p.FullName;
            p.Headline = PHeadline.Text ?? p.Headline;
            p.Location = PLocation.Text ?? p.Location;
            p.Email = PEmail.Text ?? p.Email;
            p.Summary = PSummary.Text ?? p.Summary;
            _services.SaveProfile(p);
            PopulateProfileTab();
            ProfileStatus.Text = "Saved.";
        };
        LoadCvButton.Click += async (_, _) =>
        {
            var top = TopLevel.GetTopLevel(this);
            if (top is null) return;
            var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                AllowMultiple = false,
                FileTypeFilter = new[] { new FilePickerFileType("CV") { Patterns = new[] { "*.pdf", "*.txt", "*.md" } } },
            });
            var file = files.FirstOrDefault();
            if (file is null) return;
            ProfileStatus.Text = "Reading…";
            var profile = await _services.Profiles.BuildFromCvAsync(file.Path.LocalPath,
                LlmConfigured() ? _services.Llm : null, LlmConfigured() ? _services.LlmConfig : null);
            _services.SaveProfile(profile);
            PopulateProfileTab();
            ProfileStatus.Text = profile.FromFallback ? "Loaded (used known-background fallback)." : "Loaded and profile rebuilt.";
        };
    }

    // =================== SEARCH ===================

    private void PopulateSearchTab()
    {
        foreach (var loc in Locations) LocationCombo.Items.Add(loc);
        LocationCombo.SelectedItem = _services.Preferences.Location is { Length: > 0 } l && Locations.Contains(l) ? l : "Munich";

        foreach (var (label, _) in LangModes) LangModeCombo.Items.Add(label);
        LangModeCombo.SelectedIndex = Array.FindIndex(LangModes, m => m.Mode == _services.Preferences.LanguageMode);
        if (LangModeCombo.SelectedIndex < 0) LangModeCombo.SelectedIndex = 0;

        foreach (var lang in SearchPreferences.CommonLanguages)
        {
            var cb = new CheckBox
            {
                Content = lang,
                IsChecked = _services.Preferences.AcceptedLanguages.Contains(lang),
                Margin = new Avalonia.Thickness(0, 0, 12, 2),
            };
            _languageChecks.Add(cb);
            LanguagePanel.Children.Add(cb);
        }

        var wl = _services.Preferences.WorkLocations;
        WlRemote.IsChecked = wl.Contains(WorkLocationType.Remote);
        WlHybrid.IsChecked = wl.Contains(WorkLocationType.Hybrid);
        WlOnsite.IsChecked = wl.Contains(WorkLocationType.OnSite);
        IncludeUnclearWork.IsChecked = _services.Preferences.IncludeUnclearWorkLocation;
        ExcludeStartRisk.IsChecked = _services.Preferences.ExcludeStartDateRisk;
    }

    private SearchPreferences ReadPreferences()
    {
        var prefs = _services.Preferences;
        prefs.AcceptedLanguages = _languageChecks.Where(c => c.IsChecked == true).Select(c => (string)c.Content!).ToList();
        if (prefs.AcceptedLanguages.Count == 0) prefs.AcceptedLanguages.Add("English");
        prefs.LanguageMode = LangModes[Math.Max(0, LangModeCombo.SelectedIndex)].Mode;
        prefs.WorkLocations = new List<WorkLocationType>();
        if (WlRemote.IsChecked == true) prefs.WorkLocations.Add(WorkLocationType.Remote);
        if (WlHybrid.IsChecked == true) prefs.WorkLocations.Add(WorkLocationType.Hybrid);
        if (WlOnsite.IsChecked == true) prefs.WorkLocations.Add(WorkLocationType.OnSite);
        prefs.IncludeUnclearWorkLocation = IncludeUnclearWork.IsChecked == true;
        prefs.ExcludeStartDateRisk = ExcludeStartRisk.IsChecked == true;
        var loc = (LocationCombo.SelectedItem as string) ?? "Munich";
        prefs.Location = loc == "Custom" ? (CustomLocationBox.Text ?? "") : loc;
        _services.SavePreferences(prefs);
        return prefs;
    }

    private void WireSearch()
    {
        RunSearchButton.Click += async (_, _) => await RunSearch();
        GenerateDraftsButton.Click += async (_, _) => await GenerateDrafts();
    }

    private async Task RunSearch()
    {
        var prefs = ReadPreferences();
        SearchStatus.Text = "Searching…";
        ResultsList.Items.Clear();

        try
        {
            if (ModeUnsolicited.IsChecked == true)
            {
                var sources = new List<ICompanyResearchSource> { new MockCompanyResearchSource() };
                if (LlmConfigured())
                    sources.Add(new LlmCompanyResearchSource(_services.Llm, _services.LlmConfig, _services.Profile, new CompanyEmailFinder(_services.Http)));
                var research = new CompanyResearchService(sources);
                var companies = await research.ResearchAsync(new CompanyResearchRequest
                {
                    Industries = _services.Profile.Industries,
                    Geographies = new List<string> { prefs.Location },
                    AcceptedLanguages = prefs.AcceptedLanguages,
                });
                _lastCompanies = companies.ToList();
                _services.CompanyRepo.UpsertAll(_lastCompanies);
                foreach (var c in _lastCompanies) ResultsList.Items.Add(new CompanyRow { Company = c });
                ResultsHeader.Text = $"Companies ({_lastCompanies.Count})";
                SearchStatus.Text = $"{_lastCompanies.Count} companies. {_lastCompanies.Count(c => c.ContactStatus == ContactStatus.HasEmail)} with an official email.";
            }
            else
            {
                var request = new JobSearchRequest
                {
                    Keywords = KeywordsBox.Text ?? "",
                    Location = prefs.Location,
                    AcceptedLanguages = prefs.AcceptedLanguages,
                    Limit = 60,
                };
                JobSources.ApplyAdzunaKeys(request, _services.Credentials);
                request.GreenhouseCompanies = prefs.GreenhouseCompanies;
                request.LeverCompanies = prefs.LeverCompanies;

                var raw = await _services.JobSearch.SearchAsync(request);
                if (LlmConfigured()) await ClassifyLanguages(raw.Where(j => j.LanguageRequirements.Count == 0).Take(12).ToList());

                var processed = _services.Filters.Process(raw, prefs);
                _lastJobs = processed.ToList();
                _services.JobRepo.UpsertAll(_lastJobs);

                foreach (var j in _lastJobs) ResultsList.Items.Add(new JobRow { Job = j });
                var included = _lastJobs.Count(j => j.Included);
                ResultsHeader.Text = $"Jobs ({included} included / {_lastJobs.Count})";
                SearchStatus.Text = $"{included} included, {_lastJobs.Count - included} filtered. Tip: switch language mode to surface unclear/mismatch postings.";
            }
        }
        catch (Exception ex)
        {
            SearchStatus.Text = "Search error: " + ex.Message;
        }
    }

    private async Task ClassifyLanguages(List<JobPosting> jobs)
    {
        var classifier = _services.BuildLanguageClassifier();
        foreach (var job in jobs)
        {
            try { await classifier.ClassifyAsync(job); } catch { /* leave unclear */ }
        }
    }

    private async Task GenerateDrafts()
    {
        var profile = _services.Profile;
        var cv = string.IsNullOrEmpty(profile.CvDocumentId) ? null : _services.Profiles.CvDocument(profile.CvDocumentId);
        var generator = _services.BuildDraftGenerator();
        var selected = ResultsList.SelectedItems?.Cast<object>().ToList() ?? new List<object>();
        if (selected.Count == 0) { GenerateStatus.Text = "Select one or more results first."; return; }

        GenerateStatus.Text = $"Generating {selected.Count} draft(s)…";
        var made = 0;
        foreach (var row in selected)
        {
            try
            {
                DraftResult result;
                ApplicationDraft draft;
                if (row is JobRow jr)
                {
                    result = LlmConfigured() ? await Try(() => generator.ForJobAsync(profile, jr.Job, cv), () => DraftGenerator.OfflineForJob(profile, jr.Job, cv))
                                             : DraftGenerator.OfflineForJob(profile, jr.Job, cv);
                    draft = new ApplicationDraft { Kind = ApplicationKind.JobApplication, JobPostingId = jr.Job.Id, Company = jr.Job.Company, RoleTitle = jr.Job.Title };
                }
                else if (row is CompanyRow cr)
                {
                    if (cr.Company.ContactStatus != ContactStatus.HasEmail)
                    {
                        // No official email — draft prepared but not schedulable (per spec).
                    }
                    result = LlmConfigured() ? await Try(() => generator.ForCompanyAsync(profile, cr.Company, cv), () => DraftGenerator.OfflineForCompany(profile, cr.Company, cv))
                                             : DraftGenerator.OfflineForCompany(profile, cr.Company, cv);
                    draft = new ApplicationDraft { Kind = ApplicationKind.Unsolicited, CompanyTargetId = cr.Company.Id, Company = cr.Company.Name, RoleTitle = "Speculative application" };
                }
                else continue;

                draft.CoverLetterText = result.CoverLetter;
                _services.DraftRepo.Upsert(draft);
                var email = result.Email;
                email.ApplicationDraftId = draft.Id;
                _services.EmailRepo.Upsert(email);
                _services.Audit.Record("draft", "generated", $"{draft.Company} — {draft.RoleTitle}");
                made++;
            }
            catch (Exception ex)
            {
                _services.Audit.Record("draft", "error", "generation", outcome: ex.Message, severity: AuditSeverity.Warning);
            }
        }

        RefreshDrafts();
        GenerateStatus.Text = $"Created {made} draft(s). Review them on the Drafts & Approval tab.";
    }

    private static async Task<DraftResult> Try(Func<Task<DraftResult>> llm, Func<DraftResult> offline)
    {
        try { return await llm(); }
        catch { return offline(); }
    }

    // =================== DRAFTS & APPROVAL ===================

    private void WireDrafts()
    {
        DraftsList.SelectionChanged += (_, _) => ShowDraftDetail(DraftsList.SelectedItem as DraftRow);
        ApproveButton.Click += (_, _) => DraftAction(d => _services.Approval.Approve(d.Id), "Approved.");
        RejectButton.Click += (_, _) => DraftAction(d => _services.Approval.Reject(d.Id), "Rejected.");
        PauseButton.Click += (_, _) => DraftAction(d => _services.Approval.Pause(d.Id), "Paused.");
        SaveEditButton.Click += (_, _) => SaveDraftEdits();
        RegenerateButton.Click += async (_, _) => await RegenerateDraft();
        ExportPdfButton.Click += (_, _) => ExportCoverLetterPdf();
        ApproveAllButton.Click += (_, _) =>
        {
            var ids = _services.DraftRepo.All().Where(d => d.Status == DraftStatus.Draft).Select(d => d.Id).ToList();
            var n = _services.Approval.ApproveBatch(ids);
            RefreshDrafts();
            ApprovalStatus.Text = $"Approved {n} draft(s).";
        };
        ScheduleApprovedButton.Click += (_, _) =>
        {
            var queue = _services.BuildQueueService();
            var approved = _services.DraftRepo.All().Where(d => d.Status == DraftStatus.Approved).ToList();
            var scheduled = approved.Count(d => queue.Enqueue(d.Id) is not null);
            RefreshQueue();
            RefreshTracker();
            ApprovalStatus.Text = $"Scheduled {scheduled} of {approved.Count} approved draft(s). Manual-contact items are not scheduled.";
        };
    }

    private void RefreshDrafts()
    {
        DraftsList.Items.Clear();
        foreach (var draft in _services.DraftRepo.All())
        {
            var email = _services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == draft.Id);
            DraftsList.Items.Add(new DraftRow { Draft = draft, Email = email });
        }
    }

    private void ShowDraftDetail(DraftRow? row)
    {
        _selectedDraft = row;
        DraftDetail.IsVisible = row is not null;
        if (row is null) return;
        DetailHeader.Text = row.Header;
        DetailTo.Text = row.Email?.ToAddress ?? "";
        DetailSubject.Text = row.Email?.Subject ?? "";
        DetailBody.Text = row.Email?.Body ?? "";
        DetailCover.Text = row.Draft.CoverLetterText;
        var atts = row.Email?.AttachmentPaths ?? new List<string>();
        DetailAttachments.Text = atts.Count > 0 ? "Attachments: " + string.Join(", ", atts.Select(System.IO.Path.GetFileName)) : "No attachments.";
        DetailStatus.Text = $"Status: {row.Draft.Status}";
    }

    private void DraftAction(Action<ApplicationDraft> action, string message)
    {
        if (_selectedDraft is null) return;
        action(_selectedDraft.Draft);
        RefreshDrafts();
        RefreshTracker();
        DetailStatus.Text = message;
    }

    private void SaveDraftEdits()
    {
        if (_selectedDraft?.Email is not { } email) return;
        email.ToAddress = DetailTo.Text ?? "";
        email.Subject = DetailSubject.Text ?? "";
        email.Body = DetailBody.Text ?? "";
        _services.EmailRepo.Upsert(email);
        var draft = _selectedDraft.Draft;
        draft.CoverLetterText = DetailCover.Text ?? "";
        _services.DraftRepo.Upsert(draft);
        _services.Approval.MarkEdited(draft.Id); // resets to Draft → must re-approve
        RefreshDrafts();
        DetailStatus.Text = "Saved. Edited drafts must be re-approved before sending.";
    }

    private async Task RegenerateDraft()
    {
        if (_selectedDraft is null) return;
        var draft = _selectedDraft.Draft;
        var profile = _services.Profile;
        var cv = string.IsNullOrEmpty(profile.CvDocumentId) ? null : _services.Profiles.CvDocument(profile.CvDocumentId);
        var generator = _services.BuildDraftGenerator();

        DetailStatus.Text = "Regenerating…";
        DraftResult result;
        if (draft.Kind == ApplicationKind.JobApplication)
        {
            var job = _services.JobRepo.Get(draft.JobPostingId) ?? new JobPosting { Company = draft.Company, Title = draft.RoleTitle };
            result = LlmConfigured() ? await Try(() => generator.ForJobAsync(profile, job, cv), () => DraftGenerator.OfflineForJob(profile, job, cv))
                                     : DraftGenerator.OfflineForJob(profile, job, cv);
        }
        else
        {
            var company = _services.CompanyRepo.Get(draft.CompanyTargetId) ?? new CompanyTarget { Name = draft.Company };
            result = LlmConfigured() ? await Try(() => generator.ForCompanyAsync(profile, company, cv), () => DraftGenerator.OfflineForCompany(profile, company, cv))
                                     : DraftGenerator.OfflineForCompany(profile, company, cv);
        }

        draft.CoverLetterText = result.CoverLetter;
        _services.DraftRepo.Upsert(draft);
        var email = _services.EmailRepo.All().FirstOrDefault(e => e.ApplicationDraftId == draft.Id) ?? result.Email;
        email.ApplicationDraftId = draft.Id;
        email.Subject = result.Email.Subject;
        email.Body = result.Email.Body;
        email.ToAddress = string.IsNullOrEmpty(email.ToAddress) ? result.Email.ToAddress : email.ToAddress;
        email.AttachmentPaths = result.Email.AttachmentPaths;
        _services.EmailRepo.Upsert(email);
        _services.Approval.NoteRegenerated(draft.Id);
        RefreshDrafts();
        ShowDraftDetail(new DraftRow { Draft = draft, Email = email });
        DetailStatus.Text = "Regenerated. Re-approval required.";
    }

    private void ExportCoverLetterPdf()
    {
        if (_selectedDraft is null) return;
        try
        {
            var path = CoverLetterPdf.Render(DetailCover.Text ?? _selectedDraft.Draft.CoverLetterText,
                _services.Profile, _selectedDraft.Draft.Company, _selectedDraft.Draft.RoleTitle,
                Jobomate.Persistence.JobomatePaths.CoverLettersDir);
            var draft = _selectedDraft.Draft;
            draft.CoverLetterPdfPath = path;
            _services.DraftRepo.Upsert(draft);
            var email = _selectedDraft.Email;
            if (email is not null && !email.AttachmentPaths.Contains(path))
            {
                email.AttachmentPaths.Add(path);
                _services.EmailRepo.Upsert(email);
            }
            DetailStatus.Text = "Cover letter PDF saved: " + System.IO.Path.GetFileName(path);
        }
        catch (Exception ex)
        {
            DetailStatus.Text = "PDF error: " + ex.Message;
        }
    }

    // =================== QUEUE & TRACKER ===================

    private SendRunner Runner => _runner ??= _services.BuildSendRunner();

    private void WireQueue()
    {
        SendDueButton.Click += async (_, _) => await SendDue();
        PauseQueueButton.Click += (_, _) => { Runner.Pause(); QueueStatus.Text = $"Queue: {Runner.State}"; };
        ResumeQueueButton.Click += (_, _) => { Runner.Resume(); QueueStatus.Text = $"Queue: {Runner.State}"; };
        CancelQueueButton.Click += (_, _) => { Runner.Cancel(); QueueStatus.Text = $"Queue: {Runner.State}"; };
        RefreshTrackerButton.Click += (_, _) => { RefreshTracker(); RefreshQueue(); };
    }

    private async Task SendDue()
    {
        QueueStatus.Text = "Sending due items…";
        var sent = await Runner.RunDueAsync();
        RefreshQueue();
        RefreshTracker();
        RefreshAudit();
        QueueStatus.Text = $"Sent {sent}. Queue: {Runner.State}. {(_services.BuildEmailSender().IsDryRun ? "(dry-run — recorded, not sent)" : "")} {Runner.LastMessage}";
    }

    private void RefreshQueue()
    {
        QueueList.Items.Clear();
        foreach (var item in _services.QueueRepo.All().OrderBy(i => i.ScheduledAt))
        {
            var draft = _services.DraftRepo.Get(item.ApplicationDraftId);
            QueueList.Items.Add(new QueueRow { Item = item, Company = draft?.Company ?? "" });
        }
    }

    private void RefreshTracker()
    {
        TrackerList.Items.Clear();
        foreach (var record in _services.RecordRepo.All())
            TrackerList.Items.Add(new TrackerRow { Record = record });
    }

    // =================== SETTINGS ===================

    private void PopulateSettingsTab()
    {
        ConnHost.Bind(_services);

        var ec = _services.EmailConfig;
        SEmailDry.IsChecked = ec.Provider == EmailProviderKind.DryRun;
        SEmailSmtp.IsChecked = ec.Provider == EmailProviderKind.Smtp;
        SEmailGmail.IsChecked = ec.Provider == EmailProviderKind.GmailOAuth;
        SEmailMs.IsChecked = ec.Provider == EmailProviderKind.MicrosoftGraph;
        SFromBox.Text = ec.FromAddress;
        SFromNameBox.Text = ec.FromName;
        SHostBox.Text = ec.SmtpHost;
        SPortBox.Text = ec.SmtpPort.ToString();
        SUserBox.Text = ec.SmtpUsername;
        SOAuthFromBox.Text = ec.FromAddress;
        SOAuthClientBox.Text = ec.OAuthClientId;
        SyncSettingsEmailPanels();
    }

    private void WireSettings()
    {
        SEmailDry.IsCheckedChanged += (_, _) => SyncSettingsEmailPanels();
        SEmailSmtp.IsCheckedChanged += (_, _) => SyncSettingsEmailPanels();
        SEmailGmail.IsCheckedChanged += (_, _) => SyncSettingsEmailPanels();
        SEmailMs.IsCheckedChanged += (_, _) => SyncSettingsEmailPanels();
        SSaveEmailButton.Click += async (_, _) => await SaveAndTestEmail();
        SOAuthSignInButton.Click += async (_, _) => await SettingsOAuthSignIn();
    }

    private void SyncSettingsEmailPanels()
    {
        SSmtpPanel.IsVisible = SEmailSmtp.IsChecked == true;
        SOAuthPanel.IsVisible = SEmailGmail.IsChecked == true || SEmailMs.IsChecked == true;
    }

    private async Task SaveAndTestEmail()
    {
        var cfg = _services.EmailConfig;
        if (SEmailDry.IsChecked == true) { cfg.Provider = EmailProviderKind.DryRun; cfg.Tested = false; _services.SaveEmailConfig(cfg); SEmailStatus.Text = "Dry-run set."; return; }
        if (SEmailSmtp.IsChecked == true)
        {
            cfg.Provider = EmailProviderKind.Smtp;
            cfg.FromAddress = SFromBox.Text ?? ""; cfg.FromName = SFromNameBox.Text ?? "";
            cfg.SmtpHost = SHostBox.Text ?? ""; cfg.SmtpPort = int.TryParse(SPortBox.Text, out var p) ? p : 587;
            cfg.SmtpUsername = SUserBox.Text ?? "";
            if (!string.IsNullOrWhiteSpace(SPassBox.Text)) _services.Credentials.StoreCloudToken(cfg.SmtpPasswordRef, SPassBox.Text!);
        }
        else
        {
            cfg.Provider = SEmailGmail.IsChecked == true ? EmailProviderKind.GmailOAuth : EmailProviderKind.MicrosoftGraph;
            cfg.FromAddress = SOAuthFromBox.Text ?? ""; cfg.OAuthClientId = SOAuthClientBox.Text ?? "";
        }
        _services.SaveEmailConfig(cfg);

        SEmailStatus.Text = "Testing…";
        try
        {
            var result = await _services.BuildEmailSenderForTest().TestAsync();
            if (result.Ok) { cfg.Tested = true; cfg.TestedAt = DateTimeOffset.UtcNow; _services.SaveEmailConfig(cfg); }
            SEmailStatus.Text = result.Ok ? $"✓ {result.Message}" : $"✗ {result.Message}";
        }
        catch (Exception ex) { SEmailStatus.Text = "✗ " + ex.Message; }
    }

    private async Task SettingsOAuthSignIn()
    {
        var cfg = _services.EmailConfig;
        cfg.Provider = SEmailGmail.IsChecked == true ? EmailProviderKind.GmailOAuth : EmailProviderKind.MicrosoftGraph;
        cfg.FromAddress = SOAuthFromBox.Text ?? ""; cfg.OAuthClientId = SOAuthClientBox.Text ?? "";
        _services.SaveEmailConfig(cfg);
        SEmailStatus.Text = "Opening browser…";
        try
        {
            if (cfg.Provider == EmailProviderKind.GmailOAuth)
                await _services.GmailTokenManager().SignInAsync(OAuthEndpointsCatalog.GmailScopes);
            else
                await _services.MicrosoftTokenManager().SignInAsync(OAuthEndpointsCatalog.GraphScopes);
            SEmailStatus.Text = "Signed in. Click Save & test.";
        }
        catch (Exception ex) { SEmailStatus.Text = "✗ " + ex.Message; }
    }

    // =================== AUDIT ===================

    private void WireAudit() => RefreshAuditButton.Click += (_, _) => RefreshAudit();

    private void RefreshAudit()
    {
        AuditList.Items.Clear();
        foreach (var e in _services.Audit.Recent(300)) AuditList.Items.Add(new AuditRow { Event = e });
    }

    // =================== BROWSER (extension) ===================

    private DispatcherTimer? _extTimer;

    private void PopulateBrowserTab()
    {
        ExtPath.Text = ExtensionInstaller.IsInstalledOnDisk()
            ? "Installed at: " + ExtensionInstaller.ExtensionDir
            : "Not yet written to disk — click Install.";
        RefreshExtStatus();
    }

    private void WireBrowser()
    {
        InstallExtButton.Click += (_, _) =>
        {
            var (ok, message, path) = ExtensionInstaller.Install();
            ExtPath.Text = "Folder to load in Chrome: " + path;
            ExtResearchStatus.Text = message;
            _services.Audit.Record("extension", ok ? "install-initiated" : "install-failed", path, outcome: ok ? "" : message);
        };
        ResumeExtButton.Click += async (_, _) => { await _services.Extension.ResumeAsync(); RefreshExtStatus(); };
        ExtResearchButton.Click += async (_, _) => await ResearchViaExtension();
        ExtPullButton.Click += (_, _) =>
        {
            var jobs = _services.Extension.DrainPushed();
            _services.JobRepo.UpsertAll(jobs);
            ExtResearchStatus.Text = $"Pulled {jobs.Count} job(s) from the extension. Open Search & Results.";
        };

        _extTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) };
        _extTimer.Tick += (_, _) => RefreshExtStatus();
        AttachedToVisualTree += (_, _) => _extTimer.Start();
        DetachedFromVisualTree += (_, _) => _extTimer.Stop();
    }

    private void RefreshExtStatus()
    {
        var ext = _services.Extension;
        ExtStatus.Text = ext.IsConnected
            ? (ext.NeedsUserReason is { Length: > 0 } reason
                ? "⏸ Action needed — " + reason + "  (handle it in Chrome, then click Resume)"
                : "● Connected — Jobomate can research jobs in your browser.")
            : "○ Not connected. Install the extension (or open Chrome with it enabled).";
        ResumeExtButton.IsVisible = ext.NeedsUserReason is { Length: > 0 };
    }

    private async Task ResearchViaExtension()
    {
        var urls = (ExtUrlsBox.Text ?? "")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(u => u.StartsWith("http", StringComparison.OrdinalIgnoreCase)).ToList();
        if (urls.Count == 0) { ExtResearchStatus.Text = "Enter one or more http(s) URLs."; return; }
        if (!_services.Extension.IsConnected) { ExtResearchStatus.Text = "Extension not connected. Install it first."; return; }

        ExtResearchStatus.Text = $"Researching {urls.Count} URL(s) in your browser… (it'll pause for any login/CAPTCHA)";
        var jobs = await _services.Extension.CollectAsync(urls);
        _services.JobRepo.UpsertAll(jobs);
        ExtResearchStatus.Text = $"Collected {jobs.Count} job(s). Open Search & Results to review.";
    }

    // =================== ADVANCED (total control) ===================

    private void PopulateAdvancedTab()
    {
        var rl = _services.RateLimit;
        MaxPerDayBox.Text = rl.MaxPerDay.ToString();
        MinGapBox.Text = ((int)rl.MinGap.TotalMinutes).ToString();
        MaxFailBox.Text = rl.MaxConsecutiveFailures.ToString();
        JitterMinBox.Text = ((int)rl.JitterMin.TotalMinutes).ToString();
        JitterMaxBox.Text = ((int)rl.JitterMax.TotalMinutes).ToString();
        QuietStartBox.Text = rl.QuietStartHour.ToString();
        QuietEndBox.Text = rl.QuietEndHour.ToString();

        AdzunaIdBox.Text = _services.Credentials.GetCloudToken("adzuna_app_id") ?? "";
        AdzunaKeyBox.Text = _services.Credentials.GetCloudToken("adzuna_app_key") ?? "";
        GreenhouseBox.Text = string.Join(", ", _services.Preferences.GreenhouseCompanies);
        LeverBox.Text = string.Join(", ", _services.Preferences.LeverCompanies);
        DataDirLabel.Text = "Data folder: " + Jobomate.Persistence.JobomatePaths.DataDir;
    }

    private void WireAdvanced()
    {
        SaveLimitsButton.Click += (_, _) =>
        {
            var rl = _services.RateLimit;
            if (int.TryParse(MaxPerDayBox.Text, out var mpd)) rl.MaxPerDay = Math.Max(1, mpd);
            if (int.TryParse(MinGapBox.Text, out var mg)) rl.MinGap = TimeSpan.FromMinutes(Math.Max(1, mg));
            if (int.TryParse(MaxFailBox.Text, out var mf)) rl.MaxConsecutiveFailures = Math.Max(1, mf);
            if (int.TryParse(JitterMinBox.Text, out var jmin)) rl.JitterMin = TimeSpan.FromMinutes(Math.Max(0, jmin));
            if (int.TryParse(JitterMaxBox.Text, out var jmax)) rl.JitterMax = TimeSpan.FromMinutes(Math.Max(0, jmax));
            if (int.TryParse(QuietStartBox.Text, out var qs)) rl.QuietStartHour = Math.Clamp(qs, 0, 23);
            if (int.TryParse(QuietEndBox.Text, out var qe)) rl.QuietEndHour = Math.Clamp(qe, 0, 23);
            AdvancedStatus.Text = "Sending limits updated.";
        };
        SaveSourcesButton.Click += (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(AdzunaIdBox.Text)) _services.Credentials.StoreCloudToken("adzuna_app_id", AdzunaIdBox.Text!);
            if (!string.IsNullOrWhiteSpace(AdzunaKeyBox.Text)) _services.Credentials.StoreCloudToken("adzuna_app_key", AdzunaKeyBox.Text!);
            var prefs = _services.Preferences;
            prefs.GreenhouseCompanies = SplitCsv(GreenhouseBox.Text);
            prefs.LeverCompanies = SplitCsv(LeverBox.Text);
            _services.SavePreferences(prefs);
            AdvancedStatus.Text = "Sources saved.";
        };
        OpenDataButton.Click += (_, _) => OpenFolder(Jobomate.Persistence.JobomatePaths.DataDir);
        OpenAuditButton.Click += (_, _) => OpenFolder(Jobomate.Persistence.JobomatePaths.AuditDir);
        ResetOnboardingButton.Click += (_, _) => { _services.ResetOnboarding(); AdvancedStatus.Text = "Onboarding reset — it will show on next launch."; };
        ClearDataButton.Click += (_, _) =>
        {
            _services.ClearApplicationData();
            RefreshDrafts(); RefreshQueue(); RefreshTracker();
            AdvancedStatus.Text = "Cleared all jobs, drafts, queue, and tracker.";
        };
    }

    private static List<string> SplitCsv(string? s) =>
        (s ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    private static void OpenFolder(string dir)
    {
        try
        {
            System.IO.Directory.CreateDirectory(dir);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("open") { ArgumentList = { dir }, UseShellExecute = false });
        }
        catch { }
    }

    // =================== helpers ===================

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
}
