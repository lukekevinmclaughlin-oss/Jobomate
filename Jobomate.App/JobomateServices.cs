using System;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using Jobomate.Approval;
using Jobomate.Contracts;
using Jobomate.Drafting;
using Jobomate.Email;
using Jobomate.Filters;
using Jobomate.Llm;
using Jobomate.Llm.Local;
using Jobomate.Persistence;
using Jobomate.Profile;
using Jobomate.Scheduling;
using Jobomate.Security;
using Jobomate.Sources;

namespace Jobomate;

/// <summary>
/// Composition root: constructs and wires every service. No god-object — just the glue
/// that holds the repositories, the LLM client, the source/filter/draft/email/scheduler
/// stacks, and the live configuration the UI binds to.
/// </summary>
public sealed class JobomateServices
{
    public JobomateDb Db { get; }
    public ICredentialStore Credentials { get; }
    public JobomateAuditLog Audit { get; }
    public HttpClient Http { get; }
    public LlmCostLedger CostLedger { get; } = new();
    public LlmGateway Gateway { get; }
    public LlmClient Llm { get; }

    /// <summary>Current high-level assistant step (shown in the sidecar). Set via <see cref="SetStatus"/>.</summary>
    public string Status { get; private set; } = "";
    public event System.Action<string>? StatusChanged;
    public void SetStatus(string status) { Status = status; StatusChanged?.Invoke(status); }
    public LocalLlmRuntime LocalRuntime { get; } = new();
    public ProfileService Profiles { get; }
    public Jobomate.Extension.ExtensionBridge Extension { get; } = new();
    public JobSearchService JobSearch { get; }
    public FilterPipeline Filters { get; } = new();
    public ApprovalService Approval { get; }
    public IClock Clock { get; } = new SystemClock();
    public IJitterSource Jitter { get; } = new RandomJitter();
    public RateLimitConfig RateLimit { get; } = new();

    // Repositories
    public Repository<CandidateProfile> ProfileRepo { get; }
    public Repository<CandidateDocument> DocumentRepo { get; }
    public Repository<JobPosting> JobRepo { get; }
    public Repository<CompanyTarget> CompanyRepo { get; }
    public Repository<ApplicationDraft> DraftRepo { get; }
    public Repository<EmailDraft> EmailRepo { get; }
    public Repository<SendScheduleItem> QueueRepo { get; }
    public Repository<ApplicationRecord> RecordRepo { get; }
    public Repository<SearchRun> SearchRunRepo { get; }
    public Repository<BlockedCompany> BlockedRepo { get; }
    private readonly Repository<LlmConnectionConfig> _llmConfigRepo;
    private readonly Repository<EmailAccountConfig> _emailConfigRepo;
    private readonly Repository<UserPreference> _prefRepo;

    // Live configuration the UI edits.
    public LlmConnectionConfig LlmConfig { get; private set; }
    public EmailAccountConfig EmailConfig { get; private set; }
    public SearchPreferences Preferences { get; private set; }
    public CandidateProfile Profile { get; private set; }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    public JobomateServices()
    {
        JobomatePaths.EnsureDir(JobomatePaths.DataDir);
        Db = new JobomateDb();
        Credentials = MakeCredentialStore();
        Http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        Gateway = LlmClient.BuildGateway(Http, CostLedger);
        Llm = new LlmClient(Gateway, Credentials);

        ProfileRepo = new Repository<CandidateProfile>(Db);
        DocumentRepo = new Repository<CandidateDocument>(Db);
        JobRepo = new Repository<JobPosting>(Db);
        CompanyRepo = new Repository<CompanyTarget>(Db);
        DraftRepo = new Repository<ApplicationDraft>(Db);
        EmailRepo = new Repository<EmailDraft>(Db);
        QueueRepo = new Repository<SendScheduleItem>(Db);
        RecordRepo = new Repository<ApplicationRecord>(Db);
        SearchRunRepo = new Repository<SearchRun>(Db);
        BlockedRepo = new Repository<BlockedCompany>(Db);
        _llmConfigRepo = new Repository<LlmConnectionConfig>(Db);
        _emailConfigRepo = new Repository<EmailAccountConfig>(Db);
        _prefRepo = new Repository<UserPreference>(Db);

        Audit = new JobomateAuditLog(new Repository<AuditEvent>(Db), JobomatePaths.AuditDir);
        Profiles = new ProfileService(ProfileRepo, DocumentRepo);
        try { Extension.Start(); } catch { /* bridge is best-effort */ }
        JobSearch = JobSources.CreateDefault(Http, Credentials, Extension);
        Approval = new ApprovalService(DraftRepo, Audit);

        LlmConfig = _llmConfigRepo.Get("llm") ?? new LlmConnectionConfig();
        EmailConfig = _emailConfigRepo.Get("email") ?? new EmailAccountConfig();
        Preferences = LoadPreferences();
        Profile = Profiles.Current();
    }

    public bool IsOnboarded => _prefRepo.Get("onboarded") is { } p && p.ValueJson == "true";

    public void MarkOnboarded() => _prefRepo.Upsert(new UserPreference { Id = "onboarded", ValueJson = "true" });

    public void ResetOnboarding() => _prefRepo.Delete("onboarded");

