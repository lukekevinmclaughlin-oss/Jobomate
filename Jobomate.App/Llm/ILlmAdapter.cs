using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Llm;

// The Phase 2 adapter seam. Each adapter declares its capabilities and
// knows how to encode a request for one family of provider shapes.
//
// The request body is currently the same shape the rest of AppServices uses
// (List<Dictionary<string,string>>) so the cut-over is mechanical. Phase 3
// will swap this for the AgentTurn contract once both agent loops have been
// collapsed.
public interface ILlmAdapter
{
    string Name { get; }
    LlmCapability Capabilities { get; }

    Task<string> Send(
        LlmEndpoint endpoint,
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages,
        IReadOnlyList<JsonElement> tools,
        LlmCallOptions options,
        CancellationToken ct);
}

// Endpoint info given to the adapter. Auth is optional because local
// servers (Ollama, LM Studio, llama.cpp) do not require it.
public sealed record LlmEndpoint(
    string Url,
    string Model,
    string? AuthHeader = null,
    string? AuthValue = null);

// Per-call knobs. The adapter applies any that its provider supports and
// silently drops the rest (per the Llm/ README rule). Connection-test
// requests get tiny token budgets and tool_choice = required.
public sealed record LlmCallOptions(
    bool FastMode = false,
    string? ReasoningEffort = null,
    bool ConnectionTest = false,
    int? MaxOutputTokens = null,
    bool RequireToolUse = false,
    bool EnableStreaming = false,
    Action<string>? OnContentDelta = null,
    // Sampling temperature. 0 = greedy/deterministic — used for agentic tool-use turns so the
    // same task yields the same tool calls every run and the model reliably picks the
    // best-formed action instead of a random lower-probability one. null = provider default.
    double? Temperature = null);
