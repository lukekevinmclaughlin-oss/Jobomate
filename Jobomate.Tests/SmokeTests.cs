using Xunit;

namespace Jobomate.Tests;

/// <summary>Confirms the test harness wires up against the app assembly.</summary>
public class SmokeTests
{
    [Fact]
    public void TestHarness_Runs()
    {
        Assert.True(true);
    }
}
