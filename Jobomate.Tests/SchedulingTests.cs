using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Approval;
using Jobomate.Contracts;
using Jobomate.Email;
using Jobomate.Persistence;
using Jobomate.Scheduling;
using Jobomate.Security;
using Xunit;

namespace Jobomate.Tests;

public class SchedulingTests
{
    private static readonly TimeZoneInfo Berlin = TimeZoneInfo.FindSystemTimeZoneById("Europe/Berlin");

    private static DateTimeOffset BerlinTime(int year, int month, int day, int hour, int minute)
    {
        var local = new DateTime(year, month, day, hour, minute, 0, DateTimeKind.Unspecified);
        return new DateTimeOffset(local, Berlin.GetUtcOffset(local));
    }

    // ----- Rate limiter -----

    [Fact]
    public void RateLimiter_EnforcesMinimumGap()
    {
        var cfg = new RateLimitConfig();
        var last = BerlinTime(2026, 10, 5, 10, 0);

        var slot = SendScheduler.ComputeNextSlot(cfg, now: last, lastSend: last, sentToday: 0, jitter: TimeSpan.Zero);

        Assert.True(slot - last >= cfg.MinGap, $"Expected >= 25 min gap, got {slot - last}.");
        Assert.False(SendScheduler.IsQuietHour(cfg, slot));
    }

    [Fact]
    public void RateLimiter_AddsJitterOnTopOfGap()
    {
        var cfg = new RateLimitConfig();
        var last = BerlinTime(2026, 10, 5, 10, 0);

        var slot = SendScheduler.ComputeNextSlot(cfg, last, last, 0, TimeSpan.FromMinutes(10));

        Assert.True(slot - last >= cfg.MinGap + TimeSpan.FromMinutes(10));
    }

    // ----- Quiet hours -----

    [Fact]
    public void QuietHours_PushSendToMorning()
    {
        var cfg = new RateLimitConfig();
        var now = BerlinTime(2026, 10, 5, 21, 30); // inside quiet window

        var slot = SendScheduler.ComputeNextSlot(cfg, now, lastSend: null, sentToday: 0, jitter: TimeSpan.Zero);
        var slotBerlin = TimeZoneInfo.ConvertTime(slot, Berlin);

        Assert.True(slot > now);
        Assert.Equal(8, slotBerlin.Hour);
        Assert.Equal(6, slotBerlin.Day); // next morning
        Assert.False(SendScheduler.IsQuietHour(cfg, slot));
    }

    [Fact]
    public void DailyCap_RollsToNextDay()
    {
        var cfg = new RateLimitConfig();
        var now = BerlinTime(2026, 10, 5, 11, 0);

        var slot = SendScheduler.ComputeNextSlot(cfg, now, now, sentToday: cfg.MaxPerDay, jitter: TimeSpan.Zero);
        var slotBerlin = TimeZoneInfo.ConvertTime(slot, Berlin);

        Assert.Equal(6, slotBerlin.Day);
        Assert.Equal(8, slotBerlin.Hour);
    }

    // ----- Failure policy -----

    [Theory]
    [InlineData(EmailErrorKind.Auth, QueueState.Stopped)]
    [InlineData(EmailErrorKind.Bounce, QueueState.Stopped)]
    [InlineData(EmailErrorKind.Permanent, QueueState.Stopped)]
    [InlineData(EmailErrorKind.Throttle, QueueState.Paused)]
    public void SendPolicy_StopsOrPauses(EmailErrorKind error, QueueState expected)
    {
        Assert.Equal(expected, SendPolicy.Evaluate(error, priorConsecutiveFailures: 0).State);
    }

    [Fact]
    public void SendPolicy_StopsOnRepeatedTransientFailures()
    {
        Assert.Equal(QueueState.Paused, SendPolicy.Evaluate(EmailErrorKind.Transient, 0).State);
        Assert.Equal(QueueState.Stopped, SendPolicy.Evaluate(EmailErrorKind.Transient, 2).State); // 2+1 == max(3)
    }

    // ----- Dry run -----

    [Fact]
    public async Task DryRunSender_Records_DoesNotSend()
    {
        var sender = new DryRunEmailSender();
        var result = await sender.SendAsync(new OutgoingEmail(
            "me@x.example", "Me", "to@x.example", "To", "Subject", "Body", Array.Empty<string>()));

        Assert.True(result.Success);
        Assert.True(sender.IsDryRun);
        Assert.Single(sender.Outbox);
    }

    // ----- Approval gate -----

