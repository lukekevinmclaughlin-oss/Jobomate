using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using MailKit.Net.Smtp;
using MailKit.Security;
using MimeKit;

namespace Jobomate.Email;

/// <summary>Standard SMTP (works with Gmail app passwords and any provider). Uses MailKit.</summary>
public sealed class SmtpEmailSender : IEmailSender
{
    private readonly string _host;
    private readonly int _port;
    private readonly bool _startTls;
    private readonly string _username;
    private readonly string _password;

    public SmtpEmailSender(string host, int port, bool startTls, string username, string password)
    {
        _host = host;
        _port = port;
        _startTls = startTls;
        _username = username;
        _password = password;
    }

    public string Name => "SMTP";
    public bool IsDryRun => false;

    public async Task<EmailSendResult> SendAsync(OutgoingEmail email, CancellationToken ct = default)
    {
        try
        {
            using var client = new SmtpClient();
            await client.ConnectAsync(_host, _port, _startTls ? SecureSocketOptions.StartTls : SecureSocketOptions.Auto, ct).ConfigureAwait(false);
            await client.AuthenticateAsync(_username, _password, ct).ConfigureAwait(false);
            await client.SendAsync(MimeFactory.Build(email), ct).ConfigureAwait(false);
            await client.DisconnectAsync(true, ct).ConfigureAwait(false);
            return new EmailSendResult(true, EmailErrorKind.None, "Sent via SMTP.");
        }
        catch (AuthenticationException ex)
        {
            return new EmailSendResult(false, EmailErrorKind.Auth, ex.Message);
        }
        catch (SmtpCommandException ex)
        {
            return new EmailSendResult(false, ClassifySmtp((int)ex.StatusCode), $"SMTP {(int)ex.StatusCode}: {ex.Message}");
        }
        catch (SmtpProtocolException ex)
        {
            return new EmailSendResult(false, EmailErrorKind.Transient, ex.Message);
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
            using var client = new SmtpClient();
            await client.ConnectAsync(_host, _port, _startTls ? SecureSocketOptions.StartTls : SecureSocketOptions.Auto, ct).ConfigureAwait(false);
            await client.AuthenticateAsync(_username, _password, ct).ConfigureAwait(false);
            await client.DisconnectAsync(true, ct).ConfigureAwait(false);
            return new EmailTestResult(true, $"SMTP login to {_host} succeeded.");
        }
        catch (Exception ex)
        {
            return new EmailTestResult(false, ex.Message);
        }
    }

    internal static EmailErrorKind ClassifySmtp(int status) => status switch
    {
        421 or 450 or 451 or 452 => EmailErrorKind.Throttle,
        >= 500 and < 600 => EmailErrorKind.Bounce,
        _ => EmailErrorKind.Transient,
    };
}

/// <summary>Builds a MIME message (with file attachments) from an <see cref="OutgoingEmail"/>.</summary>
internal static class MimeFactory
{
    public static MimeMessage Build(OutgoingEmail email)
    {
        var message = new MimeMessage();
        message.From.Add(new MailboxAddress(email.FromName, email.FromAddress));
        message.To.Add(new MailboxAddress(email.ToName, email.ToAddress));
        message.Subject = email.Subject;

        var body = new BodyBuilder { TextBody = email.Body };
        foreach (var attachment in email.Attachments)
            if (File.Exists(attachment))
                body.Attachments.Add(attachment);

        message.Body = body.ToMessageBody();
        return message;
    }
}
