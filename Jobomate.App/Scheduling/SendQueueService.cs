using System;
using System.Collections.Generic;
using System.Linq;
using Jobomate.Approval;
using Jobomate.Contracts;
using Jobomate.Persistence;
using Jobomate.Security;

namespace Jobomate.Scheduling;

/// <summary>
/// Schedules approved drafts for gradual sending. Refuses to queue anything that is not
/// Approved or has no recipient. Spaces a batch out across the rate limit + quiet hours.
/// </summary>
public sealed class SendQueueService
{
    private readonly Repository<SendScheduleItem> _queue;
    private readonly Repository<EmailDraft> _emails;
    private readonly Repository<ApplicationDraft> _drafts;
    private readonly Repository<ApplicationRecord> _records;
    private readonly IClock _clock;
    private readonly IJitterSource _jitter;
    private readonly RateLimitConfig _cfg;
    private readonly IAuditLog _audit;

    public SendQueueService(
        Repository<SendScheduleItem> queue, Repository<EmailDraft> emails, Repository<ApplicationDraft> drafts,
        Repository<ApplicationRecord> records, IClock clock, IJitterSource jitter, RateLimitConfig cfg, IAuditLog audit)
    {
        _queue = queue;
        _emails = emails;
        _drafts = drafts;
        _records = records;
        _clock = clock;
        _jitter = jitter;
        _cfg = cfg;
        _audit = audit;
    }

    public SendScheduleItem? Enqueue(string applicationDraftId)
    {
        var draft = _drafts.Get(applicationDraftId);
        if (!ApprovalGate.CanSend(draft))
        {
            _audit.Record("schedule", "refused-unapproved", applicationDraftId, severity: AuditSeverity.Warning);
            return null;
        }

        var email = _emails.All().FirstOrDefault(e => e.ApplicationDraftId == applicationDraftId);
        if (email is null || string.IsNullOrWhiteSpace(email.ToAddress))
        {
            _audit.Record("schedule", "refused-no-recipient", applicationDraftId, severity: AuditSeverity.Warning);
            return null;
        }

        if (_queue.All().Any(i => i.ApplicationDraftId == applicationDraftId &&
                                  i.Status is SendStatus.Pending or SendStatus.Sending))
            return null; // already queued

        var now = _clock.UtcNow;
        var (last, countToday) = PlanningState(now);
        var jitter = _jitter.Next(_cfg.JitterMin, _cfg.JitterMax);
        var slot = SendScheduler.ComputeNextSlot(_cfg, now, last, countToday, jitter);

        var item = new SendScheduleItem
        {
            EmailDraftId = email.Id,
            ApplicationDraftId = applicationDraftId,
            ScheduledAt = slot,
            Status = SendStatus.Pending,
        };
        _queue.Upsert(item);

        UpsertRecord(draft!, TrackerStatus.Queued);
        _audit.Record("schedule", "queued", $"{draft!.Company} — {draft.RoleTitle}", outcome: slot.ToString("u"));
        return item;
    }

    private (DateTimeOffset? Last, int CountToday) PlanningState(DateTimeOffset now)
    {
        var tz = ResolveTz();
        var todayLocal = TimeZoneInfo.ConvertTime(now, tz).Date;

        DateTimeOffset? last = null;
        var countToday = 0;
        foreach (var item in _queue.All())
        {
            var when = item.SentAt ?? item.ScheduledAt;
            if (item.Status is SendStatus.Pending or SendStatus.Sending or SendStatus.Sent)
            {
                if (last is null || when > last) last = when;
                if (TimeZoneInfo.ConvertTime(when, tz).Date == todayLocal) countToday++;
            }
        }
        return (last, countToday);
    }

    private void UpsertRecord(ApplicationDraft draft, TrackerStatus status)
    {
        var record = _records.Get(draft.Id) ?? new ApplicationRecord { Id = draft.Id };
        record.Company = draft.Company;
        record.RoleTitle = draft.RoleTitle;
        record.JobPostingId = draft.JobPostingId;
        record.CompanyTargetId = draft.CompanyTargetId;
        record.Status = status;
        record.LastUpdateAt = _clock.UtcNow;
        _records.Upsert(record);
    }

    private TimeZoneInfo ResolveTz()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(_cfg.TimeZoneId); }
        catch { return TimeZoneInfo.Utc; }
    }
}
