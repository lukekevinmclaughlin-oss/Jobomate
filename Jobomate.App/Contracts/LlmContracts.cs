using System;
using System.Collections.Generic;

namespace Jobomate.Contracts;

/// <summary>
/// Capabilities a provider+model pair declares. Flags so an adapter can advertise
/// several at once (e.g. Chat | ToolCalls | LongContext).
/// </summary>
[Flags]
public enum LlmCapability
{
    None = 0,
    Chat = 1 << 0,
    ToolCalls = 1 << 1,
    Vision = 1 << 2,
    LongContext = 1 << 3,
    Reasoning = 1 << 4,
    Streaming = 1 << 5,
    Embeddings = 1 << 6,
    LocalOnly = 1 << 7,
}

/// <summary>Normalized error taxonomy across every LLM provider (see LlmErrorNormalizer).</summary>
public enum AgentErrorCode
{
    Unknown = 0,
    RateLimit,
    Authentication,
    ContextLength,
    ContentFilter,
    Transport,
    Cancelled,
}

/// <summary>How an LLM connection is established.</summary>
public enum AppConnectionType
{
    /// <summary>Cloud provider via API key (OpenAI, Anthropic, Google AI, …).</summary>
    ApiKey,

    /// <summary>OpenAI-compatible local server (Ollama, LM Studio, custom endpoint).</summary>
    LocalServer,

    /// <summary>Shell command pipe.</summary>
    CliPipe,

    /// <summary>OAuth bearer provider (e.g. Vertex / Azure).</summary>
    OAuth,

    /// <summary>Interactive terminal command.</summary>
    Terminal,

    /// <summary>Bundled llama.cpp serving a local GGUF over a loopback endpoint.</summary>
    LocalAI,
}

/// <summary>One completed LLM call, recorded by <c>LlmCostLedger</c>.</summary>
public sealed record LlmCost(
    string Adapter,
    string Model,
    int? PromptTokens,
    int? CompletionTokens,
    decimal? UsdCost,
    DateTimeOffset At);

/// <summary>Cloud + OpenAI-compatible API providers (full MAOS set).</summary>
public enum AppApiProvider
{
    OpenAI, Anthropic, GoogleAI, OpenRouter, Mistral, Groq, DeepSeek, Together, XAI,
    Perplexity, Fireworks, HuggingFace, Novita, ZAI, PPIO, ApiPie, MoonshotAI, CometAPI,
    GiteeAI, SambaNova, NvidiaNim, AzureOpenAI, WorkspaceApi,
    LocalAIEndpoint, KoboldCpp, TextGenerationWebUI, LiteLLM, Foundry, DockerModelRunner,
    PrivateMode, Lemonade, Custom,
}

/// <summary>OAuth provider kinds (reserved for Vertex/Azure-style LLM OAuth).</summary>
public enum AppOAuthProviderType
{
    GoogleVertex,
    Azure,
    HuggingFace,
    Custom,
}

/// <summary>
/// Static connection defaults for a cloud provider: base URL, default model,
/// auth header + value prefix, and which gateway adapter serves it.
/// </summary>
/// <param name="Url">Chat/completions endpoint. For Google AI this contains the <c>{model}</c> placeholder.</param>
/// <param name="Model">Sensible default model id.</param>
/// <param name="Header">Auth header name (<c>Authorization</c>, <c>x-api-key</c>, or <c>key</c> for Google query-param auth).</param>
/// <param name="Prefix">Value prefix (e.g. <c>"Bearer "</c>).</param>
/// <param name="Adapter">Gateway adapter name: <c>openai-compatible</c>, <c>anthropic</c>, or <c>google-ai</c>.</param>
public sealed record ProviderInfo(string Url, string Model, string Header, string Prefix, string Adapter);

/// <summary>Adapter name constants matching each <c>ILlmAdapter.Name</c>.</summary>
public static class AdapterNames
{
    public const string OpenAiCompatible = "openai-compatible";
    public const string Anthropic = "anthropic";
    public const string GoogleAi = "google-ai";
    public const string Cli = "cli";
}

/// <summary>Full provider defaults table + connection helpers (ported from MAOS AppServices).</summary>
public static class Providers
{
    private const string Oai = AdapterNames.OpenAiCompatible;

