using Jobomate.Engine;
using Xunit;

namespace Jobomate.Tests;

/// <summary>
/// Covers the fit-score response parser — the deterministic core of /api/jobs/score.
/// The LLM is asked to reply "SCORE: n / EXPLANATION: ...", which this parses + clamps.
/// </summary>
public class FitScoreTests
{
    [Fact]
    public void ParseFitResponse_ReadsScoreAndExplanation()
    {
        var (score, explanation) = JobomateEngine.ParseFitResponse(
            "SCORE: 82\nEXPLANATION: Strong backend match with overlapping cloud skills.");

        Assert.Equal(82d, score);
        Assert.Equal("Strong backend match with overlapping cloud skills.", explanation);
    }

    [Fact]
    public void ParseFitResponse_ClampsAboveHundred()
    {
        var (score, _) = JobomateEngine.ParseFitResponse("SCORE: 150\nEXPLANATION: too eager");
        Assert.Equal(100d, score);
    }

    [Theory]
    [InlineData("no numbers here")]
    [InlineData("")]
    [InlineData(null)]
    public void ParseFitResponse_NoScore_DefaultsToZero(string? resp)
    {
        var (score, explanation) = JobomateEngine.ParseFitResponse(resp);
        Assert.Equal(0d, score);
        Assert.Equal("", explanation);
    }

    [Fact]
    public void ParseFitResponse_ToleratesExtraProseAndWhitespace()
    {
        var (score, explanation) = JobomateEngine.ParseFitResponse(
            "Here is my assessment.\n\nSCORE:   45\n\nEXPLANATION:  Partial overlap only.  ");

        Assert.Equal(45d, score);
        Assert.Equal("Partial overlap only.", explanation);
    }
}
