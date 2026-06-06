using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jobomate.Email;

/// <summary>
/// The safe default transport: records every message to an in-memory outbox (and an
/// optional sink) and returns success WITHOUT contacting any server. Nothing ever leaves
/// the machine.
/// </summary>
public sealed class DryRunEmailSender : IEmailSender
{
    private readonly List<OutgoingEmail> _outbox = new();
    private readonly Action<OutgoingEmail>? _record;
    private readonly object _gate = new();

    public DryRunEmailSender(Action<OutgoingEmail>? record = null) => _record = record;

    public string Name => "Dry run (records, never sends)";
    public bool IsDryRun => true;

    public IReadOnlyList<OutgoingEmail> Outbox
    {
        get { lock (_gate) return _outbox.ToArray(); }
    }

    public Task<EmailSendResult> SendAsync(OutgoingEmail email, CancellationToken ct = default)
    {
        lock (_gate) _outbox.Add(email);
        _record?.Invoke(email);
        return Task.FromResult(new EmailSendResult(true, EmailErrorKind.None, "Recorded (dry run) — not sent."));
    }

    public Task<EmailTestResult> TestAsync(CancellationToken ct = default) =>
        Task.FromResult(new EmailTestResult(true, "Dry-run sender is always ready. No account contacted."));
}
