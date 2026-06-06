using System;
using System.Linq;
using Jobomate.Contracts;
using Jobomate.Llm;
using Xunit;

namespace Jobomate.Tests;

public class ConnectionPlumbingTests
{
    [Fact]
    public void ProviderTable_CoversEveryProvider_WithAnAdapter()
    {
        foreach (var p in Enum.GetValues<AppApiProvider>())
        {
            var info = Providers.Info(p);
            Assert.False(string.IsNullOrWhiteSpace(info.Adapter), $"{p} has no adapter");
        }
        // The full MAOS set is large (cloud + local runtimes).
        Assert.True(Enum.GetValues<AppApiProvider>().Length >= 30);
    }

    [Theory]
    [InlineData(AppApiProvider.OpenAI, true)]
    [InlineData(AppApiProvider.Custom, false)]
    [InlineData(AppApiProvider.LocalAIEndpoint, false)]
    [InlineData(AppApiProvider.KoboldCpp, false)]
    public void RequiresApiToken_LocalProvidersDoNot(AppApiProvider p, bool expected)
    {
        Assert.Equal(expected, Providers.RequiresApiToken(p));
    }

    [Theory]
    [InlineData(AppApiProvider.OpenAI, "o3-mini", true)]
    [InlineData(AppApiProvider.OpenAI, "gpt-4o", false)]
    [InlineData(AppApiProvider.Anthropic, "claude-opus-4-20250101", true)]
    [InlineData(AppApiProvider.Mistral, "mistral-large-latest", false)]
    public void SupportsReasoningEffort_IsModelAware(AppApiProvider p, string model, bool expected)
    {
        Assert.Equal(expected, Providers.SupportsReasoningEffort(p, model));
    }

    [Theory]
    [InlineData("max", "high")]
    [InlineData("minimal", "low")]
    [InlineData("normal", "medium")]
    public void ReasoningEffortApiValue_Normalizes(string input, string expected)
    {
        Assert.Equal(expected, Providers.ReasoningEffortApiValue(input));
    }

    [Fact]
    public void OAuthDefaults_KnownProviders_HaveEndpoints()
    {
        var g = Providers.OAuthDefaults(AppOAuthProviderType.GoogleVertex);
        Assert.Contains("google", g.AuthUrl);
        Assert.False(string.IsNullOrWhiteSpace(g.TokenUrl));
    }

    [Fact]
    public void Validate_CliPipe_RequiresCommand()
    {
        var cfg = new LlmConnectionConfig { ConnectionType = AppConnectionType.CliPipe, CliCommand = "" };
        Assert.False(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);
        cfg.CliCommand = "ollama run llama3 \"{prompt}\"";
        Assert.True(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);
    }

    [Fact]
    public void Validate_Terminal_RequiresCommand()
    {
        var cfg = new LlmConnectionConfig { ConnectionType = AppConnectionType.Terminal, TerminalCommand = "" };
        Assert.False(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);
        cfg.TerminalCommand = "my-llm --prompt {prompt}";
        Assert.True(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);
    }

    [Fact]
    public void Validate_OAuth_RequiresClientIdAndEndpoint()
    {
        var cfg = new LlmConnectionConfig { ConnectionType = AppConnectionType.OAuth };
        Assert.False(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);
        cfg.OAuthClientId = "abc";
        cfg.CustomEndpoint = "https://example/v1/chat/completions";
        Assert.True(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);
    }

    [Fact]
    public void ResolvedModel_FallsBackToProviderDefault()
    {
        var cfg = new LlmConnectionConfig { ConnectionType = AppConnectionType.ApiKey, ApiProvider = AppApiProvider.OpenAI, Model = "" };
        Assert.Equal("gpt-4o", cfg.ResolvedModel());
        cfg.Model = "gpt-4.1";
        Assert.Equal("gpt-4.1", cfg.ResolvedModel());
    }
}
