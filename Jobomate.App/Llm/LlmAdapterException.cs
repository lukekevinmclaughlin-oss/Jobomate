using System;
using Jobomate.Contracts;

namespace Jobomate.Llm;

// Exception thrown by adapters when the provider returns a non-success
// response. Carries the normalized error code so callers can decide
// retry / fallback / surface-to-UI without sniffing the message string.
public sealed class LlmAdapterException : Exception
{
    public AgentErrorCode Code { get; }
    public ModelErrorCode ModelCode { get; }

    public LlmAdapterException(AgentErrorCode code, string message) : base(message)
    {
        Code = code;
        ModelCode = ModelErrorMapping.FromAgentErrorCode(code);
    }

    public LlmAdapterException(ModelErrorCode code, string message) : base(message)
    {
        ModelCode = code;
        Code = ModelErrorMapping.ToAgentErrorCode(code);
    }
}
