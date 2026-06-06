using System.Collections.Generic;

namespace Jobomate.Persistence;

/// <summary>
/// Typed surface for secrets. Implementations MUST keep secrets out of
/// plain text on Windows (DPAPI) and preserve the existing on-disk
/// format so existing <c>credentials.dat</c> blobs round-trip unchanged.
/// </summary>
public interface ICredentialStore
{
    /// <summary>Returns the stored API key for the given provider, or null if none.</summary>
    string? GetApiKey(string provider);

    /// <summary>Returns the stored OAuth access token for the given provider, or null if none.</summary>
    string? GetOAuthAccessToken(string provider);

    /// <summary>Returns the stored GitHub token, or null if none.</summary>
    string? GetGitHubToken();

    /// <summary>Returns the stored cloud-storage token for the given provider, or null if none.</summary>
    string? GetCloudToken(string provider);

    void StoreApiKey(string provider, string key);
    void StoreGitHubToken(string token);
    void StoreCloudToken(string provider, string token);

    void DeleteApiKey(string provider);
    void DeleteGitHubToken();
    void DeleteCloudToken(string provider);

    /// <summary>List of credential keys currently held (for diagnostics). Values never returned here.</summary>
    IReadOnlyCollection<string> Keys();
}
