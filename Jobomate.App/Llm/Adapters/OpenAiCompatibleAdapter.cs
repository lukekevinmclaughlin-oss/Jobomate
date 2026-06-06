using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Llm.Adapters;

// Covers the dominant family: OpenAI chat-completions and every provider
// that copies its wire shape (DeepSeek, Groq, OpenRouter, Together,
// Mistral, xAI, Perplexity, Fireworks, HuggingFace, Novita, ZAI, PPIO,
// ApiPie, MoonshotAI, CometAPI, GiteeAI, SambaNova, NvidiaNim,
// WorkspaceApi, LocalAIEndpoint, KoboldCpp, TextGenerationWebUI, LiteLLM,
// Foundry, DockerModelRunner, PrivateMode, Lemonade, LocalServer, LocalAI,
// AzureOpenAI, OAuth bearer flows, Custom).
//
// Mirrors the body AppServices.SendOpenAICompatible has emitted; the
// caller decides connection-test vs production via LlmCallOptions.
public sealed class OpenAiCompatibleAdapter : ILlmAdapter
{
    private readonly HttpClient _http;
    public OpenAiCompatibleAdapter(HttpClient http) => _http = http;

    public string Name => "openai-compatible";
    public LlmCapability Capabilities =>
        LlmCapability.Chat |
        LlmCapability.ToolCalls |
        LlmCapability.LongContext;

    public async Task<string> Send(
        LlmEndpoint endpoint,
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages,
        IReadOnlyList<JsonElement> tools,
        LlmCallOptions options,
        CancellationToken ct)
    {
        var r = await PostAsync(endpoint, messages, tools, options, ct).ConfigureAwait(false);

        // Model-agnostic graceful degradation. A connected model's chat template may not support a
        // `tools` array, a standalone `system` role, or llama.cpp's automatic tool-call parser
        // generation — e.g. it returns HTTP 400 "Conversation roles must alternate" / "unable to
        // generate parser". Instead of failing OR special-casing model names, retry once with NO tools
        // and the messages normalized to the universal user/assistant-alternating shape that every chat
        // template accepts. Keyed purely on the server's error, so any newly-connected LLM just works —
        // there is never per-model tuning to do.
        if (!r.Success && IsToolOrTemplateLimitation(r.Status, r.Body))
        {
            var normalized = NormalizeForUniversalTemplate(messages);
            r = await PostAsync(endpoint, normalized, Array.Empty<JsonElement>(), options, ct).ConfigureAwait(false);
        }

        if (!r.Success)
        {
            throw new LlmAdapterException(
                LlmErrorNormalizer.FromHttpStatus(r.Status, r.Body),
                $"HTTP {(int)r.Status}: {Trim(r.Body, 500)}");
        }
        return r.Body;
    }

    private async Task<(string Body, bool Success, HttpStatusCode Status)> PostAsync(
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

        var stream = options.EnableStreaming &&
                       !options.ConnectionTest &&
                       options.OnContentDelta is not null;
        var payload = new Dictionary<string, object?>
        {
            ["model"] = endpoint.Model,
            ["messages"] = BuildMessagesPayload(messages),
            ["max_tokens"] = options.MaxOutputTokens
                ?? (options.ConnectionTest ? 32 : options.FastMode ? 2048 : 4096),
            ["stream"] = stream,
        };
        if (options.Temperature is { } temperature)
        {
            payload["temperature"] = temperature;
        }
        if (tools.Count > 0)
        {
            payload["tools"] = tools;
            payload["tool_choice"] = options.ConnectionTest
                ? "required"
                : options.RequireToolUse ? "required" : "auto";
        }
        if (!options.ConnectionTest && !string.IsNullOrWhiteSpace(options.ReasoningEffort))
        {
            payload["reasoning_effort"] = options.ReasoningEffort;
        }

        req.Content = JsonContent.Create(payload);

        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (stream && resp.IsSuccessStatusCode)
        {
            var streamed = await ReadStreamingBodyAsync(resp, options.OnContentDelta!, ct).ConfigureAwait(false);
            return (streamed, true, resp.StatusCode);
        }

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return (body, resp.IsSuccessStatusCode, resp.StatusCode);
    }

    private static async Task<string> ReadStreamingBodyAsync(
        HttpResponseMessage resp,
        Action<string> onDelta,
        CancellationToken ct)
    {
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream);
        var sseBuffer = new System.Text.StringBuilder();
        var full = new System.Text.StringBuilder();
        // Accumulate streamed tool_calls by index: id + name arrive once, the JSON
        // arguments stream in fragments that must be concatenated. Without this the
        // tool calls in a streamed reply are lost and the agent never runs them (BUG-0039).
        var toolCalls = new SortedDictionary<int, (string? Id, string? Name, System.Text.StringBuilder Args)>();

