using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Approval;
using Jobomate.Contracts;
using Jobomate.Email;
using Jobomate.Persistence;
using Jobomate.Security;

namespace Jobomate.Scheduling;

/// <summary>
/// Executes due, approved send-schedule items one at a time. Hard-gates on approval
/// (an unapproved draft is never sent), records every outcome to the audit log and the
/// application tracker, and stops/pauses the queue on auth/throttle/bounce/repeated failures.
/// </summary>
public sealed class SendRunner
{
    private readonly Repository<SendScheduleItem> _queue;
    private readonly Repository<EmailDraft> _emails;
    private readonly Repository<ApplicationDraft> _drafts;
    private readonly Repository<ApplicationRecord> _records;
    private readonly IEmailSender _sender;
    private readonly EmailAccountConfig _account;
    private readonly IClock _clock;
    private readonly IAuditLog _audit;
    private readonly RateLimitConfig _cfg;

    private int _consecutiveFailures;

    public SendRunner(
        Repository<SendScheduleItem> queue, Repository<EmailDraft> emails, Repository<ApplicationDraft> drafts,
        Repository<ApplicationRecord> records, IEmailSender sender, EmailAccountConfig account,
        IClock clock, IAuditLog audit, RateLimitConfig cfg)
    {
        _queue = queue;
        _emails = emails;
        _drafts = drafts;
        _records = records;
        _sender = sender;
        _account = account;
        _clock = clock;
        _audit = audit;
        _cfg = cfg;
    }

    public QueueState State { get; private set; } = QueueState.Running;
    public string LastMessage { get; private set; } = "";

    public void Pause() { State = QueueState.Paused; _audit.Record("queue", "paused", "user"); }
    public void Resume() { State = QueueState.Running; _consecutiveFailures = 0; _audit.Record("queue", "resumed", "user"); }
    public void Cancel() { State = QueueState.Stopped; _audit.Record("queue", "cancelled", "user"); }

    /// <summary>Send every due item until the queue empties or the policy stops/pauses it. Returns items sent.</summary>
    public async Task<int> RunDueAsync(CancellationToken ct = default)
    {
        if (State != QueueState.Running) return 0;

        var now = _clock.UtcNow;
        var due = _queue.All()
            .Where(i => i.Status == SendStatus.Pending && i.ScheduledAt <= now)
            .OrderBy(i => i.ScheduledAt)
            .ToList();

        var sent = 0;
        foreach (var item in due)
        {
            if (State != QueueState.Running) break;

            var draft = _drafts.Get(item.ApplicationDraftId);
            if (!ApprovalGate.CanSend(draft))
            {
                // Never send anything that isn't explicitly approved.
                _audit.Record("send", "skipped-unapproved", item.ApplicationDraftId, severity: AuditSeverity.Warning);
                continue;
            }

            var email = _emails.Get(item.EmailDraftId);
            if (email is null || string.IsNullOrWhiteSpace(email.ToAddress))
            {
                item.Status = SendStatus.Failed;
                item.LastError = "No recipient address.";
                _queue.Upsert(item);
                continue;
            }

            item.Status = SendStatus.Sending;
            item.Attempts++;
            _queue.Upsert(item);

            var outgoing = new OutgoingEmail(
                _account.FromAddress, _account.FromName, email.ToAddress, email.ToName,
                email.Subject, email.Body, email.AttachmentPaths);

            EmailSendResult result;
            try
            {
                result = await _sender.SendAsync(outgoing, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                item.Status = SendStatus.Pending; // leave for next run
                _queue.Upsert(item);
                throw;
            }
            catch (Exception ex)
            {
                result = new EmailSendResult(false, EmailErrorKind.Transient, ex.Message);
            }

            if (result.Success)
            {
                item.Status = SendStatus.Sent;
                item.SentAt = _clock.UtcNow;
                _queue.Upsert(item);
                _consecutiveFailures = 0;
                UpsertRecord(draft!, TrackerStatus.Sent, applied: true);
                _audit.Record("send", _sender.IsDryRun ? "recorded(dry-run)" : "sent", email.ToAddress, outcome: _sender.Name);
                LastMessage = result.Message;
                sent++;
            }
            else
            {
                item.LastError = result.Message;
                _audit.Record("send", "failed", email.ToAddress, outcome: $"{result.Error}: {result.Message}", severity: AuditSeverity.Error);

                var (newState, permanentlyFailed) = SendPolicy.Evaluate(result.Error, _consecutiveFailures, _cfg.MaxConsecutiveFailures);
                _consecutiveFailures++;
                item.Status = permanentlyFailed ? SendStatus.Failed : SendStatus.Pending;
                _queue.Upsert(item);
                UpsertRecord(draft!, permanentlyFailed ? TrackerStatus.Failed : draft!.Status == DraftStatus.Approved ? TrackerStatus.Queued : TrackerStatus.Failed, applied: false);

                State = newState;
                LastMessage = $"{result.Error}: {result.Message}";
                if (State != QueueState.Running) break;
            }
        }

        return sent;
    }

    private void UpsertRecord(ApplicationDraft draft, TrackerStatus status, bool applied)
    {
        var record = _records.Get(draft.Id) ?? new ApplicationRecord { Id = draft.Id };
        record.Company = draft.Company;
        record.RoleTitle = draft.RoleTitle;
        record.JobPostingId = draft.JobPostingId;
        record.CompanyTargetId = draft.CompanyTargetId;
        record.ThreadId = draft.ThreadId;
        record.Status = status;
        record.LastUpdateAt = _clock.UtcNow;
        if (applied) record.AppliedAt = _clock.UtcNow;
        _records.Upsert(record);
    }
}
