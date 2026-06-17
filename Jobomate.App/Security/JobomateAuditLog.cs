using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jobomate.Contracts;
using Jobomate.Persistence;

namespace Jobomate.Security;

/// <summary>Full audit trail of drafts, approvals, scheduled sends, sent emails, and failures.</summary>
public interface IAuditLog
{
    void Record(AuditEvent entry);

    AuditEvent Record(string category, string action, string target,
        string? detail = null, string? outcome = null, AuditSeverity severity = AuditSeverity.Info);

    IReadOnlyList<AuditEvent> Recent(int count = 200);
}

/// <summary>
/// Writes redacted audit rows to SQLite (when a repository is supplied) and mirrors
/// them as newline-delimited JSON under <c>~/Library/Application Support/Jobomate/audit</c>.
/// Every free-text field passes through <see cref="SecretRedactor"/> first, so no secret
/// is ever persisted. Keeps a bounded in-memory tail for the UI and tests.
/// </summary>
public sealed class JobomateAuditLog : IAuditLog
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        Converters = { new JsonStringEnumConverter() },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly Repository<AuditEvent>? _repo;
    private readonly string? _jsonlDir;
    private readonly List<AuditEvent> _recent = new();
    private readonly object _gate = new();

    public JobomateAuditLog(Repository<AuditEvent>? repo = null, string? jsonlDir = null)
    {
        _repo = repo;
        _jsonlDir = jsonlDir;
    }

    public void Record(AuditEvent entry)
    {
        // Redact every free-text field BEFORE it touches memory, the DB, or disk.
        entry.Target = SecretRedactor.Redact(entry.Target);
        entry.Detail = SecretRedactor.Redact(entry.Detail);
        entry.Outcome = SecretRedactor.Redact(entry.Outcome);

        lock (_gate)
        {
            _recent.Add(entry);
            if (_recent.Count > 1000) _recent.RemoveRange(0, _recent.Count - 1000);

            try { _repo?.Upsert(entry); } catch { /* audit must never crash the caller */ }
            TryAppendJsonl(entry);
        }
    }

    public AuditEvent Record(string category, string action, string target,
        string? detail = null, string? outcome = null, AuditSeverity severity = AuditSeverity.Info)
    {
        var entry = new AuditEvent
        {
            At = DateTimeOffset.UtcNow,
            Category = category,
            Action = action,
            Target = target ?? "",
            Detail = detail ?? "",
            Outcome = outcome ?? "",
            Severity = severity,
        };
        Record(entry);
        return entry;
    }

    public IReadOnlyList<AuditEvent> Recent(int count = 200)
    {
        lock (_gate)
        {
            return _recent.AsEnumerable().Reverse().Take(count).ToList();
        }
    }

    private void TryAppendJsonl(AuditEvent entry)
    {
        if (string.IsNullOrEmpty(_jsonlDir)) return;
        try
        {
            Directory.CreateDirectory(_jsonlDir);
            var file = Path.Combine(_jsonlDir, $"audit-{entry.At:yyyyMMdd}.jsonl");
            File.AppendAllText(file, JsonSerializer.Serialize(entry, JsonOpts) + Environment.NewLine);
        }
        catch (Exception ex)
        {
            // Disk problems must not break the workflow; the in-memory tail still has the event.
            // Surface the failure to stderr so a silent audit gap is at least observable (the
            // entry itself is already redacted above, so logging its target is safe).
            Console.Error.WriteLine($"[audit] failed to append jsonl ({ex.GetType().Name}): {ex.Message}");
        }
    }
}
