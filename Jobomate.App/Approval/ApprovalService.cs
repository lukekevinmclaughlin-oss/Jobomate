using System;
using System.Collections.Generic;
using System.Linq;
using Jobomate.Contracts;
using Jobomate.Persistence;
using Jobomate.Security;

namespace Jobomate.Approval;

/// <summary>The single gate every send must pass: only an Approved draft may leave the machine.</summary>
public static class ApprovalGate
{
    public static bool CanSend(ApplicationDraft? draft) => draft is not null && draft.Status == DraftStatus.Approved;
}

/// <summary>
/// The approval wall's state machine. Approve/reject/pause/resume and edit/regenerate
/// transitions are audited, and any edit or regeneration of an approved draft resets it to
/// Draft so it must be re-approved before it can be scheduled.
/// </summary>
public sealed class ApprovalService
{
    private readonly Repository<ApplicationDraft> _drafts;
    private readonly IAuditLog _audit;

    public event Action<ApplicationDraft>? Changed;

    public ApprovalService(Repository<ApplicationDraft> drafts, IAuditLog audit)
    {
        _drafts = drafts;
        _audit = audit;
    }

    public ApplicationDraft? Get(string id) => _drafts.Get(id);
    public IReadOnlyList<ApplicationDraft> All() => _drafts.All();

    public void Approve(string id) => Transition(id, DraftStatus.Approved, "approved");
    public void Reject(string id) => Transition(id, DraftStatus.Rejected, "rejected");
    public void Pause(string id) => Transition(id, DraftStatus.Paused, "paused");
    public void Resume(string id) => Transition(id, DraftStatus.Draft, "resumed");

    /// <summary>Batch approval — only meaningful once items are visible and selected in the UI.</summary>
    public int ApproveBatch(IEnumerable<string> ids)
    {
        var count = 0;
        foreach (var id in ids) { Approve(id); count++; }
        _audit.Record("approval", "batch-approved", $"{count} item(s)");
        return count;
    }

    public void MarkEdited(string id)
    {
        var draft = _drafts.Get(id);
        if (draft is null) return;
        draft.EditedByUser = true;
        if (draft.Status == DraftStatus.Approved) draft.Status = DraftStatus.Draft; // must re-approve after editing
        _drafts.Upsert(draft);
        _audit.Record("approval", "edited", $"{draft.Company} — {draft.RoleTitle}");
        Changed?.Invoke(draft);
    }

    public void NoteRegenerated(string id)
    {
        var draft = _drafts.Get(id);
        if (draft is null) return;
        draft.RegenCount++;
        if (draft.Status == DraftStatus.Approved) draft.Status = DraftStatus.Draft;
        _drafts.Upsert(draft);
        _audit.Record("approval", "regenerated", $"{draft.Company} — {draft.RoleTitle}");
        Changed?.Invoke(draft);
    }

    private void Transition(string id, DraftStatus status, string action)
    {
        var draft = _drafts.Get(id);
        if (draft is null) return;
        draft.Status = status;
        if (status == DraftStatus.Approved) draft.ApprovedAt = DateTimeOffset.UtcNow;
        _drafts.Upsert(draft);
        _audit.Record("approval", action, $"{draft.Company} — {draft.RoleTitle}");
        Changed?.Invoke(draft);
    }
}
