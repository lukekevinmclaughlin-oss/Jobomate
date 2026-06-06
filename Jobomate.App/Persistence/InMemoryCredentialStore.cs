using System.Collections.Generic;

namespace Jobomate.Persistence;

/// <summary>
/// Non-persistent credential store used by tests and as a safe fallback on
/// non-macOS hosts. Mirrors <see cref="KeychainCredentialStore"/>'s contract but
/// keeps everything in process memory — nothing is written to disk.
/// </summary>
public sealed class InMemoryCredentialStore : ICredentialStore
{
    private readonly Dictionary<string, string> _values = new();
    private readonly object _gate = new();

    private const string GitHubKey = "github_token";

    public string? GetApiKey(string provider) => Read("apikey_" + provider);
    public string? GetOAuthAccessToken(string provider) => Read("oauth_" + provider);
    public string? GetGitHubToken() => Read(GitHubKey);
    public string? GetCloudToken(string provider) => Read("cloud_" + provider);

    public void StoreApiKey(string provider, string key) => Write("apikey_" + provider, key);
    public void StoreGitHubToken(string token) => Write(GitHubKey, token);
    public void StoreCloudToken(string provider, string token) => Write("cloud_" + provider, token);

    public void DeleteApiKey(string provider) => Remove("apikey_" + provider);
    public void DeleteGitHubToken() => Remove(GitHubKey);
    public void DeleteCloudToken(string provider) => Remove("cloud_" + provider);

    public IReadOnlyCollection<string> Keys()
    {
        lock (_gate) return new List<string>(_values.Keys);
    }

    private string? Read(string key)
    {
        lock (_gate) return _values.TryGetValue(key, out var v) ? v : null;
    }

    private void Write(string key, string value)
    {
        lock (_gate) _values[key] = value;
    }

    private void Remove(string key)
    {
        lock (_gate) _values.Remove(key);
    }
}
