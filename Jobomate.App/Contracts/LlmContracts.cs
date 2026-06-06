using System;

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

/// <summary>Cloud API providers offered in the Jobomate "Cloud API" LLM menu.</summary>
public enum AppApiProvider
{
    OpenAI,
    Anthropic,
    GoogleAI,
    OpenRouter,
    Mistral,
    Groq,
    DeepSeek,
    Together,
    XAI,
    Custom,
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

/// <summary>Provider defaults table (ported concept from MultiAgentOS AppServices.ProviderInfo).</summary>
public static class Providers
{
    public static ProviderInfo Info(AppApiProvider provider) => provider switch
    {
        AppApiProvider.OpenAI => new("https://api.openai.com/v1/chat/completions",
            "gpt-4o", "Authorization", "Bearer ", AdapterNames.OpenAiCompatible),
        AppApiProvider.Anthropic => new("https://api.anthropic.com/v1/messages",
            "claude-sonnet-4-6", "x-api-key", "", AdapterNames.Anthropic),
        AppApiProvider.GoogleAI => new("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            "gemini-2.0-flash", "key", "", AdapterNames.GoogleAi),
        AppApiProvider.OpenRouter => new("https://openrouter.ai/api/v1/chat/completions",
            "openai/gpt-4o", "Authorization", "Bearer ", AdapterNames.OpenAiCompatible),
        AppApiProvider.Mistral => new("https://api.mistral.ai/v1/chat/completions",
            "mistral-large-latest", "Authorization", "Bearer ", AdapterNames.OpenAiCompatible),
        AppApiProvider.Groq => new("https://api.groq.com/openai/v1/chat/completions",
            "llama-3.3-70b-versatile", "Authorization", "Bearer ", AdapterNames.OpenAiCompatible),
        AppApiProvider.DeepSeek => new("https://api.deepseek.com/v1/chat/completions",
            "deepseek-chat", "Authorization", "Bearer ", AdapterNames.OpenAiCompatible),
        AppApiProvider.Together => new("https://api.together.xyz/v1/chat/completions",
            "meta-llama/Llama-3.3-70B-Instruct-Turbo", "Authorization", "Bearer ", AdapterNames.OpenAiCompatible),
        AppApiProvider.XAI => new("https://api.x.ai/v1/chat/completions",
            "grok-2-latest", "Authorization", "Bearer ", AdapterNames.OpenAiCompatible),
        // Custom OpenAI-compatible: user supplies the endpoint.
        _ => new("", "", "Authorization", "Bearer ", AdapterNames.OpenAiCompatible),
    };

    public static string DisplayName(AppApiProvider provider) => provider switch
    {
        AppApiProvider.OpenAI => "OpenAI",
        AppApiProvider.Anthropic => "Anthropic",
        AppApiProvider.GoogleAI => "Google AI",
        AppApiProvider.OpenRouter => "OpenRouter",
        AppApiProvider.Mistral => "Mistral",
        AppApiProvider.Groq => "Groq",
        AppApiProvider.DeepSeek => "DeepSeek",
        AppApiProvider.Together => "Together",
        AppApiProvider.XAI => "xAI",
        AppApiProvider.Custom => "Custom (OpenAI-compatible)",
        _ => provider.ToString(),
    };

    public static bool UsesQueryParamAuth(AppApiProvider provider) => provider == AppApiProvider.GoogleAI;
}
