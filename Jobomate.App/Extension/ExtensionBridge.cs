using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Sources;

namespace Jobomate.Extension;

/// <summary>
/// App-side bridge to the Jobomate Chrome extension. Hosts the loopback WebSocket, maps
/// extension-extracted postings into <see cref="JobPosting"/> records, correlates "collect"
/// research runs, and surfaces the human-takeover state (login/CAPTCHA pause → resume).
/// </summary>
public sealed class ExtensionBridge
{
    public const int Port = 17893;

    private readonly JobomateWsServer _ws = new(Port);
    private readonly ConcurrentQueue<JobPosting> _pushed = new();
    private readonly ConcurrentDictionary<string, (List<JobPosting> Bag, TaskCompletionSource<bool> Done)> _collects = new();
    private Timer? _heartbeat;

    public event Action? Changed;
    public bool IsConnected => _ws.IsConnected;
    public string Status { get; private set; } = "Not connected";
    public string? NeedsUserReason { get; private set; }
    public int PushedCount => _pushed.Count;

    public void Start()
    {
        _ws.ConnectionChanged += OnConnectionChanged;
        _ws.MessageReceived += OnMessage;
        _ws.Start();
        _heartbeat = new Timer(_ => { if (_ws.IsConnected) _ = _ws.SendAsync("{\"type\":\"ping\"}"); }, null, 20000, 20000);
    }

    public void Stop()
    {
        _heartbeat?.Dispose();
        _ws.Stop();
    }

    public IReadOnlyList<JobPosting> DrainPushed()
    {
        var list = new List<JobPosting>();
        while (_pushed.TryDequeue(out var j)) list.Add(j);
        return list;
    }

    /// <summary>Ask the extension to open + extract each URL in the user's browser. Pauses on login/CAPTCHA.</summary>
    public async Task<IReadOnlyList<JobPosting>> CollectAsync(IReadOnlyList<string> urls, CancellationToken ct = default)
    {
        if (!IsConnected || urls.Count == 0) return Array.Empty<JobPosting>();

        var id = Guid.NewGuid().ToString("n");
        var bag = new List<JobPosting>();
        var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _collects[id] = (bag, done);
        try
        {
            await _ws.SendAsync(JsonSerializer.Serialize(new { type = "collect", requestId = id, urls })).ConfigureAwait(false);
            using var reg = ct.Register(() => done.TrySetResult(true));
            await Task.WhenAny(done.Task, Task.Delay(TimeSpan.FromMinutes(5), ct)).ConfigureAwait(false);
        }
        catch { /* return whatever was collected */ }
        _collects.TryRemove(id, out _);
        return bag;
    }

    public Task ExtractActiveAsync() =>
        IsConnected ? _ws.SendAsync("{\"type\":\"extractActive\",\"requestId\":\"active\"}") : Task.CompletedTask;

    public Task ResumeAsync()
    {
        NeedsUserReason = null;
        Status = "Connected";
        Changed?.Invoke();
        return IsConnected ? _ws.SendAsync("{\"type\":\"resume\"}") : Task.CompletedTask;
    }

    private void OnConnectionChanged(bool connected)
    {
        Status = connected ? "Connected" : "Not connected";
        if (!connected) NeedsUserReason = null;
        Changed?.Invoke();
    }

    private void OnMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var t) ? t.GetString() : "";
            switch (type)
            {
                case "hello":
                    Status = "Connected"; NeedsUserReason = null; Changed?.Invoke(); break;
                case "job":
                    HandleJob(root); break;
                case "needsUser":
                    NeedsUserReason = root.TryGetProperty("reason", out var r) ? r.GetString() : "Action needed";
                    Status = "Action needed — " + NeedsUserReason;
                    Changed?.Invoke();
                    break;
                case "resumed":
                    NeedsUserReason = null; Status = "Connected"; Changed?.Invoke(); break;
                case "collectDone":
                    if (root.TryGetProperty("requestId", out var ri) && ri.GetString() is { } id && _collects.TryGetValue(id, out var c))
                        c.Done.TrySetResult(true);
                    break;
            }
        }
        catch { /* ignore malformed */ }
    }

    private void HandleJob(JsonElement root)
    {
        if (!root.TryGetProperty("job", out var j) || j.ValueKind != JsonValueKind.Object) return;
        var url = root.TryGetProperty("url", out var u) ? u.GetString() : "";
        var job = MapJob(j, url);

        var reqId = root.TryGetProperty("requestId", out var ri) ? ri.GetString() : null;
        if (reqId is not null && _collects.TryGetValue(reqId, out var collect)) collect.Bag.Add(job);
        else _pushed.Enqueue(job);

        Changed?.Invoke();
    }

    private static JobPosting MapJob(JsonElement j, string? url)
    {
        string S(string p) => j.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var remote = j.TryGetProperty("remote", out var rm) && rm.ValueKind == JsonValueKind.True;
        var email = S("email");
        var src = string.IsNullOrWhiteSpace(url) ? S("sourceUrl") : url!;

        var job = new JobPosting
        {
            Source = "Browser extension",
            SourceUrl = src,
            Company = S("company"),
            Title = S("title"),
            Location = S("location"),
            WorkLocation = remote ? WorkLocationType.Remote : WorkLocationType.Unclear,
            RawDescription = S("description"),
            ContactEmail = email,
            ApplicationMethod = string.IsNullOrWhiteSpace(email) ? ApplicationMethod.Portal : ApplicationMethod.Email,
            PortalUrl = string.IsNullOrWhiteSpace(email) ? src : "",
            ConfidenceScore = 0.6,
            ExtractionNotes = "Extracted via the Jobomate Chrome extension (your logged-in session).",
        };
        return JobNormalization.Finalize(job);
    }
}
