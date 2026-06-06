using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Persistence;

namespace Jobomate.Email;

public sealed record OAuthEndpoints(string AuthorizationUrl, string TokenUrl);

public sealed record OAuthTokens(string AccessToken, string? RefreshToken, DateTimeOffset ExpiresAt);

public static class OAuthEndpointsCatalog
{
    public static readonly OAuthEndpoints Google = new(
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token");

    public static OAuthEndpoints Microsoft(string tenant = "common") => new(
        $"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
        $"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token");

    public static readonly string[] GmailScopes = { "https://mail.google.com/", "email" };
    public static readonly string[] GraphScopes = { "offline_access", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/User.Read" };
}

/// <summary>
/// OAuth 2.0 Authorization Code + PKCE via a loopback redirect (HttpListener). Fully
/// functional once the user supplies their own registered client id (and secret, if the
/// provider requires one). Refresh tokens are stored in the Keychain by the token manager.
/// </summary>
public static class OAuthFlow
{
    public static async Task<OAuthTokens> AuthorizeAsync(
        OAuthEndpoints endpoints, string clientId, string? clientSecret, IReadOnlyList<string> scopes, CancellationToken ct = default)
    {
        var (verifier, challenge) = Pkce();
        var state = RandomUrlToken(24);
        var port = FreeLoopbackPort();
        var redirect = $"http://127.0.0.1:{port}/";

        using var listener = new HttpListener();
        listener.Prefixes.Add(redirect);
        listener.Start();
        try
        {
            var authUrl = endpoints.AuthorizationUrl + "?" + BuildQuery(new Dictionary<string, string>
            {
                ["client_id"] = clientId,
                ["redirect_uri"] = redirect,
                ["response_type"] = "code",
                ["scope"] = string.Join(" ", scopes),
                ["code_challenge"] = challenge,
                ["code_challenge_method"] = "S256",
                ["state"] = state,
                ["access_type"] = "offline",
                ["prompt"] = "consent",
            });

            OpenBrowser(authUrl);

            var contextTask = listener.GetContextAsync();
            var winner = await Task.WhenAny(contextTask, Task.Delay(TimeSpan.FromMinutes(5), ct)).ConfigureAwait(false);
            if (winner != contextTask) throw new TimeoutException("OAuth sign-in timed out.");

            var context = await contextTask.ConfigureAwait(false);
            var code = context.Request.QueryString["code"];
            var returnedState = context.Request.QueryString["state"];
            var error = context.Request.QueryString["error"];
            RespondHtml(context, "<html><body style='font-family:-apple-system,sans-serif;padding:40px'>" +
                "<h2>Jobomate is connected.</h2><p>You can close this tab and return to the app.</p></body></html>");

            if (returnedState != state) throw new InvalidOperationException("OAuth state mismatch — aborting.");
            if (string.IsNullOrEmpty(code)) throw new InvalidOperationException("No authorization code returned: " + error);

            return await ExchangeAsync(endpoints, clientId, clientSecret, redirect, code!, verifier, ct).ConfigureAwait(false);
        }
        finally
        {
            listener.Stop();
        }
    }

    public static Task<OAuthTokens> RefreshAsync(
        OAuthEndpoints endpoints, string clientId, string? clientSecret, string refreshToken, CancellationToken ct = default)
    {
        var form = new Dictionary<string, string>
        {
            ["client_id"] = clientId,
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refreshToken,
        };
        if (!string.IsNullOrEmpty(clientSecret)) form["client_secret"] = clientSecret!;
        return PostTokenAsync(endpoints, form, refreshToken, ct);
    }

    private static Task<OAuthTokens> ExchangeAsync(
        OAuthEndpoints endpoints, string clientId, string? clientSecret, string redirect, string code, string verifier, CancellationToken ct)
    {
        var form = new Dictionary<string, string>
        {
            ["client_id"] = clientId,
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = redirect,
            ["code_verifier"] = verifier,
        };
        if (!string.IsNullOrEmpty(clientSecret)) form["client_secret"] = clientSecret!;
        return PostTokenAsync(endpoints, form, null, ct);
    }

    private static async Task<OAuthTokens> PostTokenAsync(
        OAuthEndpoints endpoints, Dictionary<string, string> form, string? fallbackRefresh, CancellationToken ct)
    {
        using var http = new HttpClient();
        using var resp = await http.PostAsync(endpoints.TokenUrl, new FormUrlEncodedContent(form), ct).ConfigureAwait(false);
        var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode) throw new InvalidOperationException("OAuth token endpoint error: " + json);

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var access = root.GetProperty("access_token").GetString()!;
        var refresh = root.TryGetProperty("refresh_token", out var r) ? r.GetString() : fallbackRefresh;
        var expiresIn = root.TryGetProperty("expires_in", out var e) ? e.GetInt32() : 3600;
        return new OAuthTokens(access, refresh, DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, expiresIn) - 60));
    }

    private static (string Verifier, string Challenge) Pkce()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        var verifier = Base64Url(bytes);
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        return (verifier, challenge);
    }

    private static string RandomUrlToken(int bytes) => Base64Url(RandomNumberGenerator.GetBytes(bytes));

    private static string Base64Url(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static int FreeLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string BuildQuery(Dictionary<string, string> values) =>
        string.Join("&", values.Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value)}"));

    private static void RespondHtml(HttpListenerContext context, string html)
    {
        var buffer = Encoding.UTF8.GetBytes(html);
        context.Response.ContentType = "text/html";
        context.Response.ContentLength64 = buffer.Length;
        context.Response.OutputStream.Write(buffer, 0, buffer.Length);
        context.Response.OutputStream.Close();
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) Process.Start("open", url);
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            else Process.Start("xdg-open", url);
        }
        catch { /* user can paste the URL manually if needed */ }
    }
}

