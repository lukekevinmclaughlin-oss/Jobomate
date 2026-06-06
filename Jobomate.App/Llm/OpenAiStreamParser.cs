using System.Text;
using System.Text.Json;

namespace Jobomate.Llm;

/// <summary>Parses OpenAI-compatible SSE chat completion streams into text deltas.</summary>
public static class OpenAiStreamParser
{
    public static IEnumerable<string> ExtractContentDeltas(string sseChunk)
    {
        foreach (var line in sseChunk.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = trimmed["data:".Length..].Trim();
            if (data == "[DONE]") yield break;

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(data);
            }
            catch
            {
                continue;
            }

            using (doc)
            {
                if (!doc.RootElement.TryGetProperty("choices", out var choices) ||
                    choices.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var choice in choices.EnumerateArray())
                {
                    if (!choice.TryGetProperty("delta", out var delta)) continue;
                    if (delta.TryGetProperty("content", out var content) &&
                        content.ValueKind == JsonValueKind.String)
                    {
                        var text = content.GetString();
                        if (!string.IsNullOrEmpty(text)) yield return text;
                    }
                }
            }
        }
    }

    /// <summary>A single streamed tool_call delta fragment. Tool calls arrive
    /// incrementally: the first fragment for an index carries id + name + the
    /// start of the JSON arguments; later fragments for the same index append
    /// more argument text. Accumulate by <see cref="Index"/>.</summary>
    public readonly record struct ToolCallDelta(int Index, string? Id, string? Name, string? ArgumentsFragment);

    /// <summary>Parses OpenAI-compatible SSE chunks into tool_call delta fragments.
    /// Mirrors <see cref="ExtractContentDeltas"/> for <c>delta.tool_calls</c>. Without
    /// this, tool calls emitted during a STREAMED response are silently dropped and the
    /// agent loop never executes them (BUG-0039).</summary>
    public static IEnumerable<ToolCallDelta> ExtractToolCallDeltas(string sseChunk)
    {
        foreach (var line in sseChunk.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = trimmed["data:".Length..].Trim();
            if (data == "[DONE]") yield break;

            JsonDocument doc;
            try { doc = JsonDocument.Parse(data); }
            catch { continue; }

            using (doc)
            {
                if (!doc.RootElement.TryGetProperty("choices", out var choices) ||
                    choices.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var choice in choices.EnumerateArray())
                {
                    if (!choice.TryGetProperty("delta", out var delta)) continue;
                    if (!delta.TryGetProperty("tool_calls", out var toolCalls) ||
                        toolCalls.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    foreach (var call in toolCalls.EnumerateArray())
                    {
                        var index = call.TryGetProperty("index", out var idxEl) &&
                                    idxEl.TryGetInt32(out var i) ? i : 0;
                        string? id = call.TryGetProperty("id", out var idEl) &&
                                     idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : null;
                        string? name = null, args = null;
                        if (call.TryGetProperty("function", out var fn) && fn.ValueKind == JsonValueKind.Object)
                        {
                            if (fn.TryGetProperty("name", out var nameEl) && nameEl.ValueKind == JsonValueKind.String)
                                name = nameEl.GetString();
                            if (fn.TryGetProperty("arguments", out var argsEl) && argsEl.ValueKind == JsonValueKind.String)
                                args = argsEl.GetString();
                        }
                        yield return new ToolCallDelta(index, id, name, args);
                    }
                }
            }
        }
    }

    public static string CollectFullContent(string sseBody)
    {
        var sb = new StringBuilder();
        foreach (var delta in ExtractContentDeltas(sseBody))
        {
            sb.Append(delta);
        }
        return sb.ToString();
    }
}
