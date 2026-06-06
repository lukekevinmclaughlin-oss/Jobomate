using System;
using System.Collections.Generic;
using System.Linq;

namespace Jobomate.Contracts;

/// <summary>Anything persisted by the generic SQLite repository.</summary>
public interface IEntity
{
    string Id { get; set; }
}

// ----------------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------------

public enum SearchMode { RecentJobs, Unsolicited }

public enum WorkLocationType { Unclear, Remote, Hybrid, OnSite }

public enum LanguageRequirementKind { Required, Preferred, Unclear }

/// <summary>How strictly the language filter treats a posting.</summary>
public enum LanguageMatchMode
{
    /// <summary>Default: include only postings whose required languages are all acceptable.</summary>
    StrictRequired,

    /// <summary>Also include postings whose language requirement is unclear.</summary>
    IncludeUnclear,

    /// <summary>Also include postings that require a non-accepted language only as preferred/nice-to-have.</summary>
    IncludePreferredMismatch,

    /// <summary>Show everything, but flag mismatches.</summary>
    ShowAllFlag,
}

public enum LanguageInclusionDecision { Included, Excluded, Flagged }

public enum StartDateRisk { Unknown, Compatible, Risk, Incompatible }

public enum ApplicationMethod { Unknown, Email, Portal, ManualContact }

public enum DraftStatus { Draft, Approved, Rejected, Paused }

public enum SendStatus { Pending, Sending, Sent, Failed, Paused, Cancelled }

public enum EmailProviderKind { DryRun, Smtp, GmailOAuth, MicrosoftGraph }

public enum AtsKind { Unknown, Greenhouse, Lever, Personio, Workday, CompanyPage }

public enum ContactStatus { Unknown, HasEmail, NeedsManualContact }

public enum ApplicationKind { JobApplication, Unsolicited }

public enum TrackerStatus { Drafted, Approved, Queued, Sent, Replied, Interview, Rejected, Failed, ManualRequired }

public enum SearchRunStatus { Running, Completed, Failed, Cancelled }

public enum AuditSeverity { Info, Warning, Error }

public enum DocumentKind { Cv, CoverLetter, Other }

// ----------------------------------------------------------------------------
// Value types
// ----------------------------------------------------------------------------

/// <summary>A single language requirement with the exact evidence snippet that classified it.</summary>
public sealed class LanguageRequirement
{
    public string Language { get; set; } = "";
    public LanguageRequirementKind Kind { get; set; } = LanguageRequirementKind.Unclear;

    /// <summary>The exact phrase from the posting that justifies this classification (never guessed).</summary>
    public string Evidence { get; set; } = "";
}

/// <summary>The full, explainable language decision for a posting.</summary>
public sealed class LanguageAssessment
{
    public List<LanguageRequirement> Requirements { get; set; } = new();
    public LanguageInclusionDecision Decision { get; set; } = LanguageInclusionDecision.Included;
    public string Reason { get; set; } = "";

    /// <summary>True when no requirement carries evidence (treated as "Language unclear").</summary>
    public bool IsUnclear =>
        Requirements.Count == 0 ||
        Requirements.All(r => r.Kind == LanguageRequirementKind.Unclear || string.IsNullOrWhiteSpace(r.Evidence));

    public IEnumerable<string> RequiredLanguages =>
        Requirements.Where(r => r.Kind == LanguageRequirementKind.Required && !string.IsNullOrWhiteSpace(r.Evidence))
                    .Select(r => r.Language);

    public IEnumerable<string> PreferredLanguages =>
        Requirements.Where(r => r.Kind == LanguageRequirementKind.Preferred)
                    .Select(r => r.Language);
}

/// <summary>A candidate language and the honest proficiency level.</summary>
public sealed class CandidateLanguage
{
    public string Language { get; set; } = "";
    public string Level { get; set; } = "";
}

// ----------------------------------------------------------------------------
// Entities (persisted via Repository&lt;T&gt;)
// ----------------------------------------------------------------------------

public sealed class CandidateProfile : IEntity
{
    public string Id { get; set; } = "profile"; // single active profile by default
    public string FullName { get; set; } = "";
    public string Headline { get; set; } = "";
    public string Location { get; set; } = "";
    public string Email { get; set; } = "";
    public string Phone { get; set; } = "";
    public string Summary { get; set; } = "";
    public int YearsExperience { get; set; }
    public List<string> Skills { get; set; } = new();
    public List<string> Industries { get; set; } = new();
    public List<string> Tools { get; set; } = new();
    public List<string> Education { get; set; } = new();
    public List<CandidateLanguage> Languages { get; set; } = new();
    public List<string> Links { get; set; } = new();

    /// <summary>Optional availability date. Null = flexible / available anytime (the default).</summary>
    public DateOnly? AvailabilityFrom { get; set; }

    /// <summary>Human phrasing for availability used in drafts (flexible by default).</summary>
    public string AvailabilityText => AvailabilityFrom is { } d
        ? d.ToString("d MMMM yyyy", System.Globalization.CultureInfo.InvariantCulture)
        : JobomateConstants.DefaultAvailabilityText;

