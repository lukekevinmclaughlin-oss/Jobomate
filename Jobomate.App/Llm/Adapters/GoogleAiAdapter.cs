using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Llm.Adapters;

public sealed class GoogleAiAdapter : ILlmAdapter
{
    private readonly HttpClient _http;
    public GoogleAiAdapter(HttpClient http) => _http = http;

    public string Name => "google-ai";
    public LlmCapability Capabilities =>
        LlmCapability.Chat |
        LlmCapability.ToolCalls |
        LlmCapability.LongContext |
        LlmCapability.Vision;

    public async Task<string> Send(
        LlmEndpoint endpoint,
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages,
        IReadOnlyList<JsonElement> tools,
        LlmCallOptions options,
        CancellationToken ct)
    {
        var stream = options.EnableStreaming &&
                       !options.ConnectionTest &&
                       options.OnContentDelta is not null;

        var modelEndpoint = endpoint.Url;
        if (modelEndpoint.Contains("{model}", StringComparison.Ordinal))
        {
            modelEndpoint = modelEndpoint.Replace("{model}", endpoint.Model);
        }

        if (stream && modelEndpoint.Contains(":generateContent", StringComparison.Ordinal))
        {
            modelEndpoint = modelEndpoint.Replace(":generateContent", ":streamGenerateContent");
            if (!modelEndpoint.Contains("alt=", StringComparison.Ordinal))
            {
                modelEndpoint += modelEndpoint.Contains('?') ? "&alt=sse" : "?alt=sse";
            }
        }

        if (!string.IsNullOrWhiteSpace(endpoint.AuthValue))
        {
            var separator = modelEndpoint.Contains('?') ? "&" : "?";
            modelEndpoint = modelEndpoint + separator + "key=" + WebUtility.UrlEncode(endpoint.AuthValue);
        }

        using var req = new HttpRequestMessage(HttpMethod.Post, modelEndpoint);

        var contents = messages
            .Where(m => m.TryGetValue("role", out var r) && r != "system")
            .Select(m => new
            {
                role = m["role"] == "assistant" ? "model" : "user",
                parts = new[] { new { text = m.TryGetValue("content", out var c) ? c : "" } },
            })
            .ToArray();

        var functionDeclarations = tools.Select(t =>
        {
            var fn = t.ValueKind == JsonValueKind.Object && t.TryGetProperty("function", out var f) && f.ValueKind == JsonValueKind.Object
                ? f
                : t;
            var ok = fn.ValueKind == JsonValueKind.Object;
            return new
            {
                name = ok && fn.TryGetProperty("name", out var n) ? n.GetString() : "",
                description = ok && fn.TryGetProperty("description", out var d) ? d.GetString() : "",
                parameters = ok && fn.TryGetProperty("parameters", out var p) ? (JsonElement?)p : null,
            };
        }).ToArray();

        var payload = new Dictionary<string, object?> { ["contents"] = contents };
        if (functionDeclarations.Length > 0)
        {
            payload["tools"] = new[] { new { functionDeclarations } };
        }
        if (options.ConnectionTest)
        {
            payload["generationConfig"] = new { maxOutputTokens = 32 };
        }
        else if (options.MaxOutputTokens is { } cap)
        {
            payload["generationConfig"] = new { maxOutputTokens = cap };
        }

        req.Content = JsonContent.Create(payload);
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);

        if (stream && resp.IsSuccessStatusCode)
        {
            return await ReadGoogleStreamAsync(resp, options.OnContentDelta!, ct).ConfigureAwait(false);
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

    private static async Task<string> ReadGoogleStreamAsync(
        HttpResponseMessage resp,
        Action<string> onDelta,
        CancellationToken ct)
    {
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream);
        var buffer = new StringBuilder();
        var fullText = new StringBuilder();
        var functionCalls = new List<GoogleStreamParser.FunctionCallPart>();
        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
            if (line is null) break;
            buffer.AppendLine(line);
            GoogleStreamParser.ApplyChunk(line, functionCalls, delta =>
            {
                fullText.Append(delta);
                onDelta(delta);
            });
        }

        return GoogleStreamParser.BuildAssistantResponse(fullText, functionCalls);
    }
}
