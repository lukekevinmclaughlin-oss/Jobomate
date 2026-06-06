using System;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jobomate.Sources;

/// <summary>Tiny resilient JSON GET helper — returns null on any failure (never throws).</summary>
public static class JsonHttp
{
    public static async Task<JsonDocument?> GetAsync(
        HttpClient http, string url, CancellationToken ct, params (string Key, string Value)[] headers)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("Accept", "application/json");
            req.Headers.TryAddWithoutValidation("User-Agent",
                "Jobomate/1.0 (+https://github.com/lukekevinmclaughlin-oss/Jobomate)");
            foreach (var (k, v) in headers) req.Headers.TryAddWithoutValidation(k, v);

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return null;

            var s = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return JsonDocument.Parse(s);
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>JsonElement convenience accessors.</summary>
public static class JsonX
{
    public static string Str(JsonElement el, string prop) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? ""
            : "";

    public static string NestedStr(JsonElement el, string prop, string child)
    {
        if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty(prop, out var inner) && inner.ValueKind == JsonValueKind.Object)
            return Str(inner, child);
        return "";
    }

    public static DateOnly? IsoDate(JsonElement el, string prop)
    {
        var s = Str(el, prop);
        return DateOnly.TryParse(s, out var d) ? d : (DateTime.TryParse(s, out var dt) ? DateOnly.FromDateTime(dt) : null);
    }

    public static DateOnly? UnixDate(JsonElement el, string prop)
    {
        if (el.TryGetProperty(prop, out var v))
        {
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var unix))
                return DateOnly.FromDateTime(DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime);
            if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var unixStr))
                return DateOnly.FromDateTime(DateTimeOffset.FromUnixTimeSeconds(unixStr).UtcDateTime);
        }
        return null;
    }

    public static string Prettify(string slug) =>
        string.Join(' ', (slug ?? "").Replace('-', ' ').Replace('_', ' ').Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(w => w.Length == 0 ? w : char.ToUpperInvariant(w[0]) + w[1..]));
}