    [Fact]
    public void Approval_GatesSending_AndResetsOnEdit()
    {
        var (db, keepalive) = JobomateDb.CreateInMemory();
        try
        {
            var drafts = new Repository<ApplicationDraft>(db);
            var service = new ApprovalService(drafts, new JobomateAuditLog());
            var draft = new ApplicationDraft { Company = "BioReach", RoleTitle = "Growth Lead", Status = DraftStatus.Draft };
            drafts.Upsert(draft);

            Assert.False(ApprovalGate.CanSend(drafts.Get(draft.Id)));
            service.Approve(draft.Id);
            Assert.True(ApprovalGate.CanSend(drafts.Get(draft.Id)));

            service.MarkEdited(draft.Id); // editing an approved draft forces re-approval
            Assert.False(ApprovalGate.CanSend(drafts.Get(draft.Id)));
        }
        finally { keepalive.Dispose(); }
    }

    // ----- Runner: no send before approval -----

    [Fact]
    public async Task SendRunner_NeverSendsUnapprovedDraft()
    {
        var (db, keepalive) = JobomateDb.CreateInMemory();
        try
        {
            var (queue, emails, drafts, records) = Repos(db);
            var draft = new ApplicationDraft { Company = "X", RoleTitle = "Y", Status = DraftStatus.Draft };
            drafts.Upsert(draft);
            var email = new EmailDraft { ApplicationDraftId = draft.Id, ToAddress = "to@x.example", Subject = "s", Body = "b" };
            emails.Upsert(email);
            queue.Upsert(new SendScheduleItem
            {
                ApplicationDraftId = draft.Id,
                EmailDraftId = email.Id,
                ScheduledAt = DateTimeOffset.UtcNow.AddMinutes(-1),
                Status = SendStatus.Pending,
            });

            var dry = new DryRunEmailSender();
            var runner = NewRunner(queue, emails, drafts, records, dry);

            var sent = await runner.RunDueAsync();
            Assert.Equal(0, sent);
            Assert.Empty(dry.Outbox);

            // Approve, then it sends.
            draft.Status = DraftStatus.Approved;
            drafts.Upsert(draft);
            sent = await runner.RunDueAsync();
            Assert.Equal(1, sent);
            Assert.Single(dry.Outbox);
        }
        finally { keepalive.Dispose(); }
    }

    // ----- Runner: failed send stops the queue -----

    [Fact]
    public async Task SendRunner_AuthFailure_StopsQueueSafely()
    {
        var (db, keepalive) = JobomateDb.CreateInMemory();
        try
        {
            var (queue, emails, drafts, records) = Repos(db);
            var draft = new ApplicationDraft { Company = "X", RoleTitle = "Y", Status = DraftStatus.Approved };
            drafts.Upsert(draft);
            var email = new EmailDraft { ApplicationDraftId = draft.Id, ToAddress = "to@x.example", Subject = "s", Body = "b" };
            emails.Upsert(email);
            queue.Upsert(new SendScheduleItem
            {
                ApplicationDraftId = draft.Id,
                EmailDraftId = email.Id,
                ScheduledAt = DateTimeOffset.UtcNow.AddMinutes(-1),
                Status = SendStatus.Pending,
            });

            var runner = NewRunner(queue, emails, drafts, records, new FakeSender(EmailErrorKind.Auth));
            var sent = await runner.RunDueAsync();

            Assert.Equal(0, sent);
            Assert.Equal(QueueState.Stopped, runner.State);
        }
        finally { keepalive.Dispose(); }
    }

    private static (Repository<SendScheduleItem>, Repository<EmailDraft>, Repository<ApplicationDraft>, Repository<ApplicationRecord>) Repos(JobomateDb db) =>
        (new Repository<SendScheduleItem>(db), new Repository<EmailDraft>(db), new Repository<ApplicationDraft>(db), new Repository<ApplicationRecord>(db));

    private static SendRunner NewRunner(
        Repository<SendScheduleItem> queue, Repository<EmailDraft> emails, Repository<ApplicationDraft> drafts,
        Repository<ApplicationRecord> records, IEmailSender sender) =>
        new(queue, emails, drafts, records, sender,
            new EmailAccountConfig { FromAddress = "me@x.example", FromName = "Me" },
            new SystemClock(), new JobomateAuditLog(), new RateLimitConfig());

    private sealed class FakeSender : IEmailSender
    {
        private readonly EmailErrorKind _error;
        public FakeSender(EmailErrorKind error) => _error = error;
        public string Name => "fake";
        public bool IsDryRun => false;
        public Task<EmailSendResult> SendAsync(OutgoingEmail email, CancellationToken ct = default) =>
            Task.FromResult(new EmailSendResult(false, _error, "boom"));
        public Task<EmailTestResult> TestAsync(CancellationToken ct = default) =>
            Task.FromResult(new EmailTestResult(false, "fake"));
    }
}
