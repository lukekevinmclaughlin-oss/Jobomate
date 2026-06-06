using System;
using Avalonia.Controls;
using Avalonia.Platform;

namespace Jobomate.Views;

public partial class MainWindow : Window
{
    private readonly JobomateServices _services = new();

    public MainWindow()
    {
        InitializeComponent();
        TrySetWindowIcon();
        ShowRoot();
    }

    private void ShowRoot()
    {
        // Go straight to the main command center — onboarding is optional (the profile
        // falls back to the known background, and CV/LLM/email live in Details & settings).
        ShowDashboard();
        UpdateStatusPill();
    }

    public void ShowOnboarding()
    {
        var view = new OnboardingView();
        view.Bind(_services, onDone: ShowDashboard);
        RootContent.Content = view;
    }

    public void ShowDashboard()
    {
        _services.MarkOnboarded();
        var view = new ShellView();
        view.Bind(_services);
        RootContent.Content = view;
        UpdateStatusPill();
    }

    private void UpdateStatusPill()
    {
        var live = _services.EmailConfig.Tested && _services.EmailConfig.Provider != Contracts.EmailProviderKind.DryRun;
        StatusPill.Text = live
            ? $"Live · {_services.EmailConfig.Provider} · approval required before every send"
            : "Dry-run · nothing sends without approval";
    }

    private void TrySetWindowIcon()
    {
        try
        {
            using var stream = AssetLoader.Open(new Uri("avares://Jobomate/Resources/JobomateLogo.png"));
            Icon = new WindowIcon(stream);
        }
        catch
        {
            // Icon is optional.
        }
    }
}
