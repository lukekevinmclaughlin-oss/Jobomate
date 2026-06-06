using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jobomate.Contracts;

namespace Jobomate.Llm;

// Records each completed LLM call. Phase 10 surfaces aggregate cost in the
// UI status strip; for now the ledger is a write-only audit log the agent
// runtime can query.
public sealed class LlmCostLedger
{
    private readonly ConcurrentQueue<LlmCost> _records = new();

    public void Record(LlmCost record) => _records.Enqueue(record);

    public IReadOnlyList<LlmCost> Snapshot() => _records.ToArray();

    public (int? PromptTokens, int? CompletionTokens, decimal? UsdCost) Totals()
    {
        int? prompt = null, completion = null;
        decimal? cost = null;
        foreach (var r in _records)
        {
            if (r.PromptTokens is { } p) prompt = (prompt ?? 0) + p;
            if (r.CompletionTokens is { } c) completion = (completion ?? 0) + c;
            if (r.UsdCost is { } u) cost = (cost ?? 0m) + u;
        }
        return (prompt, completion, cost);
    }

    public void Clear()
    {
        while (_records.TryDequeue(out _)) { }
    }
}
