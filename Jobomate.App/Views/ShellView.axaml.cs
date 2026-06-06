using Avalonia.Controls;
using Jobomate.Contracts;

namespace Jobomate.Views;

public partial class ShellView : UserControl
{
    private JobomateServices _services = null!;
    private CommandCenterView? _assistant;
    private DashboardView? _details;

    public ShellView() => InitializeComponent();

    public void Bind(JobomateServices services)
    {
        _services = services;

        _assistant = new CommandCenterView();
        _assistant.Bind(services, OpenDetails);
        _details = new DashboardView();
        _details.Bind(services);

        ShellContent.Content = _assistant;

        NavAssistant.Click += (_, _) => ShowAssistant();
        NavDetails.Click += (_, _) => ShowDetails();
        NavRecent.Click += (_, _) => { ShowAssistant(); _assistant!.StartMode(SearchMode.RecentJobs); };
        NavUnsolicited.Click += (_, _) => { ShowAssistant(); _assistant!.StartMode(SearchMode.Unsolicited); };
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
