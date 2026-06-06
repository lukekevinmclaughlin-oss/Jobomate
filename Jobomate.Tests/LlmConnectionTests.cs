using System.IO;
using Jobomate.Contracts;
using Jobomate.Llm;
using Jobomate.Llm.Local;
using Xunit;

namespace Jobomate.Tests;

public class LlmConnectionTests
{
    [Theory]
    [InlineData("http://127.0.0.1:1234", "http://127.0.0.1:1234/v1/chat/completions")]
    [InlineData("http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1/chat/completions")]
    [InlineData("http://127.0.0.1:1234/v1/", "http://127.0.0.1:1234/v1/chat/completions")]
    [InlineData("127.0.0.1:11434", "http://127.0.0.1:11434/v1/chat/completions")]
    [InlineData("http://localhost:1234/v1/chat/completions", "http://localhost:1234/v1/chat/completions")]
    public void NormalizeServerUrl_ProducesChatCompletionsEndpoint(string input, string expected)
    {
        Assert.Equal(expected, LocalLlmRuntime.NormalizeServerUrl(input));
    }

    [Fact]
    public void ValidateGgufPath_RejectsEmptyAndNonGguf()
    {
        Assert.False(LocalLlmRuntime.ValidateGgufPath("").Ok);
        Assert.False(LocalLlmRuntime.ValidateGgufPath("/tmp/model.bin").Ok);
        Assert.False(LocalLlmRuntime.ValidateGgufPath("/tmp/does-not-exist.gguf").Ok);
    }

    [Fact]
    public void ValidateGgufPath_AcceptsExistingGgufFile()
    {
        var path = Path.Combine(Path.GetTempPath(), $"jobomate-test-{System.Guid.NewGuid():n}.gguf");
        File.WriteAllText(path, "stub");
        try
        {
            Assert.True(LocalLlmRuntime.ValidateGgufPath(path).Ok);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Validate_ApiKey_RequiresKey()
    {
        var cfg = new LlmConnectionConfig { ConnectionType = AppConnectionType.ApiKey, ApiProvider = AppApiProvider.OpenAI };
        Assert.False(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);
        Assert.True(LlmConnectionValidator.Validate(cfg, apiKeyPresent: true).Ok);
    }

    [Fact]
    public void Validate_Custom_RequiresEndpoint()
    {
        var cfg = new LlmConnectionConfig { ConnectionType = AppConnectionType.ApiKey, ApiProvider = AppApiProvider.Custom };
        Assert.False(LlmConnectionValidator.Validate(cfg, apiKeyPresent: true).Ok);

        cfg.CustomEndpoint = "http://127.0.0.1:8080/v1/chat/completions";
        Assert.True(LlmConnectionValidator.Validate(cfg, apiKeyPresent: true).Ok);
    }

    [Fact]
    public void Validate_LocalServer_RequiresUrl()
    {
        var cfg = new LlmConnectionConfig { ConnectionType = AppConnectionType.LocalServer, LocalServerUrl = "" };
        Assert.False(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);

        cfg.LocalServerUrl = LocalLlmRuntime.LmStudioChat;
        Assert.True(LlmConnectionValidator.Validate(cfg, apiKeyPresent: false).Ok);
    }

    [Theory]
    [InlineData(AdapterNames.OpenAiCompatible, "{\"choices\":[{\"message\":{\"content\":\"Hello there\"}}]}", "Hello there")]
    [InlineData(AdapterNames.Anthropic, "{\"content\":[{\"type\":\"text\",\"text\":\"Claude says hi\"}]}", "Claude says hi")]
    [InlineData(AdapterNames.GoogleAi, "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Gemini hi\"}]}}]}", "Gemini hi")]
    public void ResponseTextExtractor_PullsAssistantText(string adapter, string json, string expected)
    {
        Assert.Equal(expected, ResponseTextExtractor.Extract(adapter, json));
    }
}
