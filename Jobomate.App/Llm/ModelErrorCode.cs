using Jobomate.Contracts;

namespace Jobomate.Llm;

/// <summary>Normalized model-provider error taxonomy (schematic #04). Maps 1:1 to
/// <see cref="AgentErrorCode"/> for the event stream and retry policies.</summary>
public enum ModelErrorCode
{
    RateLimit,
    Authentication,
    ContextLength,
    ContentFilter,
    Transport,
    Cancelled,
    InvalidRequest,
    ModelNotFound,
    Unknown,
}

public static class ModelErrorMapping
{
    public static AgentErrorCode ToAgentErrorCode(ModelErrorCode code) => code switch
    {
        ModelErrorCode.RateLimit => AgentErrorCode.RateLimit,
        ModelErrorCode.Authentication => AgentErrorCode.Authentication,
        ModelErrorCode.ContextLength => AgentErrorCode.ContextLength,
        ModelErrorCode.ContentFilter => AgentErrorCode.ContentFilter,
        ModelErrorCode.Transport => AgentErrorCode.Transport,
        ModelErrorCode.Cancelled => AgentErrorCode.Cancelled,
        _ => AgentErrorCode.Unknown,
    };

    public static ModelErrorCode FromAgentErrorCode(AgentErrorCode code) => code switch
    {
        AgentErrorCode.RateLimit => ModelErrorCode.RateLimit,
        AgentErrorCode.Authentication => ModelErrorCode.Authentication,
        AgentErrorCode.ContextLength => ModelErrorCode.ContextLength,
        AgentErrorCode.ContentFilter => ModelErrorCode.ContentFilter,
        AgentErrorCode.Transport => ModelErrorCode.Transport,
        AgentErrorCode.Cancelled => ModelErrorCode.Cancelled,
        _ => ModelErrorCode.Unknown,
    };
}