    public static ProviderInfo Info(AppApiProvider p) => p switch
    {
        AppApiProvider.OpenAI => new("https://api.openai.com/v1/chat/completions", "gpt-4o", "Authorization", "Bearer ", Oai),
        AppApiProvider.Anthropic => new("https://api.anthropic.com/v1/messages", "claude-sonnet-4-6", "x-api-key", "", AdapterNames.Anthropic),
        AppApiProvider.GoogleAI => new("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", "gemini-2.0-flash", "key", "", AdapterNames.GoogleAi),
        AppApiProvider.OpenRouter => new("https://openrouter.ai/api/v1/chat/completions", "openai/gpt-4o", "Authorization", "Bearer ", Oai),
        AppApiProvider.Mistral => new("https://api.mistral.ai/v1/chat/completions", "mistral-large-latest", "Authorization", "Bearer ", Oai),
        AppApiProvider.Groq => new("https://api.groq.com/openai/v1/chat/completions", "llama-3.3-70b-versatile", "Authorization", "Bearer ", Oai),
        AppApiProvider.DeepSeek => new("https://api.deepseek.com/v1/chat/completions", "deepseek-chat", "Authorization", "Bearer ", Oai),
        AppApiProvider.Together => new("https://api.together.xyz/v1/chat/completions", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "Authorization", "Bearer ", Oai),
        AppApiProvider.XAI => new("https://api.x.ai/v1/chat/completions", "grok-2-latest", "Authorization", "Bearer ", Oai),
        AppApiProvider.Perplexity => new("https://api.perplexity.ai/chat/completions", "sonar-pro", "Authorization", "Bearer ", Oai),
        AppApiProvider.Fireworks => new("https://api.fireworks.ai/inference/v1/chat/completions", "accounts/fireworks/models/llama-v3p1-70b-instruct", "Authorization", "Bearer ", Oai),
        AppApiProvider.HuggingFace => new("https://router.huggingface.co/v1/chat/completions", "meta-llama/Llama-3.1-8B-Instruct", "Authorization", "Bearer ", Oai),
        AppApiProvider.Novita => new("https://api.novita.ai/v3/openai/chat/completions", "deepseek/deepseek-r1", "Authorization", "Bearer ", Oai),
        AppApiProvider.ZAI => new("https://api.z.ai/api/paas/v4/chat/completions", "glm-4.5", "Authorization", "Bearer ", Oai),
        AppApiProvider.PPIO => new("https://api.ppinfra.com/v3/openai/chat/completions", "qwen/qwen2.5-32b-instruct", "Authorization", "Bearer ", Oai),
        AppApiProvider.ApiPie => new("https://apipie.ai/v1/chat/completions", "gpt-4o-mini", "Authorization", "Bearer ", Oai),
        AppApiProvider.MoonshotAI => new("https://api.moonshot.ai/v1/chat/completions", "moonshot-v1-32k", "Authorization", "Bearer ", Oai),
        AppApiProvider.CometAPI => new("https://api.cometapi.com/v1/chat/completions", "gpt-5-mini", "Authorization", "Bearer ", Oai),
        AppApiProvider.GiteeAI => new("https://ai.gitee.com/v1/chat/completions", "Qwen3-32B", "Authorization", "Bearer ", Oai),
        AppApiProvider.SambaNova => new("https://api.sambanova.ai/v1/chat/completions", "Meta-Llama-3.3-70B-Instruct", "Authorization", "Bearer ", Oai),
        AppApiProvider.NvidiaNim => new("https://integrate.api.nvidia.com/v1/chat/completions", "meta/llama-3.1-70b-instruct", "Authorization", "Bearer ", Oai),
        AppApiProvider.AzureOpenAI => new("", "gpt-4o", "api-key", "", Oai),
        AppApiProvider.WorkspaceApi => new("http://127.0.0.1:3001/api/v1/openai/chat/completions", "my-workspace", "Authorization", "Bearer ", Oai),
        AppApiProvider.LocalAIEndpoint => new("http://localhost:8080/v1/chat/completions", "local-model", "Authorization", "Bearer ", Oai),
        AppApiProvider.KoboldCpp => new("http://localhost:5001/v1/chat/completions", "koboldcpp", "Authorization", "Bearer ", Oai),
        AppApiProvider.TextGenerationWebUI => new("http://localhost:5000/v1/chat/completions", "text-generation-webui", "Authorization", "Bearer ", Oai),
        AppApiProvider.LiteLLM => new("http://localhost:4000/v1/chat/completions", "gpt-4o-mini", "Authorization", "Bearer ", Oai),
        AppApiProvider.Foundry => new("http://localhost:5273/v1/chat/completions", "local-model", "Authorization", "Bearer ", Oai),
        AppApiProvider.DockerModelRunner => new("http://localhost:12434/v1/chat/completions", "local-model", "Authorization", "Bearer ", Oai),
        AppApiProvider.PrivateMode => new("", "local-model", "Authorization", "Bearer ", Oai),
        AppApiProvider.Lemonade => new("http://localhost:8000/v1/chat/completions", "local-model", "Authorization", "Bearer ", Oai),
        _ => new("", "", "Authorization", "Bearer ", Oai), // Custom
    };

    public static string DisplayName(AppApiProvider p) => p switch
    {
        AppApiProvider.OpenAI => "OpenAI",
        AppApiProvider.Anthropic => "Anthropic",
        AppApiProvider.GoogleAI => "Google AI",
        AppApiProvider.OpenRouter => "OpenRouter",
        AppApiProvider.XAI => "xAI",
        AppApiProvider.AzureOpenAI => "Azure OpenAI",
        AppApiProvider.WorkspaceApi => "Workspace API",
        AppApiProvider.NvidiaNim => "NVIDIA NIM",
        AppApiProvider.MoonshotAI => "Moonshot AI",
        AppApiProvider.CometAPI => "CometAPI",
        AppApiProvider.GiteeAI => "Gitee AI",
        AppApiProvider.ZAI => "Z.AI",
        AppApiProvider.PPIO => "PPIO",
        AppApiProvider.ApiPie => "ApiPie",
        AppApiProvider.LocalAIEndpoint => "LocalAI endpoint",
        AppApiProvider.KoboldCpp => "KoboldCpp",
        AppApiProvider.TextGenerationWebUI => "Text-Generation-WebUI",
        AppApiProvider.LiteLLM => "LiteLLM",
        AppApiProvider.DockerModelRunner => "Docker Model Runner",
        AppApiProvider.PrivateMode => "PrivateMode",
        AppApiProvider.Custom => "Custom (OpenAI-compatible)",
        _ => p.ToString(),
    };

