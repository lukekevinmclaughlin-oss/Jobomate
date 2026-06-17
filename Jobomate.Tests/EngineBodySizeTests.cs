using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jobomate.Engine;
using Xunit;

namespace Jobomate.Tests;

/// <summary>
/// The engine reads request bodies off a loopback HTTP listener. A previous version relied solely
/// on Content-Length to cap the body, which let a chunked/streamed sender (no Content-Length) push
/// unbounded bytes into ReadToEndAsync. These tests pin the byte-capped read so that path can never
/// spike memory again.
/// </summary>
public class EngineBodySizeTests
{
    private static Stream StreamOf(string text) => new MemoryStream(Encoding.UTF8.GetBytes(text));

    [Fact]
    public async Task ReadBody_EmptyStream_ReturnsDefault()
    {
        var el = await EngineServer.ReadBody(StreamOf(""), Encoding.UTF8, 1024);
        Assert.Equal(default, el);
    }

    [Fact]
    public async Task ReadBody_WhitespaceOnly_ReturnsDefault()
    {
        var el = await EngineServer.ReadBody(StreamOf("   \n  "), Encoding.UTF8, 1024);
        Assert.Equal(default, el);
    }

    [Fact]
    public async Task ReadBody_ValidJson_ReturnsRootElement()
    {
        var el = await EngineServer.ReadBody(StreamOf("{\"goal\":\"find jobs\"}"), Encoding.UTF8, 1024);
        Assert.Equal(JsonValueKind.Object, el.ValueKind);
        Assert.Equal("find jobs", el.GetProperty("goal").GetString());
    }

    [Fact]
    public async Task ReadBody_InvalidJson_ReturnsDefault()
    {
        // Historical behavior: unparseable bodies are treated as "no body" rather than 400ing,
        // because the route layer's S()/Arr()/etc. helpers all guard on ValueKind == Object.
        var el = await EngineServer.ReadBody(StreamOf("not json at all"), Encoding.UTF8, 1024);
        Assert.Equal(default, el);
    }

    [Fact]
    public async Task ReadBody_WithinCap_ReturnsRootElement()
    {
        // Cap = exactly the byte count of the payload; the body fits.
        var payload = "{\"x\":\"" + new string('a', 200) + "\"}";
        var el = await EngineServer.ReadBody(StreamOf(payload), Encoding.UTF8, payload.Length);
        Assert.Equal(JsonValueKind.Object, el.ValueKind);
    }

    [Fact]
    public async Task ReadBody_ExceedingCap_Throws_AndDoesNotConsumeFullPayload()
    {
        // Reproduces the original bug: a streamed body without Content-Length must still be capped.
        var cap = 64L;
        var oversized = new string('x', 10_000);

        var ex = await Assert.ThrowsAsync<InvalidDataException>(
            () => EngineServer.ReadBody(StreamOf(oversized), Encoding.UTF8, cap));

        Assert.Contains("exceeds", ex.Message);
        Assert.Contains(cap.ToString(), ex.Message);
    }

    [Fact]
    public async Task ReadBody_Boundary_ExactlyAtCap_IsAccepted()
    {
        // Payload length == cap is allowed (the check is strict-greater-than).
        var payload = "{\"ok\":true}";
        var el = await EngineServer.ReadBody(StreamOf(payload), Encoding.UTF8, payload.Length);
        Assert.Equal(JsonValueKind.Object, el.ValueKind);
        Assert.True(el.GetProperty("ok").GetBoolean());
    }
}
