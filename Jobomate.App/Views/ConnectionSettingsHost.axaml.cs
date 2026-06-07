using System;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Platform.Storage;
using Jobomate.Contracts;
using Jobomate.Llm;
using Jobomate.Llm.Local;

namespace Jobomate.Views;

public partial class ConnectionSettingsHost : UserControl
{
    private static readonly AppApiProvider[] AllProviders = Enum.GetValues<AppApiProvider>();
    private static readonly AppOAuthProviderType[] OAuthProviders = Enum.GetValues<AppOAuthProviderType>();
    private static readonly string[] Efforts = { "Low", "Medium", "High" };

    private JobomateServices _services = null!;
    private string _ggufPath = "";

    public ConnectionSettingsHost() => InitializeComponent();

    public void Bind(JobomateServices services)
    {
        _services = services;

        foreach (var p in AllProviders) ProviderCombo.Items.Add(Contracts.Providers.DisplayName(p));
        foreach (var e in Efforts) EffortCombo.Items.Add(e);
        foreach (var o in OAuthProviders) OAuthProviderCombo.Items.Add(o.ToString());

        Populate();

        foreach (var rb in new[] { TypeCloud, TypeLocal, TypeGguf, TypeCli, TypeTerminal, TypeOAuth })
            rb.IsCheckedChanged += (_, _) => SyncPanels();

        DetectButton.Click += async (_, _) => await Detect();
        BrowseGgufButton.Click += async (_, _) => await BrowseGguf();
        OAuthSignInButton.Click += async (_, _) => await OAuthSignIn();
        SaveTestButton.Click += async (_, _) => await SaveAndTest();
        ConnectButton.Click += (_, _) => Connect();
        DisconnectButton.Click += (_, _) => Disconnect();
    }

    private void Connect()
    {
        var cfg = BuildConfig();
        cfg.Connected = true;
        _services.SaveLlmConfig(cfg);
        StatusText.Text = $"● Connected · {cfg.ResolvedModel()}. Tip: use “Save & test” to verify it actually responds.";
    }

    private void Disconnect()
    {
        var cfg = _services.LlmConfig;
        cfg.Connected = false;
        _services.SaveLlmConfig(cfg);
        StatusText.Text = "○ Disconnected. The assistant falls back to local guidance until you connect again.";
    }

    private void Populate()
    {
        var cfg = _services.LlmConfig;
        TypeCloud.IsChecked = cfg.ConnectionType == AppConnectionType.ApiKey;
        TypeLocal.IsChecked = cfg.ConnectionType == AppConnectionType.LocalServer;
        TypeGguf.IsChecked = cfg.ConnectionType == AppConnectionType.LocalAI;
        TypeCli.IsChecked = cfg.ConnectionType == AppConnectionType.CliPipe;
        TypeTerminal.IsChecked = cfg.ConnectionType == AppConnectionType.Terminal;
        TypeOAuth.IsChecked = cfg.ConnectionType == AppConnectionType.OAuth;

        ProviderCombo.SelectedIndex = Math.Max(0, Array.IndexOf(AllProviders, cfg.ApiProvider));
        ModelBox.Text = cfg.Model;
        EffortCombo.SelectedIndex = Math.Max(0, Array.FindIndex(Efforts, e => e.Equals(cfg.ReasoningEffort, StringComparison.OrdinalIgnoreCase)));
        FastModeBox.IsChecked = cfg.FastMode;
        CustomEndpointBox.Text = cfg.CustomEndpoint;

        LocalUrlBox.Text = cfg.LocalServerUrl;
        LocalModelBox.Text = cfg.LocalModelName;

        _ggufPath = cfg.LocalAIModelPath;
        if (!string.IsNullOrEmpty(_ggufPath)) GgufLabel.Text = System.IO.Path.GetFileName(_ggufPath);
        ContextBox.Text = cfg.LocalAIContextSize.ToString();

        CliCommandBox.Text = cfg.CliCommand;
        CliTimeoutBox.Text = cfg.CliTimeout.ToString();
        TerminalCommandBox.Text = cfg.TerminalCommand;
        TerminalTimeoutBox.Text = cfg.CliTimeout.ToString();

        OAuthProviderCombo.SelectedIndex = Math.Max(0, Array.IndexOf(OAuthProviders, cfg.OAuthProvider));
        OAuthClientIdBox.Text = cfg.OAuthClientId;
        OAuthEndpointBox.Text = cfg.CustomEndpoint;
        OAuthModelBox.Text = cfg.Model;
        OAuthAuthUrlBox.Text = cfg.OAuthAuthUrl;
        OAuthTokenUrlBox.Text = cfg.OAuthTokenUrl;
        OAuthScopeBox.Text = cfg.OAuthScope;

        SyncPanels();
    }

    private void SyncPanels()
    {
        CloudPanel.IsVisible = TypeCloud.IsChecked == true;
        LocalPanel.IsVisible = TypeLocal.IsChecked == true;
        GgufPanel.IsVisible = TypeGguf.IsChecked == true;
        CliPanel.IsVisible = TypeCli.IsChecked == true;
        TerminalPanel.IsVisible = TypeTerminal.IsChecked == true;
        OAuthPanel.IsVisible = TypeOAuth.IsChecked == true;
    }

