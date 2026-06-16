using Jobomate.Engine;
using Xunit;

namespace Jobomate.Tests;

/// <summary>
/// Covers the loopback engine's session-token gate. The packaged app always supplies a token via
/// JOBOMATE_ENGINE_TOKEN, so any web page the in-app browser visits is rejected (401) cross-origin.
/// </summary>
public class EngineAuthTests
{
    [Fact]
    public void TokensEqual_MatchingToken_ReturnsTrue()
    {
        Assert.True(EngineServer.TokensEqual("s3cret-abc123", "s3cret-abc123"));
    }

    [Theory]
    [InlineData("wrong", "s3cret")]
    [InlineData("s3cret", "s3secret")] // different length
    [InlineData("", "s3cret")]
    [InlineData(null, "s3cret")]
    [InlineData("s3cret", "")] // engine has no token configured -> nothing matches
    public void TokensEqual_NonMatching_ReturnsFalse(string? presented, string expected)
    {
        Assert.False(EngineServer.TokensEqual(presented, expected));
    }
}
