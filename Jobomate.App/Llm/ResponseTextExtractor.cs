using System.Text;
using System.Text.Json;
using Jobomate.Contracts;

namespace Jobomate.Llm;

/// <summary>
/// Pulls the assistant's text out of a raw provider response. Adapters return the
/// raw JSON body; this normalizes OpenAI / Anthropic / Google shapes (with a
/// universal fallback so a new provider variant still yields its text).
/// </summary>
public static class ResponseTextExtractor
{
    public static string Extract(string adapter, string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return "";
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var text = adapter switch
            {
                AdapterNames.Anthropic => Anthropic(root),
                AdapterNames.GoogleAi => Google(root),
                AdapterNames.OpenAiCompatible => OpenAi(root),
                _ => null,
            };

            // Universal fallback: try every known shape regardless of adapter.
            text ??= OpenAi(root) ?? Anthropic(root) ?? Google(root);
            return (text ?? "").Trim();
        }
        catch
        {
            return json.Trim();
        }
    }

    private static string? OpenAi(JsonElement root)
    {
        if (root.TryGetProperty("choices", out var choices) &&
            choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() > 0)
        {
            var first = choices[0];
            if (first.TryGetProperty("message", out var msg) && msg.TryGetProperty("content", out var content))
            {
                if (content.ValueKind == JsonValueKind.String) return content.GetString();
                if (content.ValueKind == JsonValueKind.Array) return JoinTextParts(content);
            }
            if (first.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String) return t.GetString();
        }
        return null;
    }

    private static string? Anthropic(JsonElement root)
    {
        if (root.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            var sb = new StringBuilder();
            foreach (var block in content.EnumerateArray())
            {
                if (block.TryGetProperty("type", out var ty) && ty.GetString() == "text" &&
                    block.TryGetProperty("text", out var tx))
                {
                    sb.Append(tx.GetString());
                }
            }
            return sb.Length > 0 ? sb.ToString() : null;
        }
        return null;
    }

    private static string? Google(JsonElement root)
    {
        if (root.TryGetProperty("candidates", out var cands) &&
            cands.ValueKind == JsonValueKind.Array && cands.GetArrayLength() > 0)
        {
            var first = cands[0];
            if (first.TryGetProperty("content", out var content) &&
                content.TryGetProperty("parts", out var parts) && parts.ValueKind == JsonValueKind.Array)
            {
                return JoinTextParts(parts);
            }
        }
        return null;
    }

    private static string JoinTextParts(JsonElement array)
    {
        var sb = new StringBuilder();
        foreach (var p in array.EnumerateArray())
        {
            if (p.ValueKind == JsonValueKind.String) sb.Append(p.GetString());
            else if (p.TryGetProperty("text", out var t)) sb.Append(t.GetString());
        }
        return sb.ToString();
    }
}
