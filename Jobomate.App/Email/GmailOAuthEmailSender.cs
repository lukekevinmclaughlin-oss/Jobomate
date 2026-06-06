using System;
using System.Threading;
using System.Threading.Tasks;
using MailKit.Net.Smtp;
using MailKit.Security;

namespace Jobomate.Email;

/// <summary>
/// Sends through the user's own Gmail account using OAuth2 (XOAUTH2 over MailKit SMTP).
/// Fully implemented; it works once the user has completed OAuth sign-in with their own
/// registered Google client id (handled by <see cref="OAuthTokenManager"/>).
/// </summary>
public sealed class GmailOAuthEmailSender : IEmailSender
{
    private readonly string _fromAddress;
    private readonly Func<CancellationToken, Task<string>> _accessToken;

    public GmailOAuthEmailSender(string fromAddress, Func<CancellationToken, Task<string>> accessTokenProvider)
    {
        _fromAddress = fromAddress;
        _accessToken = accessTokenProvider;
    }

    public string Name => "Gmail (OAuth)";
    public bool IsDryRun => false;

    public async Task<EmailSendResult> SendAsync(OutgoingEmail email, CancellationToken ct = default)
    {
        try
        {
            var token = await _accessToken(ct).ConfigureAwait(false);
            using var client = new SmtpClient();
            await client.ConnectAsync("smtp.gmail.com", 587, SecureSocketOptions.StartTls, ct).ConfigureAwait(false);
            await client.AuthenticateAsync(new SaslMechanismOAuth2(_fromAddress, token), ct).ConfigureAwait(false);
            await client.SendAsync(MimeFactory.Build(email), ct).ConfigureAwait(false);
            await client.DisconnectAsync(true, ct).ConfigureAwait(false);
            return new EmailSendResult(true, EmailErrorKind.None, "Sent via Gmail (OAuth).");
        }
        catch (AuthenticationException ex)
        {
            return new EmailSendResult(false, EmailErrorKind.Auth, ex.Message);
        }
        catch (SmtpCommandException ex)
        {
            return new EmailSendResult(false, SmtpEmailSender.ClassifySmtp((int)ex.StatusCode), ex.Message);
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
            using var client = new SmtpClient();
            await client.ConnectAsync("smtp.gmail.com", 587, SecureSocketOptions.StartTls, ct).ConfigureAwait(false);
            await client.AuthenticateAsync(new SaslMechanismOAuth2(_fromAddress, token), ct).ConfigureAwait(false);
            await client.DisconnectAsync(true, ct).ConfigureAwait(false);
            return new EmailTestResult(true, "Gmail OAuth login succeeded.");
        }
        catch (Exception ex)
        {
            return new EmailTestResult(false, ex.Message);
        }
    }
}