    public void ClearApplicationData()
    {
        foreach (var j in JobRepo.All()) JobRepo.Delete(j.Id);
        foreach (var c in CompanyRepo.All()) CompanyRepo.Delete(c.Id);
        foreach (var d in DraftRepo.All()) DraftRepo.Delete(d.Id);
        foreach (var e in EmailRepo.All()) EmailRepo.Delete(e.Id);
        foreach (var q in QueueRepo.All()) QueueRepo.Delete(q.Id);
        foreach (var r in RecordRepo.All()) RecordRepo.Delete(r.Id);
        Audit.Record("data", "cleared", "jobs/drafts/queue/tracker");
    }

    public void SaveLlmConfig(LlmConnectionConfig cfg)
    {
        LlmConfig = cfg;
        _llmConfigRepo.Upsert(cfg);
        Audit.Record("config", "llm-saved", cfg.ConnectionType.ToString());
    }

    public void SaveEmailConfig(EmailAccountConfig cfg)
    {
        EmailConfig = cfg;
        _emailConfigRepo.Upsert(cfg);
        Audit.Record("config", "email-saved", cfg.Provider.ToString());
    }

    public void SavePreferences(SearchPreferences prefs)
    {
        Preferences = prefs;
        _prefRepo.Upsert(new UserPreference { Id = "search-prefs", ValueJson = JsonSerializer.Serialize(prefs, JsonOpts) });
    }

    public void SaveProfile(CandidateProfile profile)
    {
        Profile = ProfileBuilder.EnforceGuards(profile);
        Profiles.Save(Profile);
    }

    /// <summary>Build the active email sender from the saved account config (dry-run until tested).</summary>
    public IEmailSender BuildEmailSender()
    {
        if (!EmailConfig.Tested || EmailConfig.Provider == EmailProviderKind.DryRun)
            return new DryRunEmailSender(e => Audit.Record("outbox", "dry-run", e.ToAddress, outcome: e.Subject));

        return EmailConfig.Provider switch
        {
            EmailProviderKind.Smtp => new SmtpEmailSender(
                EmailConfig.SmtpHost, EmailConfig.SmtpPort, EmailConfig.SmtpUseStartTls, EmailConfig.SmtpUsername,
                Credentials.GetCloudToken(EmailConfig.SmtpPasswordRef) ?? ""),
            EmailProviderKind.GmailOAuth => new GmailOAuthEmailSender(
                EmailConfig.FromAddress, GmailTokenManager().GetAccessTokenAsync),
            EmailProviderKind.MicrosoftGraph => new MicrosoftGraphEmailSender(
                MicrosoftTokenManager().GetAccessTokenAsync),
            _ => new DryRunEmailSender(),
        };
    }

    /// <summary>Build the real sender for the connection test, ignoring the Tested flag.</summary>
    public IEmailSender BuildEmailSenderForTest() => EmailConfig.Provider switch
    {
        EmailProviderKind.Smtp => new SmtpEmailSender(
            EmailConfig.SmtpHost, EmailConfig.SmtpPort, EmailConfig.SmtpUseStartTls, EmailConfig.SmtpUsername,
            Credentials.GetCloudToken(EmailConfig.SmtpPasswordRef) ?? ""),
        EmailProviderKind.GmailOAuth => new GmailOAuthEmailSender(EmailConfig.FromAddress, GmailTokenManager().GetAccessTokenAsync),
        EmailProviderKind.MicrosoftGraph => new MicrosoftGraphEmailSender(MicrosoftTokenManager().GetAccessTokenAsync),
        _ => new DryRunEmailSender(),
    };

    public OAuthTokenManager GmailTokenManager() => new(
        OAuthEndpointsCatalog.Google, EmailConfig.OAuthClientId,
        Credentials.GetCloudToken("gmail_client_secret"), Credentials, "gmail_refresh:" + EmailConfig.FromAddress);

    public OAuthTokenManager MicrosoftTokenManager() => new(
        OAuthEndpointsCatalog.Microsoft(EmailConfig.OAuthTenant), EmailConfig.OAuthClientId,
        Credentials.GetCloudToken("ms_client_secret"), Credentials, "ms_refresh:" + EmailConfig.FromAddress);

    public SendQueueService BuildQueueService() =>
        new(QueueRepo, EmailRepo, DraftRepo, RecordRepo, Clock, Jitter, RateLimit, Audit);

    public SendRunner BuildSendRunner() =>
        new(QueueRepo, EmailRepo, DraftRepo, RecordRepo, BuildEmailSender(), EmailConfig, Clock, Audit, RateLimit);

    public DraftGenerator BuildDraftGenerator() => new(Llm, LlmConfig);

    public LlmLanguageClassifier BuildLanguageClassifier() => new(Llm, LlmConfig);

    private SearchPreferences LoadPreferences()
    {
        var pref = _prefRepo.Get("search-prefs");
        if (pref is null || string.IsNullOrWhiteSpace(pref.ValueJson)) return new SearchPreferences();
        try { return JsonSerializer.Deserialize<SearchPreferences>(pref.ValueJson, JsonOpts) ?? new SearchPreferences(); }
        catch { return new SearchPreferences(); }
    }

    private static ICredentialStore MakeCredentialStore()
    {
        if (Environment.GetEnvironmentVariable("JOBOMATE_DISABLE_KEYCHAIN") == "1")
            return new InMemoryCredentialStore();
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            try { return new KeychainCredentialStore(); }
            catch { return new InMemoryCredentialStore(); }
        }
        return new InMemoryCredentialStore();
    }
}
