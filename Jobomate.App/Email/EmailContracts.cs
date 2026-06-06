using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jobomate.Email;

/// <summary>Normalized send-failure taxonomy that drives the scheduler's stop/pause policy.</summary>
public enum EmailErrorKind
{
    None,
    Auth,        // bad credentials / token — stop immediately
    Throttle,    // provider rate limiting — pause
    Bounce,      // recipient rejected — stop
    Transient,   // network/5xx — retry/backoff, stop on repetition
    Permanent,   // malformed/blocked — stop
}

public sealed record OutgoingEmail(
    string FromAddress,
    string FromName,
    string ToAddress,
    string ToName,
    string Subject,
    string Body,
    IReadOnlyList<string> Attachments);

public sealed record EmailSendResult(bool Success, EmailErrorKind Error = EmailErrorKind.None, string Message = "");

public sealed record EmailTestResult(bool Ok, string Message);

/// <summary>An email transport. Dry-run is the safe default until a real account is tested.</summary>
public interface IEmailSender
{
    string Name { get; }
    bool IsDryRun { get; }

    Task<EmailSendResult> SendAsync(OutgoingEmail email, CancellationToken ct = default);
    Task<EmailTestResult> TestAsync(CancellationToken ct = default);
}
