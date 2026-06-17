using Jobomate.Security;
using Xunit;

namespace Jobomate.Tests;

/// <summary>
/// The redactor is the last line of defense before agent turns and audit rows hit disk. A regression
/// in any pattern silently leaks credentials, so each rule is pinned here together with negative
/// cases that confirm ordinary text passes through untouched.
/// </summary>
public class SecretRedactorTests
{
    // ---- per-rule positive cases ----

    [Theory]
    [InlineData("sk-abcdefghijklmnopqrstuvwxyz", "<api-key>")]
    [InlineData("sk-1234567890abcdef", "<api-key>")]
    [InlineData("sk-proj-abcdef1234567890", "<api-key>")]
    [InlineData("sk-ant-abcdefghijklmnopqrstuvwxyz", "<api-key>")]
    public void Redact_ReplacesOpenAiAndAnthropicKeys(string key, string expected)
    {
        Assert.Equal(expected, SecretRedactor.Redact(key));
    }

    [Theory]
    [InlineData("ghp_abcdefghijklmnopqrstuvwxyz", "<github-token>")]
    [InlineData("gho_abcdefghijklmnopqrstuvwxyz", "<github-token>")]
    [InlineData("ghu_abcdefghijklmnopqrstuvwxyz", "<github-token>")]
    [InlineData("ghr_abcdefghijklmnopqrstuvwxyz", "<github-token>")]
    [InlineData("ghs_abcdefghijklmnopqrstuvwxyz", "<github-token>")]
    public void Redact_ReplacesGitHubPats(string token, string expected)
    {
        Assert.Equal(expected, SecretRedactor.Redact(token));
    }

    [Theory]
    [InlineData("Bearer ya29.abcdef1234567890", "Bearer <bearer>")]
    [InlineData("bearer ya29.abcdef1234567890", "Bearer <bearer>")]
    public void Redact_ReplacesBearerAuthorizationHeader(string input, string expected)
    {
        Assert.Equal(expected, SecretRedactor.Redact(input));
    }

    [Fact]
    public void Redact_ReplacesXApiKeyInsideJsonString()
    {
        // The rule matches the value inside a JSON string literal of the form `"x-api-key": "..."`.
        var json = "{\"x-api-key\": \"sk-ant-abcdef1234567890\", \"model\": \"claude-3\"}";
        var redacted = SecretRedactor.Redact(json);
        Assert.Contains("\"x-api-key\": \"<api-key>\"", redacted);
        Assert.Contains("\"model\": \"claude-3\"", redacted);
        Assert.DoesNotContain("sk-ant-abcdef1234567890", redacted);
    }

    [Fact]
    public void Redact_ReplacesGoogleOAuthAccessToken()
    {
        Assert.Equal("<oauth-token>", SecretRedactor.Redact("ya29.abcdefghijklmnopqrstuvwxyz"));
    }

    [Fact]
    public void Redact_ReplacesAwsAccessKeyId()
    {
        Assert.Equal("<aws-access-key-id>", SecretRedactor.Redact("AKIAIOSFODNN7EXAMPLE"));
    }

    // ---- embedding inside prose ----

    [Fact]
    public void Redact_ReplacesAllOccurrencesInFreeText()
    {
        var prose = "I tried key sk-abcdefghijklmnopqrstuvwxyz but it failed. Try ghp_abcdefghijklmnopqrstuvwxyz instead.";
        var redacted = SecretRedactor.Redact(prose);
        Assert.DoesNotContain("sk-abcdef", redacted);
        Assert.DoesNotContain("ghp_abcdef", redacted);
        Assert.Contains("<api-key>", redacted);
        Assert.Contains("<github-token>", redacted);
    }

    // ---- negative cases (must NOT be touched) ----

    [Theory]
    [InlineData("")]                        // empty
    [InlineData("plain text without secrets")]
    [InlineData("https://example.com/path?query=value")]
    [InlineData("user@example.com")]
    [InlineData("my order id is 1234567890")]                 // not a secret shape
    [InlineData("the key was too short sk-abcd")]              // <16 trailing chars, must NOT match
    [InlineData("AKIA123")]                                    // too short for the 16-char tail
    public void Redact_LeavesNonSecretTextUntouched(string input)
    {
        Assert.Equal(input, SecretRedactor.Redact(input));
    }

    // ---- null safety ----

    [Fact]
    public void Redact_Null_ReturnsEmptyString()
    {
        Assert.Equal("", SecretRedactor.Redact(null));
    }
}
