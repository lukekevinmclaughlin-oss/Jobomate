using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Platform.Storage;
using Jobomate.Contracts;
using Jobomate.Email;
using Jobomate.Llm;
using Jobomate.Llm.Local;

namespace Jobomate.Views;

public partial class OnboardingView : UserControl
{
    private static readonly AppApiProvider[] CloudProviders =
    {
        AppApiProvider.OpenAI, AppApiProvider.Anthropic, AppApiProvider.GoogleAI, AppApiProvider.OpenRouter,
        AppApiProvider.Mistral, AppApiProvider.Groq, AppApiProvider.DeepSeek, AppApiProvider.Together,
        AppApiProvider.XAI, AppApiProvider.Custom,
    };

    private static readonly (string Title, string Subtitle)[] Steps =
    {
        ("Load your CV", "Step 1 of 6 — ground every application in real facts."),
        ("Confirm your profile", "Step 2 of 6 — edit anything; it stays truthful."),
        ("Availability", "Step 3 of 6 — flexible by default."),
        ("Connect an LLM", "Step 4 of 6 — it works quietly in the background."),
        ("Connect your email", "Step 5 of 6 — dry-run by default, nothing sends yet."),
        ("Choose a mode", "Step 6 of 6 — how you'd like to start."),
    };

    private JobomateServices _services = null!;
    private Action _onDone = () => { };
    private int _step;
    private string _ggufPath = "";

    public OnboardingView() => InitializeComponent();

    public void Bind(JobomateServices services, Action onDone)
    {
        _services = services;
        _onDone = onDone;

        foreach (var p in CloudProviders) ProviderCombo.Items.Add(Contracts.Providers.DisplayName(p));
        ProviderCombo.SelectedIndex = 0;

        PopulateProfileFields();

        NextButton.Click += (_, _) => Next();
        BackButton.Click += (_, _) => Show(_step - 1);
        UseDefaultCvButton.Click += async (_, _) => await LoadDefaultCv();
        BrowseCvButton.Click += async (_, _) => await BrowseCv();
        DetectButton.Click += async (_, _) => await DetectLocal();
        BrowseGgufButton.Click += async (_, _) => await BrowseGguf();
        TestLlmButton.Click += async (_, _) => await TestLlm();
        TestEmailButton.Click += async (_, _) => await TestEmail();
        OAuthSignInButton.Click += async (_, _) => await OAuthSignIn();

        LlmCloud.IsCheckedChanged += (_, _) => SyncLlmPanels();
        LlmLocalServer.IsCheckedChanged += (_, _) => SyncLlmPanels();
        LlmGguf.IsCheckedChanged += (_, _) => SyncLlmPanels();
        LlmSkip.IsCheckedChanged += (_, _) => SyncLlmPanels();
        EmailDryRun.IsCheckedChanged += (_, _) => SyncEmailPanels();
        EmailSmtp.IsCheckedChanged += (_, _) => SyncEmailPanels();
        EmailGmail.IsCheckedChanged += (_, _) => SyncEmailPanels();
        EmailMicrosoft.IsCheckedChanged += (_, _) => SyncEmailPanels();

        if (System.IO.File.Exists("/Users/lukemclaughlin/Documents/Career/2026/Luke_McLaughlin_CV_2026.pdf"))
            CvStatus.Text = "A default CV was found. Click “Use default CV” to load it.";

        Show(0);
    }

    private void Show(int step)
    {
        _step = Math.Clamp(step, 0, Steps.Length - 1);
        var panels = new Control[] { Step0, Step1, Step2, Step3, Step4, Step5 };
        for (var i = 0; i < panels.Length; i++) panels[i].IsVisible = i == _step;

        StepTitle.Text = Steps[_step].Title;
        StepSubtitle.Text = Steps[_step].Subtitle;
        StepCounter.Text = $"Step {_step + 1} / {Steps.Length}";
        BackButton.IsVisible = _step > 0;
        NextButton.Content = _step == Steps.Length - 1 ? "Finish setup" : "Next";
        FooterNote.Text = _step switch
        {
            3 => "Tip: you can pick “Skip for now” and configure the LLM later in Settings.",
            4 => "Dry-run means drafts are recorded but never sent.",
            _ => "",
        };
    }

    private void Next()
    {
        SaveStep(_step);
        if (_step < Steps.Length - 1) Show(_step + 1);
        else Finish();
    }