    public string CvDocumentId { get; set; } = "";

    /// <summary>True when this profile was seeded from the known-background fallback (CV parse failed/empty).</summary>
    public bool FromFallback { get; set; }
}

public sealed class CandidateDocument : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public DocumentKind Kind { get; set; } = DocumentKind.Cv;
    public string FileName { get; set; } = "";
    public string OriginalPath { get; set; } = "";
    public string StoredPath { get; set; } = "";
    public string ContentType { get; set; } = "application/pdf";
    public string ExtractedText { get; set; } = "";
    public DateTimeOffset AddedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class LlmConnectionConfig : IEntity
{
    public string Id { get; set; } = "llm";
    public AppConnectionType ConnectionType { get; set; } = AppConnectionType.LocalServer;

    // Cloud API
    public AppApiProvider ApiProvider { get; set; } = AppApiProvider.OpenAI;
    public string CustomEndpoint { get; set; } = "";
    public string Model { get; set; } = "";
    public string ReasoningEffort { get; set; } = "Medium";
    public bool FastMode { get; set; }

    // Local server (OpenAI-compatible)
    public string LocalServerUrl { get; set; } = "http://127.0.0.1:11434/v1/chat/completions";
    public string LocalModelName { get; set; } = "";

    // Local GGUF via bundled llama.cpp
    public string LocalAIModelPath { get; set; } = "";
    public string LocalAIModelName { get; set; } = "";
    public int LocalAIContextSize { get; set; } = 4096;
    public string LocalAIRuntimePath { get; set; } = "";
    public string LocalAIRuntime { get; set; } = "Auto";
    public string LocalAIRuntimeStorageDir { get; set; } = "";

    // CLI pipe / Terminal
    public string CliCommand { get; set; } = "ollama run llama3 \"{prompt}\"";
    public int CliTimeout { get; set; } = 120;
    public string TerminalCommand { get; set; } = "";
    public bool TerminalCaptureOutput { get; set; } = true;

    // OAuth (LLM bearer — Vertex / Azure / HuggingFace / custom)
    public AppOAuthProviderType OAuthProvider { get; set; } = AppOAuthProviderType.GoogleVertex;
    public string OAuthClientId { get; set; } = "";
    public string OAuthClientSecretRef => "llm-oauth-secret:" + OAuthProvider;
    public string OAuthAuthUrl { get; set; } = "";
    public string OAuthTokenUrl { get; set; } = "";
    public string OAuthScope { get; set; } = "";

    /// <summary>Optional system prompt applied to every call.</summary>
    public string SystemPrompt { get; set; } = "";

    /// <summary>The Keychain reference for this provider's API key (never the key itself).</summary>
    public string ApiKeyRef => "llm:" + ApiProvider;

    /// <summary>Keychain reference for the LLM OAuth refresh token.</summary>
    public string OAuthRefreshRef => "llm-oauth:" + OAuthProvider;

    public string ResolvedModel() => ConnectionType switch
    {
        AppConnectionType.ApiKey or AppConnectionType.OAuth =>
            string.IsNullOrWhiteSpace(Model) ? Providers.Info(ApiProvider).Model : Model,
        AppConnectionType.LocalServer => string.IsNullOrWhiteSpace(LocalModelName) ? "local-model" : LocalModelName,
        AppConnectionType.LocalAI => string.IsNullOrWhiteSpace(LocalAIModelName)
            ? System.IO.Path.GetFileNameWithoutExtension(LocalAIModelPath) : LocalAIModelName,
        _ => "cli",
    };
}

public sealed class EmailAccountConfig : IEntity
{
    public string Id { get; set; } = "email";
    public EmailProviderKind Provider { get; set; } = EmailProviderKind.DryRun;
    public string FromAddress { get; set; } = "";
    public string FromName { get; set; } = "";

    // SMTP
    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 587;
    public bool SmtpUseStartTls { get; set; } = true;
    public string SmtpUsername { get; set; } = "";

    // OAuth (Gmail / Microsoft)
    public string OAuthClientId { get; set; } = "";
    public string OAuthTenant { get; set; } = "common"; // Microsoft

    /// <summary>Dry-run stays the default until a real account has been tested.</summary>
    public bool Tested { get; set; }
    public DateTimeOffset? TestedAt { get; set; }

    public string SmtpPasswordRef => "smtp:" + SmtpUsername + "@" + SmtpHost;
    public string OAuthTokenRef => Provider + ":" + FromAddress;
}

