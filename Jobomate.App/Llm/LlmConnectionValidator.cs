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
                if ((cfg.ApiProvider == AppApiProvider.Custom || cfg.ApiProvider == AppApiProvider.AzureOpenAI)
                    && string.IsNullOrWhiteSpace(cfg.CustomEndpoint))
                    return (false, "Enter the endpoint URL.");
                if (Providers.RequiresApiToken(cfg.ApiProvider) && !apiKeyPresent)
                    return (false, $"Enter an API key for {Providers.DisplayName(cfg.ApiProvider)} (or set its environment variable).");
                return (true, "OK");

            case AppConnectionType.LocalServer:
                if (string.IsNullOrWhiteSpace(cfg.LocalServerUrl))
                    return (false, "Enter the local server URL (e.g. http://127.0.0.1:1234/v1).");
                return (true, "OK");

            case AppConnectionType.LocalAI:
                return LocalLlmRuntime.ValidateGgufPath(cfg.LocalAIModelPath);

            case AppConnectionType.CliPipe:
                return string.IsNullOrWhiteSpace(cfg.CliCommand)
                    ? (false, "Enter a CLI command template (use {prompt} for the prompt).") : (true, "OK");

            case AppConnectionType.Terminal:
                return string.IsNullOrWhiteSpace(cfg.TerminalCommand)
                    ? (false, "Enter a terminal command template.") : (true, "OK");

            case AppConnectionType.OAuth:
                if (string.IsNullOrWhiteSpace(cfg.OAuthClientId)) return (false, "Enter the OAuth client id.");
                if (string.IsNullOrWhiteSpace(cfg.CustomEndpoint)) return (false, "Enter the OAuth endpoint URL.");
                return (true, "OK");

            default:
                return (false, $"Unsupported connection type: {cfg.ConnectionType}");
        }
    }
}