    public static bool UsesQueryParamAuth(AppApiProvider p) => p == AppApiProvider.GoogleAI;

    /// <summary>Providers that don't need an API key (local/self-hosted).</summary>
    public static bool RequiresApiToken(AppApiProvider p) => p switch
    {
        AppApiProvider.Custom or AppApiProvider.WorkspaceApi or AppApiProvider.LocalAIEndpoint or
        AppApiProvider.KoboldCpp or AppApiProvider.TextGenerationWebUI or AppApiProvider.Foundry or
        AppApiProvider.DockerModelRunner or AppApiProvider.PrivateMode => false,
        _ => true,
    };

    /// <summary>Whether the provider+model supports a reasoning-effort / thinking budget.</summary>
    public static bool SupportsReasoningEffort(AppApiProvider p, string? model)
    {
        var m = (model ?? "").ToLowerInvariant();
        return p switch
        {
            AppApiProvider.OpenAI => m.StartsWith("o") || m.Contains("gpt-5") || m.Contains("reason"),
            AppApiProvider.Anthropic => m.Contains("claude-opus-4") || m.Contains("claude-sonnet-4") || m.Contains("claude-3-7-sonnet") || m.Contains("opus-4") || m.Contains("sonnet-4"),
            AppApiProvider.DeepSeek => m.Contains("deepseek-r1") || m.Contains("-pro"),
            _ => m.Contains("reason") || m.Contains("thinking") || m.Contains("-r1"),
        };
    }

    /// <summary>Normalize a UI effort label to the provider API value.</summary>
    public static string ReasoningEffortApiValue(string? effort) => (effort ?? "").Trim().ToLowerInvariant().Replace("_", " ") switch
    {
        "minimal" or "min" or "low" => "low",
        "high" => "high",
        "extra high" or "extra-high" or "xhigh" or "max" => "high",
        _ => "medium",
    };

    /// <summary>Environment-variable names checked as a final fallback for an API key.</summary>
    public static IReadOnlyList<string> ApiKeyEnvironmentNames(AppApiProvider p) => p switch
    {
        AppApiProvider.OpenAI => new[] { "OPENAI_API_KEY" },
        AppApiProvider.Anthropic => new[] { "ANTHROPIC_API_KEY", "CLAUDE_API_KEY" },
        AppApiProvider.GoogleAI => new[] { "GOOGLE_API_KEY", "GEMINI_API_KEY" },
        AppApiProvider.DeepSeek => new[] { "DEEPSEEK_API_KEY" },
        AppApiProvider.Groq => new[] { "GROQ_API_KEY" },
        AppApiProvider.OpenRouter => new[] { "OPENROUTER_API_KEY" },
        AppApiProvider.Together => new[] { "TOGETHER_API_KEY" },
        AppApiProvider.Mistral => new[] { "MISTRAL_API_KEY" },
        AppApiProvider.XAI => new[] { "XAI_API_KEY", "GROK_API_KEY" },
        AppApiProvider.Perplexity => new[] { "PERPLEXITY_API_KEY" },
        AppApiProvider.Fireworks => new[] { "FIREWORKS_API_KEY" },
        AppApiProvider.HuggingFace => new[] { "HUGGINGFACE_API_KEY", "HF_TOKEN" },
        AppApiProvider.Novita => new[] { "NOVITA_API_KEY" },
        AppApiProvider.SambaNova => new[] { "SAMBANOVA_API_KEY" },
        AppApiProvider.NvidiaNim => new[] { "NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY" },
        AppApiProvider.MoonshotAI => new[] { "MOONSHOT_API_KEY" },
        _ => System.Array.Empty<string>(),
    };

    /// <summary>OAuth endpoint defaults per provider type.</summary>
    public static (string AuthUrl, string TokenUrl, string Scope) OAuthDefaults(AppOAuthProviderType t) => t switch
    {
        AppOAuthProviderType.GoogleVertex => ("https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", "https://www.googleapis.com/auth/cloud-platform"),
        AppOAuthProviderType.Azure => ("https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "https://login.microsoftonline.com/common/oauth2/v2.0/token", "https://cognitiveservices.azure.com/.default offline_access"),
        AppOAuthProviderType.HuggingFace => ("https://huggingface.co/oauth/authorize", "https://huggingface.co/oauth/token", "openid profile inference-api"),
        _ => ("", "", ""),
    };
}