        void ProcessChunk(string chunk)
        {
            foreach (var delta in OpenAiStreamParser.ExtractContentDeltas(chunk))
            {
                full.Append(delta);
                onDelta(delta);
            }
            foreach (var tc in OpenAiStreamParser.ExtractToolCallDeltas(chunk))
            {
                if (!toolCalls.TryGetValue(tc.Index, out var slot))
                    slot = (null, null, new System.Text.StringBuilder());
                if (tc.Id is not null) slot.Id = tc.Id;
                if (tc.Name is not null) slot.Name = tc.Name;
                if (tc.ArgumentsFragment is not null) slot.Args.Append(tc.ArgumentsFragment);
                toolCalls[tc.Index] = slot;
            }
        }

        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
            if (line is null) break;
            sseBuffer.AppendLine(line);
            if (line.Length != 0) continue;
            ProcessChunk(sseBuffer.ToString());
            sseBuffer.Clear();
        }

        if (sseBuffer.Length > 0) ProcessChunk(sseBuffer.ToString());

        var text = full.ToString();
        if (toolCalls.Count > 0 || !string.IsNullOrEmpty(text))
        {
            // Reconstruct a complete assistant message — content AND any tool_calls —
            // so the downstream ResponseParser can dispatch the tools the model asked for.
            var message = new Dictionary<string, object?> { ["role"] = "assistant", ["content"] = text };
            if (toolCalls.Count > 0)
            {
                message["tool_calls"] = toolCalls.Values.Select((s, idx) => new
                {
                    id = string.IsNullOrEmpty(s.Id) ? $"call_{idx}" : s.Id,
                    type = "function",
                    function = new { name = s.Name ?? "", arguments = s.Args.ToString() }
                }).ToArray();
            }
            return JsonSerializer.Serialize(new { choices = new[] { new { message } } });
        }

        return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
    }

    // Detect the "this model/server does not support tools" family of 400/422 rejections so the
    // caller can retry without the tools array instead of failing the whole chat. Kept narrow so
    // genuine bad-request errors still surface to the user.
    // A 400/422 whose body says the model's template can't handle the request as-sent: no native tool
    // support, no `system` role, strict role alternation, or a failed tool-call parser generation. All
    // of these are recoverable by retrying with no tools + normalized messages — model-agnostically.
    internal static bool IsToolOrTemplateLimitation(HttpStatusCode status, string body)
    {
        if (status is not (HttpStatusCode.BadRequest or HttpStatusCode.UnprocessableEntity)) return false;
        if (string.IsNullOrEmpty(body)) return false;
        var b = body.ToLowerInvariant();
        // A 400 about response_format / schema is NOT a recoverable template error; don't silently
        // retry and mask a real config error (BUG-0036).
        if (b.Contains("response_format")) return false;
        return b.Contains("does not support tools")
            || b.Contains("does not support tool")
            || b.Contains("tools are not supported")
            || b.Contains("tools not supported")
            || b.Contains("tool calling is not supported")
            || b.Contains("tool use is not supported")
            || b.Contains("function calling is not supported")
            // chat-template / role limitations (e.g. Gemma-style strict templates served by llama.cpp):
            || b.Contains("unable to generate parser")
            || b.Contains("parser generation failed")
            || b.Contains("roles must alternate")
            || b.Contains("conversation roles")
            || b.Contains("system role")
            || b.Contains("does not support a system")
            || b.Contains("only user and assistant roles")
            || b.Contains("raise_exception")
            || b.Contains("jinja");
    }

    // Collapse messages to the universal lowest-common-denominator chat shape that EVERY template
    // accepts: no standalone `system` role (folded into the first user turn) and strict user/assistant
    // alternation (consecutive same-role messages merged). Preserves the per-message "images" marker so
    // vision still works on the retry. Pure + model-agnostic.
    internal static List<Dictionary<string, string>> NormalizeForUniversalTemplate(
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages)
    {
        var system = new System.Text.StringBuilder();
        var rest = new List<Dictionary<string, string>>();
        foreach (var m in messages)
        {
            var role = m.TryGetValue("role", out var r) ? r : "user";
            if (role == "system")
            {
                if (m.TryGetValue("content", out var c) && !string.IsNullOrWhiteSpace(c))
                {
                    if (system.Length > 0) system.Append("\n\n");
                    system.Append(c);
                }
                continue;
            }
            rest.Add(m.ToDictionary(kv => kv.Key, kv => kv.Value));
        }

        if (system.Length > 0)
        {
            var firstUser = rest.FirstOrDefault(m => m.TryGetValue("role", out var r) && r == "user");
            if (firstUser is not null)
            {
                var body = firstUser.TryGetValue("content", out var c) ? c : "";
                firstUser["content"] = system + (string.IsNullOrEmpty(body) ? "" : "\n\n" + body);
            }
            else
            {
                rest.Insert(0, new Dictionary<string, string> { ["role"] = "user", ["content"] = system.ToString() });
            }
        }

        var outp = new List<Dictionary<string, string>>();
        foreach (var m in rest)
        {
            var role = m.TryGetValue("role", out var r) ? r : "user";
            if (outp.Count > 0 && outp[^1].TryGetValue("role", out var pr) && pr == role)
            {
                var prev = outp[^1];
                var prevC = prev.TryGetValue("content", out var pc) ? pc : "";
                var curC = m.TryGetValue("content", out var cc) ? cc : "";
                prev["content"] = string.IsNullOrEmpty(prevC) ? curC
                    : string.IsNullOrEmpty(curC) ? prevC : prevC + "\n\n" + curC;
                if (m.TryGetValue("images", out var img) && !string.IsNullOrWhiteSpace(img))
                    prev["images"] = prev.TryGetValue("images", out var pi) && !string.IsNullOrWhiteSpace(pi)
                        ? pi + ";" + img : img;
            }
            else outp.Add(m);
        }
        return outp;
    }

    // Multimodal input: a message carrying an "images" key (";"-separated local image paths) is rewritten
    // into the OpenAI content-block form — [{type:text,...},{type:image_url,image_url:{url:"data:…"}}] — so
    // an all-in-one vision model (Gemma 3, Qwen2.5-VL, LLaVA…) actually sees the pixels. Plain messages pass
    // through unchanged, and every other key (tool_call_id, name, …) is preserved.
    internal static List<Dictionary<string, object?>> BuildMessagesPayload(
        IReadOnlyList<IReadOnlyDictionary<string, string>> messages)
    {
        var result = new List<Dictionary<string, object?>>(messages.Count);
        foreach (var m in messages)
        {
            var hasImages = m.TryGetValue("images", out var images) && !string.IsNullOrWhiteSpace(images);
            var blocks = hasImages ? EncodeImageBlocks(images!) : null;
            if (blocks is not { Count: > 0 })
            {
                // No usable images → pass through verbatim (minus a stray empty "images" key).
                result.Add(m.Where(kv => kv.Key != "images")
                            .ToDictionary(kv => kv.Key, kv => (object?)kv.Value));
                continue;
            }
            var text = m.TryGetValue("content", out var c) ? c : "";
            var content = new List<object?>();
            if (!string.IsNullOrEmpty(text))
                content.Add(new Dictionary<string, object?> { ["type"] = "text", ["text"] = text });
            content.AddRange(blocks);
            var dict = m.Where(kv => kv.Key is not ("images" or "content"))
                        .ToDictionary(kv => kv.Key, kv => (object?)kv.Value);
            dict["content"] = content;
            result.Add(dict);
        }
        return result;
    }

    private static readonly Dictionary<string, string> ImageMime = new(StringComparer.OrdinalIgnoreCase)
    {
        ["png"] = "image/png", ["jpg"] = "image/jpeg", ["jpeg"] = "image/jpeg",
        ["gif"] = "image/gif", ["webp"] = "image/webp", ["bmp"] = "image/bmp",
    };

    private static List<object?> EncodeImageBlocks(string semicolonPaths)
    {
        var blocks = new List<object?>();
        foreach (var path in semicolonPaths.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var ext = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
                if (!ImageMime.TryGetValue(ext, out var mime) || !File.Exists(path)) continue;
                var bytes = File.ReadAllBytes(path);
                if (bytes.Length == 0 || bytes.Length > 16_000_000) continue; // guard empty / oversized
                var uri = $"data:{mime};base64,{Convert.ToBase64String(bytes)}";
                blocks.Add(new Dictionary<string, object?>
                {
                    ["type"] = "image_url",
                    ["image_url"] = new Dictionary<string, object?> { ["url"] = uri },
                });
            }
            catch { /* skip unreadable image */ }
        }
        return blocks;
    }

    internal static string Trim(string s, int max) => string.IsNullOrEmpty(s) || s.Length <= max ? s : s[..max] + "...";
}
