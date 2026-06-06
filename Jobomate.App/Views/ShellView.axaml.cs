using Avalonia.Controls;
using Jobomate.Contracts;

namespace Jobomate.Views;

public partial class ShellView : UserControl
{
    private JobomateServices _services = null!;
    private CommandCenterView? _assistant;
    private DashboardView? _details;
    private AutomationSidecarView? _sidecar;

    public ShellView() => InitializeComponent();

    public void Bind(JobomateServices services)
    {
        _services = services;

        _assistant = new CommandCenterView();
        _assistant.Bind(services, OpenDetails);
        _details = new DashboardView();
        _details.Bind(services);
        _sidecar = new AutomationSidecarView();
        _sidecar.Bind(services);
        SidecarHost.Content = _sidecar;

        ShellContent.Content = _assistant;

        NavAssistant.Click += (_, _) => ShowAssistant();
        NavDetails.Click += (_, _) => ShowDetails();
        NavSidecar.Click += (_, _) => ToggleSidecar();
        SidecarCloseButton.Click += (_, _) => SetSidecar(false);
        NavRecent.Click += (_, _) => { ShowAssistant(); SetSidecar(true); _assistant!.StartMode(SearchMode.RecentJobs); };
        NavUnsolicited.Click += (_, _) => { ShowAssistant(); SetSidecar(true); _assistant!.StartMode(SearchMode.Unsolicited); };
    }

    private void ToggleSidecar() => SetSidecar(!SidecarPane.IsVisible);

    private void SetSidecar(bool visible)
    {
        SidecarPane.IsVisible = visible;
        if (visible && !NavSidecar.Classes.Contains("active")) NavSidecar.Classes.Add("active");
        else if (!visible) NavSidecar.Classes.Remove("active");
    }

    private void ShowAssistant() { ShellContent.Content = _assistant; SetActive(NavAssistant); }
    private void ShowDetails() { ShellContent.Content = _details; SetActive(NavDetails); }
    private void OpenDetails() => ShowDetails();

    private void SetActive(Button active)
    {
        foreach (var nav in new[] { NavAssistant, NavDetails })
            nav.Classes.Remove("active");
        if (!active.Classes.Contains("active")) active.Classes.Add("active");
    }
}
