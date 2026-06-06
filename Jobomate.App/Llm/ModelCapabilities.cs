using Jobomate.Contracts;

namespace Jobomate.Llm;

/// <summary>Tool-calling reliability tier (schematic #04 A–D).</summary>
public enum ToolCallingTier
{
    /// <summary>Native, reliable parallel tool calls (frontier APIs).</summary>
    A,
    /// <summary>Native tool calls with occasional schema/format quirks.</summary>
    B,
    /// <summary>JSON-in-text or single-tool fallback; needs recovery scaffolding.</summary>
    C,
    /// <summary>Chat-only; no tool channel.</summary>
    D,
}

/// <summary>Declared capabilities for a provider + model pair.</summary>
public sealed record ProviderModelMetadata(
    string Provider,
    string Model,
    ToolCallingTier ToolCallingTier,
    LlmCapability Capabilities,
    int? ContextWindowTokens = null,
    bool SupportsParallelToolCalls = false,
    bool SupportsToolChoiceRequired = false);

/// <summary>Maps connection types and model ids to schematic tool-calling tiers.</summary>
public static class ModelCapabilities
{
    public static ProviderModelMetadata Resolve(AppConnectionType connectionType, string? model, LlmCapability adapterCaps)
    {
        var m = (model ?? "").ToLowerInvariant();
        var provider = connectionType.ToString();

        var tier = ClassifyToolCallingTier(connectionType, m);
        return new ProviderModelMetadata(
            provider,
            model ?? "",
            tier,
            adapterCaps,
            ContextWindowTokens: InferContextWindow(m),
            SupportsParallelToolCalls: tier is ToolCallingTier.A or ToolCallingTier.B,
            SupportsToolChoiceRequired: tier == ToolCallingTier.A);
    }

    /// <summary>
    /// True when the model can take image input (multimodal / vision). Used to decide whether attached
    /// images are sent as image blocks. Matches the common all-in-one vision families by name so a
    /// Local AI GGUF like "gemma-3-27b-it" or a hosted "gpt-4o" / "claude-3.5" / "gemini-1.5" qualifies.
    /// </summary>
    public static bool SupportsVision(string? model)
    {
        var m = (model ?? "").ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(m)) return false;
        // Explicitly multimodal local + hosted families.
        if (m.Contains("gemma-3") || m.Contains("gemma3")) return true;          // Gemma 3 is natively multimodal
        if (m.Contains("-vl") || m.Contains("vl-") || m.Contains("qwen2.5-vl") || m.Contains("qwen2-vl")) return true;
        if (m.Contains("llava") || m.Contains("minicpm-v") || m.Contains("pixtral")
            || m.Contains("internvl") || m.Contains("moondream") || m.Contains("smolvlm")) return true;
        if (m.Contains("llama-3.2") && (m.Contains("vision") || m.Contains("11b") || m.Contains("90b"))) return true;
        // Hosted multimodal models.
        if (m.Contains("gpt-4o") || m.Contains("gpt-4.1") || m.Contains("gpt-4-turbo") || m.Contains("o4")) return true;
        if (m.Contains("claude-3") || m.Contains("claude-4") || m.StartsWith("claude-")) return true;
        if (m.Contains("gemini-1.5") || m.Contains("gemini-2") || m.Contains("gemini-flash") || m.Contains("gemini-pro")) return true;
        if (m.Contains("vision") || m.Contains("multimodal")) return true;
        return false;
    }

    public static ToolCallingTier ClassifyToolCallingTier(AppConnectionType connectionType, string modelLower)
    {
        if (connectionType == AppConnectionType.CliPipe) return ToolCallingTier.C;

        if (connectionType is AppConnectionType.LocalServer or AppConnectionType.LocalAI)
        {
            if (modelLower.Contains("0.5b") || modelLower.Contains("1b") || modelLower.Contains("1.5b"))
                return ToolCallingTier.C;
            return ToolCallingTier.B;
        }

        if (modelLower.Contains("gpt-4") || modelLower.Contains("gpt-5")
            || modelLower.Contains("claude") || modelLower.Contains("gemini")
            || modelLower.Contains("o1") || modelLower.Contains("o3"))
            return ToolCallingTier.A;

        if (modelLower.Contains("deepseek") || modelLower.Contains("mistral")
            || modelLower.Contains("llama") || modelLower.Contains("qwen"))
            return ToolCallingTier.B;

        return connectionType == AppConnectionType.ApiKey ? ToolCallingTier.B : ToolCallingTier.C;
    }

    private static int? InferContextWindow(string modelLower)
    {
        if (modelLower.Contains("128k") || modelLower.Contains("128000")) return 128_000;
        if (modelLower.Contains("32k") || modelLower.Contains("32000")) return 32_000;
        if (modelLower.Contains("200k")) return 200_000;
        if (modelLower.Contains("1m") || modelLower.Contains("1000000")) return 1_000_000;
        return null;
    }
}
