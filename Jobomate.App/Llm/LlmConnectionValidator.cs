using Jobomate.Contracts;
using Jobomate.Llm.Local;

namespace Jobomate.Llm;

/// <summary>Pure validation for an <see cref="LlmConnectionConfig"/> across the three setup menus.</summary>
public static class LlmConnectionValidator
{
    public static (bool Ok, string Message) Validate(LlmConnectionConfig cfg, bool apiKeyPresent)
    {
        switch (cfg.ConnectionType)
        {
            case AppConnectionType.ApiKey:
                if (cfg.ApiProvider == AppApiProvider.Custom && string.IsNullOrWhiteSpace(cfg.CustomEndpoint))
                    return (false, "Enter the custom OpenAI-compatible endpoint URL.");
                if (!apiKeyPresent)
                    return (false, $"Enter an API key for {Providers.DisplayName(cfg.ApiProvider)}.");
                return (true, "OK");

            case AppConnectionType.LocalServer:
                if (string.IsNullOrWhiteSpace(cfg.LocalServerUrl))
                    return (false, "Enter the local server URL (e.g. http://127.0.0.1:1234/v1).");
                return (true, "OK");

            case AppConnectionType.LocalAI:
                return LocalLlmRuntime.ValidateGgufPath(cfg.LocalAIModelPath);

            default:
                return (false, $"Unsupported connection type: {cfg.ConnectionType}");
        }
    }
}
