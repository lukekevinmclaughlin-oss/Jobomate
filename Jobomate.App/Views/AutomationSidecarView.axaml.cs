using System;
using System.Linq;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Threading;
using Jobomate.Contracts;

namespace Jobomate.Views;

/// <summary>
/// The automation sidecar — a live "what's happening" pane (MAOS sidecar, specialized for
/// job automation): counts, LLM activity (pulsing dot + status), browser-extension status,
/// and the recent audit trail. Fed from the existing services; no new plumbing required.
/// </summary>
public partial class AutomationSidecarView : UserControl
{
    private static readonly IBrush Accent = new SolidColorBrush(Color.Parse("#007AFF"));
    private static readonly IBrush Dim = new SolidColorBrush(Color.Parse("#3A3A3A"));

    private JobomateServices _services = null!;
    private DispatcherTimer? _timer;

    public AutomationSidecarView() => InitializeComponent();

    public void Bind(JobomateServices services)
    {
        _services = services;
        _services.Llm.ActivityChanged += OnLlmActivity;
        _services.StatusChanged += OnStatusChanged;
        if (!string.IsNullOrEmpty(_services.Status)) NowText.Text = _services.Status;

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _timer.Tick += (_, _) => Refresh();
        AttachedToVisualTree += (_, _) => { _timer.Start(); Refresh(); };
        DetachedFromVisualTree += (_, _) => _timer.Stop();
    }

    private void OnStatusChanged(string status) =>
        Dispatcher.UIThread.Post(() => NowText.Text = string.IsNullOrEmpty(status) ? "Ready" : status);

    private void OnLlmActivity(string detail, bool active)
    {
        Dispatcher.UIThread.Post(() =>
        {
            LlmDot.Background = active ? Accent : Dim;
            LlmText.Text = active
                ? (string.IsNullOrEmpty(detail) ? "working…" : detail)
                : (string.IsNullOrEmpty(detail) ? "idle" : detail);
        });
    }

    private void Refresh()
    {
        try
        {
            var jobs = _services.JobRepo.Count();
            var drafts = _services.DraftRepo.All();
            var draftCount = drafts.Count(d => d.Status == DraftStatus.Draft);
            var approved = drafts.Count(d => d.Status == DraftStatus.Approved);
            var queued = _services.QueueRepo.All().Count(i => i.Status == SendStatus.Pending);
            CountsText.Text = $"{jobs} jobs · {draftCount} drafts · {approved} approved · {queued} queued";

            var (pt, cmp, cost) = _services.CostLedger.Totals();
            var tokens = (pt ?? 0) + (cmp ?? 0);
            CostText.Text = tokens > 0
                ? $"LLM usage: {tokens:N0} tokens{(cost is { } c ? $" · ${c:0.0000}" : "")}"
                : "";

            var ext = _services.Extension;
            ExtText.Text = ext.IsConnected
                ? (ext.NeedsUserReason is { Length: > 0 } r ? "⏸ Paused — " + r : "● Connected")
                : "○ Not connected";

            ActivityList.ItemsSource = _services.Audit.Recent(18)
                .Select(e => $"{e.At.ToLocalTime():HH:mm:ss}  {e.Category}/{e.Action}  {Trunc(e.Target, 38)}")
                .ToList();
        }
        catch { /* sidecar is best-effort */ }
    }

    private static string Trunc(string s, int n) => string.IsNullOrEmpty(s) ? "" : (s.Length <= n ? s : s[..n] + "…");
}