public sealed class JobPosting : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public string Source { get; set; } = "";
    public string SourceUrl { get; set; } = "";
    public string Company { get; set; } = "";
    public string Title { get; set; } = "";
    public string Location { get; set; } = "";
    public WorkLocationType WorkLocation { get; set; } = WorkLocationType.Unclear;
    public string WorkLocationEvidence { get; set; } = "";

    public List<LanguageRequirement> LanguageRequirements { get; set; } = new();

    public string StartDateRequirementText { get; set; } = "";
    public DateOnly? EarliestStart { get; set; }
    public StartDateRisk StartDateRisk { get; set; } = StartDateRisk.Unknown;

    public ApplicationMethod ApplicationMethod { get; set; } = ApplicationMethod.Unknown;
    public string ContactEmail { get; set; } = "";
    public string PortalUrl { get; set; } = "";

    public DateTimeOffset DateFound { get; set; } = DateTimeOffset.UtcNow;
    public DateOnly? DatePosted { get; set; }

    /// <summary>0..1 extraction confidence.</summary>
    public double ConfidenceScore { get; set; } = 0.5;
    public string ExtractionNotes { get; set; } = "";
    public string RawDescription { get; set; } = "";

    // Analysis (filled by filters + LLM)
    public LanguageInclusionDecision LanguageDecision { get; set; } = LanguageInclusionDecision.Included;
    public string LanguageDecisionReason { get; set; } = "";
    public bool Included { get; set; } = true;
    public double FitScore { get; set; }
    public string FitExplanation { get; set; } = "";
    public string RiskNotes { get; set; } = "";
    public double RankScore { get; set; }

    public string SearchRunId { get; set; } = "";

    /// <summary>Stable key for deduplication across sources.</summary>
    public string DedupKey { get; set; } = "";
}

public sealed class CompanyTarget : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public string Name { get; set; } = "";
    public string Website { get; set; } = "";
    public string CareersUrl { get; set; } = "";
    public AtsKind Ats { get; set; } = AtsKind.Unknown;
    public string Industry { get; set; } = "";
    public string Location { get; set; } = "";

    public string RecruitingEmail { get; set; } = "";
    public string RecruitingEmailEvidence { get; set; } = "";
    public ContactStatus ContactStatus { get; set; } = ContactStatus.Unknown;

    public double FitScore { get; set; }
    public string FitExplanation { get; set; } = "";
    public string RiskNotes { get; set; } = "";
    public double RankScore { get; set; }
    public string Notes { get; set; } = "";
    public DateTimeOffset DateFound { get; set; } = DateTimeOffset.UtcNow;
    public string SearchRunId { get; set; } = "";
}

public sealed class ApplicationDraft : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public ApplicationKind Kind { get; set; } = ApplicationKind.JobApplication;
    public string JobPostingId { get; set; } = "";
    public string CompanyTargetId { get; set; } = "";
    public string Company { get; set; } = "";
    public string RoleTitle { get; set; } = "";

    public DraftStatus Status { get; set; } = DraftStatus.Draft;
    public string CoverLetterText { get; set; } = "";
    public string CoverLetterPdfPath { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? ApprovedAt { get; set; }
    public bool EditedByUser { get; set; }
    public int RegenCount { get; set; }
}

public sealed class EmailDraft : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public string ApplicationDraftId { get; set; } = "";
    public string ToAddress { get; set; } = "";
    public string ToName { get; set; } = "";
    public string Subject { get; set; } = "";
    public string Body { get; set; } = "";
    public List<string> AttachmentPaths { get; set; } = new();
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class SendScheduleItem : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public string EmailDraftId { get; set; } = "";
    public string ApplicationDraftId { get; set; } = "";
    public DateTimeOffset ScheduledAt { get; set; }
    public SendStatus Status { get; set; } = SendStatus.Pending;
    public int Attempts { get; set; }
    public string LastError { get; set; } = "";
    public DateTimeOffset? SentAt { get; set; }
}

public sealed class ApplicationRecord : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public string JobPostingId { get; set; } = "";
    public string CompanyTargetId { get; set; } = "";
    public string EmailDraftId { get; set; } = "";
    public string Company { get; set; } = "";
    public string RoleTitle { get; set; } = "";
    public TrackerStatus Status { get; set; } = TrackerStatus.Drafted;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset LastUpdateAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? AppliedAt { get; set; }
    public string Notes { get; set; } = "";
}

public sealed class AuditEvent : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public DateTimeOffset At { get; set; } = DateTimeOffset.UtcNow;
    public string Category { get; set; } = "";
    public string Action { get; set; } = "";
    public string Target { get; set; } = "";
    public string Detail { get; set; } = "";
    public string Outcome { get; set; } = "";
    public AuditSeverity Severity { get; set; } = AuditSeverity.Info;
}

public sealed class UserPreference : IEntity
{
    public string Id { get; set; } = "";   // the preference key
    public string ValueJson { get; set; } = "";
}

public sealed class BlockedCompany : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public string NameNormalized { get; set; } = "";
    public string Reason { get; set; } = "";
    public DateTimeOffset AddedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class SearchRun : IEntity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public SearchMode Mode { get; set; } = SearchMode.RecentJobs;
    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
    public string FiltersJson { get; set; } = "";
    public int ResultCount { get; set; }
    public SearchRunStatus Status { get; set; } = SearchRunStatus.Running;
    public string Message { get; set; } = "";
}
