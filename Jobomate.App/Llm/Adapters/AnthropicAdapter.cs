using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Llm.Adapters;

public sealed class AnthropicAdapter : ILlmAdapter
{
    private readonly HttpClient _http;
    public AnthropicAdapter(HttpClient http) => _http = http;

    public string Name => "anthropic";
    public LlmCapability Capabilities =>
        LlmCapability.Chat |
        LlmCapability.ToolCalls |
        LlmCapability.LongContext |
        LlmCapability.Reasoning |
        LlmCapability.Vision;

    public async Task<string> Send(
        LlmEndpoint endpoint,
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages,
        IReadOnlyList<JsonElement> tools,
        LlmCallOptions options,
        CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint.Url);
        if (!string.IsNullOrWhiteSpace(endpoint.AuthHeader) &&
            !string.IsNullOrWhiteSpace(endpoint.AuthValue))
        {
            req.Headers.TryAddWithoutValidation(endpoint.AuthHeader, endpoint.AuthValue);
        }
        req.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");

        var stream = options.EnableStreaming &&
                       !options.ConnectionTest &&
                       options.OnContentDelta is not null;
        if (stream)
        {
            req.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
        }

        var system = string.Join(
            "\n\n",
            messages.Where(m => m.TryGetValue("role", out var r) && r == "system")
                    .Select(m => m.TryGetValue("content", out var c) ? c : ""));
        var nonSystem = messages
            .Where(m => m.TryGetValue("role", out var r) && r != "system")
            .Select(m => (IReadOnlyDictionary<string, string>)new Dictionary<string, string>
            {
                ["role"] = m.TryGetValue("role", out var r) ? r : "user",
                ["content"] = m.TryGetValue("content", out var c) ? c : "",
            })
            .ToArray();

        var anthropicTools = tools.Select(t =>
        {
            var fn = t.ValueKind == JsonValueKind.Object && t.TryGetProperty("function", out var f) && f.ValueKind == JsonValueKind.Object
                ? f
                : t;
            var ok = fn.ValueKind == JsonValueKind.Object;
            return new
            {
                name = ok && fn.TryGetProperty("name", out var n) ? n.GetString() : "",
                description = ok && fn.TryGetProperty("description", out var d) ? d.GetString() : "",
                input_schema = ok && fn.TryGetProperty("parameters", out var p) ? (JsonElement?)p : null,
            };
        }).ToArray();

        var payload = new Dictionary<string, object?>
        {
            ["model"] = endpoint.Model,
            ["max_tokens"] = options.MaxOutputTokens
                ?? (options.ConnectionTest ? 32 : options.FastMode ? 2048 : 4096),
            ["system"] = system,
            ["messages"] = nonSystem,
            ["stream"] = stream,
        };
        if (anthropicTools.Length > 0)
        {
            payload["tools"] = anthropicTools;
            payload["tool_choice"] = new { type = options.RequireToolUse || options.ConnectionTest ? "any" : "auto" };
        }
        if (!options.ConnectionTest && !options.FastMode && !string.IsNullOrWhiteSpace(options.ReasoningEffort))
        {
            payload["thinking"] = new
            {
                type = "enabled",
                budget_tokens = BudgetFor(options.ReasoningEffort!),
            };
        }

        req.Content = JsonContent.Create(payload);
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (stream && resp.IsSuccessStatusCode)
        {
            return await ReadAnthropicStreamAsync(resp, options.OnContentDelta!, ct).ConfigureAwait(false);
        }

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new LlmAdapterException(
                LlmErrorNormalizer.FromHttpStatus(resp.StatusCode, body),
                $"HTTP {(int)resp.StatusCode}: {OpenAiCompatibleAdapter.Trim(body, 500)}");
        }
        return body;
    }

    private static async Task<string> ReadAnthropicStreamAsync(
        HttpResponseMessage resp,
        Action<string> onDelta,
        CancellationToken ct)
    {
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream);
        var sseBuffer = new StringBuilder();
        var blocks = new Dictionary<int, AnthropicStreamParser.ContentBlock>();
        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
            if (line is null) break;
            sseBuffer.AppendLine(line);
            if (line.Length != 0) continue;
            AnthropicStreamParser.ApplyChunk(sseBuffer.ToString(), blocks, onDelta);
            sseBuffer.Clear();
        }

        if (sseBuffer.Length > 0)
            AnthropicStreamParser.ApplyChunk(sseBuffer.ToString(), blocks, onDelta);

        return AnthropicStreamParser.BuildAssistantResponse(blocks);
    }

    private static int BudgetFor(string effort) => effort.ToLowerInvariant() switch
    {
        "low" => 1_024,
        "medium" => 4_096,
        "high" => 16_384,
        "max" => 32_768,
        _ => 4_096,
    };
}
