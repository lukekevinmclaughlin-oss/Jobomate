using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Jobomate.Llm;

/// <summary>Parses Anthropic Messages API SSE events into text deltas and tool_use blocks.</summary>
public static class AnthropicStreamParser
{
    public sealed class ContentBlock
    {
        public string Kind = "text";
        public readonly StringBuilder Text = new();
        public string? ToolId;
        public string? ToolName;
        public readonly StringBuilder ToolInputJson = new();
    }

    public static IEnumerable<string> ExtractTextDeltas(string sseChunk)
    {
        foreach (var line in sseChunk.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = trimmed["data:".Length..].Trim();
            if (data.Length == 0 || data == "[DONE]") continue;

            JsonDocument doc;
            try { doc = JsonDocument.Parse(data); }
            catch { continue; }

            using (doc)
            {
                var root = doc.RootElement;
                if (root.TryGetProperty("type", out var type) &&
                    type.GetString() == "content_block_delta" &&
                    root.TryGetProperty("delta", out var delta) &&
                    delta.TryGetProperty("text", out var text) &&
                    text.ValueKind == JsonValueKind.String)
                {
                    var s = text.GetString();
                    if (!string.IsNullOrEmpty(s)) yield return s;
                }
            }
        }
    }

    /// <summary>Apply one SSE chunk to the in-flight content blocks (text + tool_use).</summary>
    public static void ApplyChunk(string sseChunk, Dictionary<int, ContentBlock> blocks, Action<string>? onTextDelta = null)
    {
        foreach (var line in sseChunk.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = trimmed["data:".Length..].Trim();
            if (data.Length == 0 || data == "[DONE]") continue;

            JsonDocument doc;
            try { doc = JsonDocument.Parse(data); }
            catch { continue; }

            using (doc)
            {
                var root = doc.RootElement;
                if (!root.TryGetProperty("type", out var eventTypeEl)) continue;
                var eventType = eventTypeEl.GetString();

                if (eventType == "content_block_start" &&
                    root.TryGetProperty("index", out var startIdx) &&
                    startIdx.ValueKind == JsonValueKind.Number &&
                    root.TryGetProperty("content_block", out var block))
                {
                    var idx = startIdx.GetInt32();
                    if (!blocks.TryGetValue(idx, out var slot))
                        slot = new ContentBlock();
                    slot.Kind = block.TryGetProperty("type", out var bt) ? bt.GetString() ?? "text" : "text";
                    if (slot.Kind == "tool_use")
                    {
                        slot.ToolId = block.TryGetProperty("id", out var id) ? id.GetString() : null;
                        slot.ToolName = block.TryGetProperty("name", out var nm) ? nm.GetString() : null;
                        slot.ToolInputJson.Clear();
                    }
                    blocks[idx] = slot;
                    continue;
                }

                if (eventType == "content_block_delta" &&
                    root.TryGetProperty("index", out var deltaIdx) &&
                    deltaIdx.ValueKind == JsonValueKind.Number &&
                    root.TryGetProperty("delta", out var delta))
                {
                    var idx = deltaIdx.GetInt32();
                    if (!blocks.TryGetValue(idx, out var slot))
                        slot = new ContentBlock();
                    var deltaType = delta.TryGetProperty("type", out var dt) ? dt.GetString() : null;
                    if (deltaType == "text_delta" &&
                        delta.TryGetProperty("text", out var text) &&
                        text.ValueKind == JsonValueKind.String)
                    {
                        var s = text.GetString() ?? "";
                        slot.Text.Append(s);
                        if (!string.IsNullOrEmpty(s)) onTextDelta?.Invoke(s);
                    }
                    else if (deltaType == "input_json_delta" &&
                             delta.TryGetProperty("partial_json", out var partial) &&
                             partial.ValueKind == JsonValueKind.String)
                    {
                        slot.ToolInputJson.Append(partial.GetString());
                    }
                    blocks[idx] = slot;
                }
            }
        }
    }

    public static string BuildAssistantResponse(Dictionary<int, ContentBlock> blocks)
    {
        var content = new List<object>();
        foreach (var idx in blocks.Keys.OrderBy(k => k))
        {
            var block = blocks[idx];
            if (block.Kind == "tool_use")
            {
                JsonElement input;
                try
                {
                    input = string.IsNullOrWhiteSpace(block.ToolInputJson.ToString())
                        ? JsonDocument.Parse("{}").RootElement
                        : JsonDocument.Parse(block.ToolInputJson.ToString()).RootElement;
                }
                catch
                {
                    input = JsonDocument.Parse("{}").RootElement;
                }
                content.Add(new Dictionary<string, object?>
                {
                    ["type"] = "tool_use",
                    ["id"] = block.ToolId ?? $"tool_{idx}",
                    ["name"] = block.ToolName ?? "",
                    ["input"] = JsonSerializer.Deserialize<object>(input.GetRawText()),
                });
            }
            else if (block.Text.Length > 0)
            {
                content.Add(new { type = "text", text = block.Text.ToString() });
            }
        }

        return JsonSerializer.Serialize(new { content, role = "assistant" });
    }

    public static string CollectFullText(string sseBody)
    {
        var sb = new StringBuilder();
        foreach (var d in ExtractTextDeltas(sseBody)) sb.Append(d);
        return sb.ToString();
    }
}