/// <summary>Caches access tokens and refreshes them; persists the refresh token in the Keychain.</summary>
public sealed class OAuthTokenManager
{
    private readonly OAuthEndpoints _endpoints;
    private readonly string _clientId;
    private readonly string? _clientSecret;
    private readonly ICredentialStore _store;
    private readonly string _refreshKey;
    private OAuthTokens? _cached;

    public OAuthTokenManager(OAuthEndpoints endpoints, string clientId, string? clientSecret, ICredentialStore store, string refreshKey)
    {
        _endpoints = endpoints;
        _clientId = clientId;
        _clientSecret = clientSecret;
        _store = store;
        _refreshKey = refreshKey;
    }

    public bool IsConnected => !string.IsNullOrEmpty(_store.GetCloudToken(_refreshKey));

    public async Task<OAuthTokens> SignInAsync(IReadOnlyList<string> scopes, CancellationToken ct = default)
    {
        var tokens = await OAuthFlow.AuthorizeAsync(_endpoints, _clientId, _clientSecret, scopes, ct).ConfigureAwait(false);
        if (!string.IsNullOrEmpty(tokens.RefreshToken)) _store.StoreCloudToken(_refreshKey, tokens.RefreshToken!);
        _cached = tokens;
        return tokens;
    }

    public async Task<string> GetAccessTokenAsync(CancellationToken ct = default)
    {
        if (_cached is not null && _cached.ExpiresAt > DateTimeOffset.UtcNow) return _cached.AccessToken;

        var refresh = _store.GetCloudToken(_refreshKey)
            ?? throw new InvalidOperationException("This account is not connected yet. Run OAuth sign-in first.");

        _cached = await OAuthFlow.RefreshAsync(_endpoints, _clientId, _clientSecret, refresh, ct).ConfigureAwait(false);
        if (!string.IsNullOrEmpty(_cached.RefreshToken)) _store.StoreCloudToken(_refreshKey, _cached.RefreshToken!);
        return _cached.AccessToken;
    }
}
