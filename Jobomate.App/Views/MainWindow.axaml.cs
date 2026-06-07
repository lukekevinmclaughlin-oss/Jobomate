using System;
using System.Linq;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform;
using Jobomate.Contracts;

namespace Jobomate.Views;

public partial class MainWindow : Window
{
    private readonly JobomateServices _services = new();

    public MainWindow()
    {
        InitializeComponent();
        TrySetWindowIcon();
        _services.MarkOnboarded();

        Assistant.Bind(_services, OpenSidecar);
        Assistant.ThreadsChanged += PopulateThreads;
        Sidecar.Bind(_services);
        Sidecar.CloseRequested += () => SetSidecar(false);
        Sidecar.TakeOverRequested += (goal, url) => Assistant.StartBrowserRun(goal, url);

        KeyDown += OnGlobalKey;
        RunSearchBox.TextChanged += (_, _) => PopulateThreads();
        PopulateThreads();
        UpdateHeader();
    }

    /// <summary>Close the LLM Browser cleanly on app shutdown.</summary>
    public void Shutdown()
    {
        try { _services.Browser.StopAsync().Wait(2000); } catch { }
    }

    // Drag the window from the title-bar area (custom chrome has no OS title bar).
    private void TitleBar_PointerPressed(object? sender, Avalonia.Input.PointerPressedEventArgs e)
    {
        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
            BeginMoveDrag(e);
    }

    private void OnGlobalKey(object? sender, Avalonia.Input.KeyEventArgs e)
    {
        var cmd = (e.KeyModifiers & Avalonia.Input.KeyModifiers.Meta) != 0;
        if (!cmd) return;
        switch (e.Key)
        {
            case Avalonia.Input.Key.N: Assistant.NewRun(); e.Handled = true; break;
            case Avalonia.Input.Key.OemComma: OpenSidecar("settings"); e.Handled = true; break;
            case Avalonia.Input.Key.B: SetSidecar(!Sidecar.IsVisible); e.Handled = true; break;
            case Avalonia.Input.Key.J: SetSidecar(!Sidecar.IsVisible); e.Handled = true; break;
        }
    }

    // ----- sidecar -----

    private void OpenSidecar(string panel)
    {
        Sidecar.Show(panel);
        SetSidecar(true);
    }

    private void SetSidecar(bool open)
    {
        LayoutGrid.ColumnDefinitions[4].Width = new GridLength(open ? 392 : 0);
        LayoutGrid.ColumnDefinitions[3].Width = new GridLength(open ? 6 : 0);
        SidecarSplitter.IsVisible = open;
        Sidecar.IsVisible = open;
        SidecarToggle.IsChecked = open;
    }

    private void ToggleSidecar_Click(object? sender, Avalonia.Interactivity.RoutedEventArgs e) =>
        SetSidecar(SidecarToggle.IsChecked == true);

    private void OpenSettings_Click(object? sender, Avalonia.Interactivity.RoutedEventArgs e) => OpenSidecar("settings");
    private void OpenSandbox_Click(object? sender, Avalonia.Interactivity.RoutedEventArgs e) => OpenSidecar("browser");

    // ----- sidebar -----

    private void ToggleSidebar_Click(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        var show = SidebarToggle.IsChecked == true;
        LayoutGrid.ColumnDefinitions[0].Width = new GridLength(show ? 236 : 0);
        RunsSidebar.IsVisible = show;
    }

    private void NewRun_Click(object? sender, Avalonia.Interactivity.RoutedEventArgs e) => Assistant.NewRun();

    private void ArchiveRuns_Click(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        foreach (var r in _services.SearchRunRepo.All()) _services.SearchRunRepo.Delete(r.Id);
        PopulateThreads();
    }

    private void ClearData_Click(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        _services.ClearApplicationData();
        foreach (var t in _services.ThreadRepo.All()) _services.ThreadRepo.Delete(t.Id);
        foreach (var r in _services.SearchRunRepo.All()) _services.SearchRunRepo.Delete(r.Id);
        Assistant.NewRun();
        if (Sidecar.IsVisible) Sidecar.Show("activity");
    }