    private void SaveStep(int step)
    {
        if (step == 1)
        {
            var p = _services.Profile;
            p.FullName = ProfileName.Text ?? p.FullName;
            p.Headline = ProfileHeadline.Text ?? p.Headline;
            p.Location = ProfileLocation.Text ?? p.Location;
            p.Email = ProfileEmail.Text ?? p.Email;
            p.Summary = ProfileSummary.Text ?? p.Summary;
            _services.SaveProfile(p);
        }
        else if (step == 3) SaveLlmConfig();
        else if (step == 4) SaveEmailConfigFromUi(markTested: false);
    }

    private void Finish()
    {
        var mode = ModeUnsolicited.IsChecked == true ? SearchMode.Unsolicited : SearchMode.RecentJobs;
        var prefs = _services.Preferences;
        _services.SavePreferences(prefs);
        _services.Audit.Record("onboarding", "completed", mode.ToString());
        _onDone();
    }

    // ----- CV -----

    private void PopulateProfileFields()
    {
        var p = _services.Profile;
        ProfileName.Text = p.FullName;
        ProfileHeadline.Text = p.Headline;
        ProfileLocation.Text = p.Location;
        ProfileEmail.Text = p.Email;
        ProfileSummary.Text = p.Summary;
    }

    private async Task LoadDefaultCv()
    {
        const string path = "/Users/lukemclaughlin/Documents/Career/2026/Luke_McLaughlin_CV_2026.pdf";
        if (!System.IO.File.Exists(path)) { CvStatus.Text = "Default CV not found. Use Browse to pick one."; return; }
        await LoadCv(path);
    }

