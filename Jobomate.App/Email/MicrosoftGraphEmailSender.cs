using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jobomate.Email;

/// <summary>
/// Sends through the user's own Microsoft 365 account via Microsoft Graph
/// <c>/me/sendMail</c>. Fully implemented; works once the user has completed OAuth sign-in
/// with their own registered Azure app (handled by <see cref="OAuthTokenManager"/>).
/// </summary>
public sealed class MicrosoftGraphEmailSender : IEmailSender
{
    private const string SendMailUrl = "https://graph.microsoft.com/v1.0/me/sendMail";

    private readonly Func<CancellationToken, Task<string>> _accessToken;

    public MicrosoftGraphEmailSender(Func<CancellationToken, Task<string>> accessTokenProvider)
    {
        _accessToken = accessTokenProvider;
    }

    public string Name => "Microsoft 365 (Graph)";
    public bool IsDryRun => false;

    public async Task<EmailSendResult> SendAsync(OutgoingEmail email, CancellationToken ct = default)
    {
        try
        {
            var token = await _accessToken(ct).ConfigureAwait(false);
            using var http = new HttpClient();
            using var req = new HttpRequestMessage(HttpMethod.Post, SendMailUrl);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Content = new StringContent(JsonSerializer.Serialize(BuildPayload(email)), Encoding.UTF8, "application/json");

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.StatusCode == HttpStatusCode.Accepted || resp.IsSuccessStatusCode)
                return new EmailSendResult(true, EmailErrorKind.None, "Sent via Microsoft Graph.");

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            var kind = resp.StatusCode switch
            {
                HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => EmailErrorKind.Auth,
                HttpStatusCode.TooManyRequests => EmailErrorKind.Throttle,
                >= HttpStatusCode.InternalServerError => EmailErrorKind.Transient,
                _ => EmailErrorKind.Permanent,
            };
            return new EmailSendResult(false, kind, $"Graph {(int)resp.StatusCode}: {body}");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new EmailSendResult(false, EmailErrorKind.Transient, ex.Message);
        }
    }

    public async Task<EmailTestResult> TestAsync(CancellationToken ct = default)
    {
        try
        {
            var token = await _accessToken(ct).ConfigureAwait(false);
            using var http = new HttpClient();
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://graph.microsoft.com/v1.0/me");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            return resp.IsSuccessStatusCode
                ? new EmailTestResult(true, "Microsoft Graph token is valid.")
                : new EmailTestResult(false, $"Graph {(int)resp.StatusCode}: {await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false)}");
        }
        catch (Exception ex)
        {
            return new EmailTestResult(false, ex.Message);
        }
    }

    private static object BuildPayload(OutgoingEmail email)
    {
        var attachments = new List<object>();
        foreach (var path in email.Attachments)
        {
            if (!File.Exists(path)) continue;
            attachments.Add(new Dictionary<string, object>
            {
                ["@odata.type"] = "#microsoft.graph.fileAttachment",
                ["name"] = Path.GetFileName(path),
                ["contentType"] = path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? "application/pdf" : "application/octet-stream",
                ["contentBytes"] = Convert.ToBase64String(File.ReadAllBytes(path)),
            });
        }

        return new Dictionary<string, object>
        {
            ["message"] = new Dictionary<string, object>
            {
                ["subject"] = email.Subject,
                ["body"] = new Dictionary<string, object> { ["contentType"] = "Text", ["content"] = email.Body },
                ["toRecipients"] = new[]
                {
                    new Dictionary<string, object>
                    {
                        ["emailAddress"] = new Dictionary<string, object> { ["address"] = email.ToAddress },
                    },
                },
                ["attachments"] = attachments,
            },
            ["saveToSentItems"] = true,
        };
    }
}
