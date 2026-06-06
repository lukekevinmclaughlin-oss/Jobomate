using System;
using Jobomate.Contracts;
using Jobomate.Filters;

namespace Jobomate.ViewModels;

public sealed class JobRow
{
    public required JobPosting Job { get; init; }
    public string Header => Job.Title;
    public string Sub => $"{Job.Company}  ·  {Job.Location}  ·  {Job.WorkLocation}";
    public string Decision => $"{(Job.Included ? "✓ Included" : "✕ Excluded")}  ·  language: {Job.LanguageDecision}  ·  start: {Job.StartDateRisk}";
    public string LanguageSummary => LanguageFilter.Summary(Job).Replace("\n", "   ");
    public string Method => Job.ApplicationMethod == ApplicationMethod.Email
        ? $"Apply by email: {Job.ContactEmail}"
        : Job.ApplicationMethod == ApplicationMethod.ManualContact
            ? "Manual portal application required"
            : $"Portal: {Job.PortalUrl}";
}

public sealed class CompanyRow
{
    public required CompanyTarget Company { get; init; }
    public string Header => Company.Name;
    public string Sub => $"{Company.Industry}  ·  {Company.Location}";
    // Shared shape with JobRow so the results list template renders both.
    public string Decision => $"Fit {Company.FitScore:P0}";
    public string LanguageSummary => Company.FitExplanation;
    public string Method => Company.ContactStatus == ContactStatus.HasEmail
        ? $"✓ {Company.RecruitingEmail}  ({Company.RecruitingEmailEvidence})"
        : "Needs manual contact — not scheduled";
}

public sealed class DraftRow
{
    public required ApplicationDraft Draft { get; init; }
    public EmailDraft? Email { get; init; }
    public string Header => $"{Draft.Company} — {Draft.RoleTitle}";
    public string Status => $"{Draft.Status}{(Draft.EditedByUser ? " · edited" : "")}{(Draft.RegenCount > 0 ? $" · regenerated×{Draft.RegenCount}" : "")}";
    public string Subject => Email?.Subject ?? "(no email draft)";
}

public sealed class QueueRow
{
    public required SendScheduleItem Item { get; init; }
    public string Company { get; init; } = "";
    public string Header => $"{Company}";
    public string When => $"scheduled {Item.ScheduledAt.ToLocalTime():ddd dd MMM HH:mm}";
    public string Status => $"{Item.Status}{(string.IsNullOrEmpty(Item.LastError) ? "" : " · " + Item.LastError)}";
}

public sealed class TrackerRow
{
    public required ApplicationRecord Record { get; init; }
    public string Header => $"{Record.Company} — {Record.RoleTitle}";
    public string Status => $"{Record.Status}  ·  updated {Record.LastUpdateAt.ToLocalTime():dd MMM HH:mm}";
}

public sealed class AuditRow
{
    public required AuditEvent Event { get; init; }
    public string Line => $"{Event.At.ToLocalTime():dd MMM HH:mm:ss}  ·  {Event.Category}/{Event.Action}  ·  {Event.Target}  {(string.IsNullOrEmpty(Event.Outcome) ? "" : "→ " + Event.Outcome)}";
}