    // The MAOS-style chat sidebar: threads (chats) first, each expandable to its runs.
    private void PopulateThreads()
    {
        RunItems.Children.Clear();
        var filter = (RunSearchBox.Text ?? "").Trim();
        var threads = _services.ThreadRepo.All()
            .Where(t => string.IsNullOrEmpty(filter) || (t.Title?.Contains(filter, StringComparison.OrdinalIgnoreCase) ?? false))
            .OrderByDescending(t => t.LastActiveAt).Take(60).ToList();

        if (threads.Count == 0)
        {
            RunItems.Children.Add(new TextBlock
            {
                Text = "No chats yet — start one above, or pick a mode in the chat.",
                Foreground = Hex("#A1A1AA"), FontSize = 11.5, TextWrapping = TextWrapping.Wrap, Margin = new Avalonia.Thickness(2, 4, 2, 0),
            });
            return;
        }
        foreach (var thread in threads) RunItems.Children.Add(BuildThreadItem(thread));
    }

    private Control BuildThreadItem(ChatThread thread)
    {
        var runs = _services.SearchRunRepo.All().Where(r => r.ThreadId == thread.Id).OrderByDescending(r => r.StartedAt).ToList();
        var wrap = new StackPanel { Spacing = 1 };

        var runsPanel = new StackPanel { IsVisible = false, Margin = new Avalonia.Thickness(20, 0, 0, 4), Spacing = 1 };
        foreach (var run in runs)
        {
            var rb = new Button
            {
                Classes = { "subtle" },
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
                Padding = new Avalonia.Thickness(8, 4),
                Content = new TextBlock
                {
                    Text = $"↳ {(run.Mode == SearchMode.RecentJobs ? "Recent" : "Unsolicited")} · {run.ResultCount} results · {run.StartedAt.ToLocalTime():dd MMM HH:mm}",
                    Foreground = Hex("#A1A1AA"), FontSize = 10.5, TextWrapping = TextWrapping.Wrap,
                },
            };
            rb.Click += (_, _) => Assistant.LoadThread(thread);
            runsPanel.Children.Add(rb);
        }

        var chevron = new ToggleButton
        {
            Classes = { "subtle" }, Width = 22, Height = 22, MinWidth = 0, MinHeight = 0, Padding = new Avalonia.Thickness(0),
            Content = "▸", FontSize = 9, VerticalAlignment = VerticalAlignment.Center, IsVisible = runs.Count > 0,
        };
        chevron.IsCheckedChanged += (_, _) => { runsPanel.IsVisible = chevron.IsChecked == true; chevron.Content = chevron.IsChecked == true ? "▾" : "▸"; };

        var threadBtn = new Button
        {
            Classes = { "nav" }, HorizontalAlignment = HorizontalAlignment.Stretch,
            Content = new StackPanel
            {
                Spacing = 1,
                Children =
                {
                    new TextBlock { Text = thread.Title, Foreground = Hex("#FAFAFA"), FontWeight = FontWeight.SemiBold, FontSize = 12.5, TextTrimming = TextTrimming.CharacterEllipsis },
                    new TextBlock { Text = $"{thread.LastActiveAt.ToLocalTime():dd MMM HH:mm}{(runs.Count > 0 ? $" · {runs.Count} run{(runs.Count == 1 ? "" : "s")}" : "")}", Foreground = Hex("#A1A1AA"), FontSize = 10.5 },
                },
            },
        };
        threadBtn.Click += (_, _) => Assistant.LoadThread(thread);

        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        header.Children.Add(chevron);
        Grid.SetColumn(threadBtn, 1);
        header.Children.Add(threadBtn);

        wrap.Children.Add(header);
        wrap.Children.Add(runsPanel);
        return wrap;
    }

    // ----- traffic lights -----

    private void Traffic_Close(object? sender, Avalonia.Interactivity.RoutedEventArgs e) => Close();
    private void Traffic_Minimize(object? sender, Avalonia.Interactivity.RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Traffic_Zoom(object? sender, Avalonia.Interactivity.RoutedEventArgs e) =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    // ----- chrome -----

    private void UpdateHeader()
    {
        var live = _services.EmailConfig.Tested && _services.EmailConfig.Provider != Contracts.EmailProviderKind.DryRun;
        HeaderSubtitle.Text = live ? $"Live · {_services.EmailConfig.Provider}" : "Application command center";
    }

    private void TrySetWindowIcon()
    {
        try
        {
            using var stream = AssetLoader.Open(new Uri("avares://Jobomate/Resources/JobomateLogo.png"));
            Icon = new WindowIcon(stream);
        }
        catch { /* optional */ }
    }

    private static IBrush Hex(string hex) => new SolidColorBrush(Color.Parse(hex));
}
