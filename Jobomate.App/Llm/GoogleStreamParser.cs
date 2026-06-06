using System.Collections.Generic;
using System.Text;
using System.Text.Json;

namespace Jobomate.Llm;

/// <summary>Parses Gemini streamGenerateContent SSE/NDJSON into text deltas and function calls.</summary>
public static class GoogleStreamParser
{
    public sealed class FunctionCallPart
    {
        public string? Name;
        public readonly StringBuilder ArgsJson = new();
    }

    public static IEnumerable<string> ExtractTextDeltas(string chunk)
    {
        foreach (var line in chunk.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            if (trimmed.StartsWith("data:", StringComparison.Ordinal))
            {
                trimmed = trimmed["data:".Length..].Trim();
            }

            JsonDocument doc;
            try { doc = JsonDocument.Parse(trimmed); }
            catch { continue; }

            using (doc)
            {
                if (!doc.RootElement.TryGetProperty("candidates", out var candidates) ||
                    candidates.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var candidate in candidates.EnumerateArray())
                {
                    if (!candidate.TryGetProperty("content", out var content) ||
                        !content.TryGetProperty("parts", out var parts))
                    {
                        continue;
                    }

                    foreach (var part in parts.EnumerateArray())
                    {
                        if (part.TryGetProperty("text", out var text) &&
                            text.ValueKind == JsonValueKind.String)
                        {
                            var s = text.GetString();
                            if (!string.IsNullOrEmpty(s)) yield return s;
                        }
                    }
                }
            }
        }
    }

    /// <summary>Extract streamed functionCall parts from one chunk. Args may arrive incrementally as JSON text.</summary>
    public static void ApplyChunk(string chunk, List<FunctionCallPart> calls, Action<string>? onTextDelta = null)
    {
        foreach (var line in chunk.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            if (trimmed.StartsWith("data:", StringComparison.Ordinal))
                trimmed = trimmed["data:".Length..].Trim();

            JsonDocument doc;
            try { doc = JsonDocument.Parse(trimmed); }
            catch { continue; }

            using (doc)
            {
                if (!doc.RootElement.TryGetProperty("candidates", out var candidates) ||
                    candidates.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var candidate in candidates.EnumerateArray())
                {
                    if (!candidate.TryGetProperty("content", out var content) ||
                        !content.TryGetProperty("parts", out var parts))
                    {
                        continue;
                    }

                    foreach (var part in parts.EnumerateArray())
                    {
                        if (part.TryGetProperty("text", out var text) &&
                            text.ValueKind == JsonValueKind.String)
                        {
                            var s = text.GetString() ?? "";
                            if (!string.IsNullOrEmpty(s)) onTextDelta?.Invoke(s);
                        }
                        else if (part.TryGetProperty("functionCall", out var fc))
                        {
                            var name = fc.TryGetProperty("name", out var n) ? n.GetString() : null;
                            var slot = calls.Find(c => c.Name == name) ?? new FunctionCallPart { Name = name };
                            if (calls.Find(c => c.Name == name) is null)
                                calls.Add(slot);
                            if (fc.TryGetProperty("args", out var args))
                                slot.ArgsJson.Append(args.GetRawText());
                        }
                    }
                }
            }
        }
    }

    public static string BuildAssistantResponse(StringBuilder text, List<FunctionCallPart> calls)
    {
        var parts = new List<object>();
        if (text.Length > 0)
            parts.Add(new { text = text.ToString() });
        foreach (var call in calls)
        {
            JsonElement args;
            try
            {
                args = string.IsNullOrWhiteSpace(call.ArgsJson.ToString())
                    ? JsonDocument.Parse("{}").RootElement
                    : JsonDocument.Parse(call.ArgsJson.ToString()).RootElement;
            }
            catch
            {
                args = JsonDocument.Parse("{}").RootElement;
            }
            parts.Add(new Dictionary<string, object?>
            {
                ["functionCall"] = new Dictionary<string, object?>
                {
                    ["name"] = call.Name ?? "",
                    ["args"] = JsonSerializer.Deserialize<object>(args.GetRawText()),
                },
            });
        }

        return JsonSerializer.Serialize(new
        {
            candidates = new[]
            {
                new
                {
                    content = new { parts, role = "model" }
                }
            }
        });
    }

    public static string CollectFullText(string body)
    {
        var sb = new StringBuilder();
        foreach (var d in ExtractTextDeltas(body)) sb.Append(d);
        return sb.ToString();
    }
}