    private LlmConnectionConfig BuildConfig()
    {
        var cfg = _services.LlmConfig;
        if (TypeCloud.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.ApiKey;
            cfg.ApiProvider = AllProviders[Math.Max(0, ProviderCombo.SelectedIndex)];
            cfg.Model = ModelBox.Text ?? "";
            cfg.ReasoningEffort = Efforts[Math.Max(0, EffortCombo.SelectedIndex)];
            cfg.FastMode = FastModeBox.IsChecked == true;
            cfg.CustomEndpoint = CustomEndpointBox.Text ?? "";
            if (!string.IsNullOrWhiteSpace(ApiKeyBox.Text))
                _services.Credentials.StoreApiKey(LlmClient.ApiKeyName(cfg.ApiProvider), ApiKeyBox.Text!);
        }
        else if (TypeLocal.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.LocalServer;
            cfg.LocalServerUrl = LocalUrlBox.Text ?? "";
            cfg.LocalModelName = LocalModelBox.Text ?? "";
        }
        else if (TypeGguf.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.LocalAI;
            cfg.LocalAIModelPath = _ggufPath;
            cfg.LocalAIModelName = LocalLlmRuntime.SuggestModelName(_ggufPath);
            cfg.LocalAIContextSize = int.TryParse(ContextBox.Text, out var c) ? c : 4096;
        }
        else if (TypeCli.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.CliPipe;
            cfg.CliCommand = CliCommandBox.Text ?? "";
            cfg.CliTimeout = int.TryParse(CliTimeoutBox.Text, out var t) ? t : 120;
        }
        else if (TypeTerminal.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.Terminal;
            cfg.TerminalCommand = TerminalCommandBox.Text ?? "";
            cfg.CliTimeout = int.TryParse(TerminalTimeoutBox.Text, out var t) ? t : 120;
        }
        else if (TypeOAuth.IsChecked == true)
        {
            cfg.ConnectionType = AppConnectionType.OAuth;
            cfg.OAuthProvider = OAuthProviders[Math.Max(0, OAuthProviderCombo.SelectedIndex)];
            cfg.OAuthClientId = OAuthClientIdBox.Text ?? "";
            cfg.CustomEndpoint = OAuthEndpointBox.Text ?? "";
            cfg.Model = OAuthModelBox.Text ?? "";
            cfg.OAuthAuthUrl = OAuthAuthUrlBox.Text ?? "";
            cfg.OAuthTokenUrl = OAuthTokenUrlBox.Text ?? "";
            cfg.OAuthScope = OAuthScopeBox.Text ?? "";
            if (!string.IsNullOrWhiteSpace(OAuthSecretBox.Text))
                _services.Credentials.StoreCloudToken(cfg.OAuthClientSecretRef, OAuthSecretBox.Text!);
        }
        _services.SaveLlmConfig(cfg);
        return cfg;
    }

    private async Task SaveAndTest()
    {
        var cfg = BuildConfig();
        StatusText.Text = "Testing…";
        var result = await _services.Llm.TestConnectionAsync(cfg);
        if (result.Ok) { cfg.Connected = true; _services.SaveLlmConfig(cfg); }
        StatusText.Text = result.Ok ? $"● Connected · {result.Message} {result.Sample}" : $"✗ {result.Message}";
    }

    private async Task Detect()
    {
        StatusText.Text = "Scanning 127.0.0.1…";
        var status = await _services.LocalRuntime.DetectAsync();
        if (status.OllamaReachable) LocalUrlBox.Text = LocalLlmRuntime.OllamaChat;
        else if (status.LmStudioReachable) LocalUrlBox.Text = LocalLlmRuntime.LmStudioChat;
        if (status.Models.Count > 0) LocalModelBox.Text = status.Models[0].Id;
        StatusText.Text = $"Ollama {(status.OllamaReachable ? "up" : "—")} · LM Studio {(status.LmStudioReachable ? "up" : "—")} · models {status.Models.Count} · GGUF {status.GgufFiles.Count}";
    }

    private async Task BrowseGguf()
    {
        var top = TopLevel.GetTopLevel(this);
        if (top is null) return;
        var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            AllowMultiple = false,
            FileTypeFilter = new[] { new FilePickerFileType("GGUF") { Patterns = new[] { "*.gguf" } } },
        });
        if (files.FirstOrDefault() is { } f) { _ggufPath = f.Path.LocalPath; GgufLabel.Text = System.IO.Path.GetFileName(_ggufPath); }
    }

    private async Task OAuthSignIn()
    {
        var cfg = BuildConfig();
        StatusText.Text = "Opening browser for OAuth sign-in…";
        try
        {
            await _services.Llm.SignInOAuthAsync(cfg);
            StatusText.Text = "Signed in. Now click Save & test.";
        }
        catch (Exception ex)
        {
            StatusText.Text = "✗ " + ex.Message;
        }
    }
}