    private async Task BrowseCv()
    {
        var top = TopLevel.GetTopLevel(this);
        if (top is null) return;
        var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            AllowMultiple = false,
            FileTypeFilter = new[] { new FilePickerFileType("CV") { Patterns = new[] { "*.pdf", "*.txt", "*.md" } } },
        });
        var file = files.FirstOrDefault();
        if (file is not null) await LoadCv(file.Path.LocalPath);
    }

    private async Task LoadCv(string path)
    {
        CvStatus.Text = "Reading CV…";
        try
        {
            var profile = await _services.Profiles.BuildFromCvAsync(path, llm: null, cfg: null);
            _services.SaveProfile(profile);
            PopulateProfileFields();
            CvStatus.Text = profile.FromFallback
                ? $"Loaded {System.IO.Path.GetFileName(path)}. Parsed little text — using the known background as a safe fallback."
                : $"Loaded {System.IO.Path.GetFileName(path)} and built your profile. Review it on the next step.";
        }
        catch (Exception ex)
        {
            CvStatus.Text = "Could not read that file: " + ex.Message;
        }
    }

    // ----- LLM -----

    private void SyncLlmPanels()
    {
        CloudPanel.IsVisible = LlmCloud.IsChecked == true;
        LocalServerPanel.IsVisible = LlmLocalServer.IsChecked == true;
        GgufPanel.IsVisible = LlmGguf.IsChecked == true;
    }

    private void SaveLlmConfig()
    {
        if (LlmSkip.IsChecked == true) return;
        var cfg = _services.LlmConfig;
        if (LlmCloud.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.ApiKey;
            cfg.ApiProvider = CloudProviders[Math.Max(0, ProviderCombo.SelectedIndex)];
            cfg.Model = ModelBox.Text ?? "";
            if (!string.IsNullOrWhiteSpace(ApiKeyBox.Text))
                _services.Credentials.StoreApiKey(LlmClient.ApiKeyName(cfg.ApiProvider), ApiKeyBox.Text!);
        }
        else if (LlmLocalServer.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.LocalServer;
            cfg.LocalServerUrl = LocalServerUrlBox.Text ?? "";
            cfg.LocalModelName = LocalModelBox.Text ?? "";
        }
        else if (LlmGguf.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.LocalAI;
            cfg.LocalAIModelPath = _ggufPath;
            cfg.LocalAIModelName = LocalLlmRuntime.SuggestModelName(_ggufPath);
            cfg.LocalAIContextSize = int.TryParse(ContextSizeBox.Text, out var c) ? c : 4096;
        }
        _services.SaveLlmConfig(cfg);
    }

    private async Task DetectLocal()
    {
        LlmTestStatus.Text = "Scanning 127.0.0.1…";
        var status = await _services.LocalRuntime.DetectAsync();
        if (status.OllamaReachable) { LocalServerUrlBox.Text = LocalLlmRuntime.OllamaChat; }
        else if (status.LmStudioReachable) { LocalServerUrlBox.Text = LocalLlmRuntime.LmStudioChat; }
        if (status.Models.Count > 0) LocalModelBox.Text = status.Models[0].Id;
        LlmTestStatus.Text =
            $"Ollama: {(status.OllamaReachable ? "up" : "—")}, LM Studio: {(status.LmStudioReachable ? "up" : "—")}, " +
            $"models: {status.Models.Count}, local GGUF files: {status.GgufFiles.Count}.";
    }

    private async Task BrowseGguf()
    {
        var top = TopLevel.GetTopLevel(this);
        if (top is null) return;
        var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            AllowMultiple = false,
            FileTypeFilter = new[] { new FilePickerFileType("GGUF model") { Patterns = new[] { "*.gguf" } } },
        });
        var file = files.FirstOrDefault();
        if (file is null) return;
        _ggufPath = file.Path.LocalPath;
        GgufPathLabel.Text = System.IO.Path.GetFileName(_ggufPath);
    }

    private async Task TestLlm()
    {
        if (LlmSkip.IsChecked == true) { LlmTestStatus.Text = "Skipped — configure later in Settings."; return; }
        SaveLlmConfig();
        LlmTestStatus.Text = "Testing…";
        var result = await _services.Llm.TestConnectionAsync(_services.LlmConfig);
        LlmTestStatus.Text = result.Ok ? $"✓ {result.Message} {result.Sample}" : $"✗ {result.Message}";
    }

    // ----- Email -----

    private void SyncEmailPanels()
    {
        SmtpPanel.IsVisible = EmailSmtp.IsChecked == true;
        OAuthPanel.IsVisible = EmailGmail.IsChecked == true || EmailMicrosoft.IsChecked == true;
    }

    private void SaveEmailConfigFromUi(bool markTested)
    {
        var cfg = _services.EmailConfig;
        if (EmailDryRun.IsChecked == true) cfg.Provider = EmailProviderKind.DryRun;
        else if (EmailSmtp.IsChecked == true)
        {
            cfg.Provider = EmailProviderKind.Smtp;
            cfg.FromAddress = FromAddressBox.Text ?? "";
            cfg.FromName = FromNameBox.Text ?? "";
            cfg.SmtpHost = SmtpHostBox.Text ?? "";
            cfg.SmtpPort = int.TryParse(SmtpPortBox.Text, out var port) ? port : 587;
            cfg.SmtpUsername = SmtpUserBox.Text ?? "";
            if (!string.IsNullOrWhiteSpace(SmtpPassBox.Text))
                _services.Credentials.StoreCloudToken(cfg.SmtpPasswordRef, SmtpPassBox.Text!);
        }
        else
        {
            cfg.Provider = EmailGmail.IsChecked == true ? EmailProviderKind.GmailOAuth : EmailProviderKind.MicrosoftGraph;
            cfg.FromAddress = OAuthFromBox.Text ?? "";
            cfg.OAuthClientId = OAuthClientIdBox.Text ?? "";
        }
        if (markTested) { cfg.Tested = true; cfg.TestedAt = DateTimeOffset.UtcNow; }
        _services.SaveEmailConfig(cfg);
    }

    private async Task TestEmail()
    {
        if (EmailDryRun.IsChecked == true)
        {
            SaveEmailConfigFromUi(markTested: false);
            EmailTestStatus.Text = "Dry-run is ready. Nothing will be sent until you connect a real account.";
            return;
        }

        SaveEmailConfigFromUi(markTested: false);
        EmailTestStatus.Text = "Testing…";
        try
        {
            var sender = _services.BuildEmailSenderForTest();
            var result = await sender.TestAsync();
            if (result.Ok) SaveEmailConfigFromUi(markTested: true);
            EmailTestStatus.Text = result.Ok ? $"✓ {result.Message}" : $"✗ {result.Message}";
        }
        catch (Exception ex)
        {
            EmailTestStatus.Text = "✗ " + ex.Message;
        }
    }

    private async Task OAuthSignIn()
    {
        SaveEmailConfigFromUi(markTested: false);
        EmailTestStatus.Text = "Opening browser for sign-in…";
        try
        {
            if (EmailGmail.IsChecked == true)
                await _services.GmailTokenManager().SignInAsync(OAuthEndpointsCatalog.GmailScopes);
            else
                await _services.MicrosoftTokenManager().SignInAsync(OAuthEndpointsCatalog.GraphScopes);
            EmailTestStatus.Text = "Signed in. Now click “Test account”.";
        }
        catch (Exception ex)
        {
            EmailTestStatus.Text = "✗ " + ex.Message;
        }
    }
}
