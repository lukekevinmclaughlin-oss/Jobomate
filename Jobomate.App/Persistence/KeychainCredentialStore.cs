using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Jobomate.Persistence;

/// <summary>
/// macOS implementation of <see cref="ICredentialStore"/>. Secrets live in the
/// login Keychain as a single generic-password item whose data is the same
/// JSON dictionary <see cref="DpapiCredentialStore"/> keeps on disk on Windows
/// (keys: <c>apikey_*</c>, <c>github_token</c>, <c>cloud_token_*</c>,
/// <c>oauth_*</c>). Keeping the dictionary shape identical means the on-Keychain
/// layout matches the legacy on-disk layout key-for-key, and the AppServices
/// credential helper and this seam read/write the same item.
///
/// No secret is ever written to a plaintext file on macOS — that is the whole
/// point of this adapter (the cross-platform DpapiCredentialStore falls back to
/// plaintext JSON off Windows, which this replaces).
/// </summary>
public sealed class KeychainCredentialStore : ICredentialStore
{
    public const string Service = "com.jobomate.credentials";
    public const string Account = "store";

    private readonly object _gate = new();
    private readonly string _service;
    private readonly string _account;

    // Production callers use the default item; tests pass a unique account so
    // they never read or mutate the user's real Keychain entry.
    public KeychainCredentialStore(string? service = null, string? account = null)
    {
        _service = service ?? Service;
        _account = account ?? Account;
    }

    public string? GetApiKey(string provider) => WithStore(s =>
        s.TryGetValue("apikey_" + provider, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null);

    public string? GetOAuthAccessToken(string provider) => WithStore(s =>
    {
        if (!s.TryGetValue("oauth_" + provider, out var v)) return null;
        if (v.ValueKind == JsonValueKind.String) return v.GetString();
        if (v.ValueKind == JsonValueKind.Object && v.TryGetProperty("AccessToken", out var a)) return a.GetString();
        if (v.ValueKind == JsonValueKind.Object && v.TryGetProperty("accessToken", out var a2)) return a2.GetString();
        return null;
    });

    public string? GetGitHubToken() => WithStore(s =>
        s.TryGetValue("github_token", out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null);

    public string? GetCloudToken(string provider) => WithStore(s =>
        s.TryGetValue("cloud_token_" + provider, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null);

    public void StoreApiKey(string provider, string key) =>
        WithStore(s => s["apikey_" + provider] = StringElement(key), save: true);

    public void StoreGitHubToken(string token) =>
        WithStore(s => s["github_token"] = StringElement(token), save: true);

    public void StoreCloudToken(string provider, string token) =>
        WithStore(s => s["cloud_token_" + provider] = StringElement(token), save: true);

    public void DeleteApiKey(string provider) =>
        WithStore(s => s.Remove("apikey_" + provider), save: true);

    public void DeleteGitHubToken() =>
        WithStore(s => s.Remove("github_token"), save: true);

    public void DeleteCloudToken(string provider) =>
        WithStore(s => s.Remove("cloud_token_" + provider), save: true);

    public IReadOnlyCollection<string> Keys() =>
        WithStore(s => (IReadOnlyCollection<string>)s.Keys.ToArray());

    private static JsonElement StringElement(string value)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(value));
        return document.RootElement.Clone();
    }

    private T WithStore<T>(Func<Dictionary<string, JsonElement>, T> action, bool save = false)
    {
        lock (_gate)
        {
            var store = Load();
            var result = action(store);
            if (save) Save(store);
            return result;
        }
    }

    private Dictionary<string, JsonElement> Load()
    {
        try
        {
            var bytes = MacKeychain.Get(_service, _account);
            if (bytes is null || bytes.Length == 0) return new();
            return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(Encoding.UTF8.GetString(bytes)) ?? new();
        }
        catch (Exception ex)
        {
            // A transient keychain failure (lock contention, ACL prompt timeout, OSStatus) was
            // previously indistinguishable from an empty store, which made missing-provider-key
            // symptoms confusing. Surface it to stderr so the failure mode is observable. The
            // exception never contains the secret blob itself — only OSStatus codes / messages.
            Console.Error.WriteLine($"[keychain] load failed, treating store as empty: {ex.GetType().Name}: {ex.Message}");
            return new();
        }
    }

    private void Save(Dictionary<string, JsonElement> store)
    {
        var json = JsonSerializer.Serialize(store, new JsonSerializerOptions { WriteIndented = true });
        MacKeychain.Set(_service, _account, Encoding.UTF8.GetBytes(json));
    }
}
