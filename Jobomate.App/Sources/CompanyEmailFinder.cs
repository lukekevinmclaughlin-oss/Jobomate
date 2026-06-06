using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;

namespace Jobomate.Sources;

/// <summary>
/// Finds an official, *published* recruiting/contact email for a company by reading its
/// common pages (careers/jobs/contact/Impressum). Never guesses or permutes addresses —
/// if nothing is published, the company is marked "Needs manual contact".
/// </summary>
public sealed class CompanyEmailFinder
{
    private static readonly string[] CandidatePaths =
        { "", "/careers", "/career", "/jobs", "/join-us", "/contact", "/kontakt", "/impressum", "/legal-notice", "/about" };

    private static readonly string[] RecruitingPrefixes =
        { "jobs@", "careers@", "career@", "bewerbung@", "recruiting@", "talent@", "talents@", "hr@", "people@", "join@" };

    private static readonly string[] ContactPrefixes =
        { "contact@", "kontakt@", "hello@", "info@", "office@" };

    private readonly HttpClient _http;
    public CompanyEmailFinder(HttpClient http) => _http = http;

    public async Task<(string Email, string Evidence, ContactStatus Status)> FindAsync(string website, CancellationToken ct = default)
    {
        var baseUrl = Normalize(website);
        if (baseUrl is null) return ("", "", ContactStatus.NeedsManualContact);

        var seenEmails = new List<(string Email, string Url)>();
        foreach (var path in CandidatePaths)
        {
            if (ct.IsCancellationRequested) break;
            var url = baseUrl.TrimEnd('/') + path;
            var html = await HtmlFetch.GetAsync(_http, url, ct).ConfigureAwait(false);
            if (html is null) continue;

            foreach (var email in HtmlScraper.Emails(html))
                if (!seenEmails.Any(e => e.Email.Equals(email, StringComparison.OrdinalIgnoreCase)))
                    seenEmails.Add((email, url));

            // Prefer a recruiting address as soon as we find one.
            var recruiting = seenEmails.FirstOrDefault(e => RecruitingPrefixes.Any(p => e.Email.StartsWith(p, StringComparison.OrdinalIgnoreCase)));
            if (recruiting.Email is { Length: > 0 })
                return (recruiting.Email, "Published on " + recruiting.Url, ContactStatus.HasEmail);
        }

        // No recruiting address: accept a published general contact address if present.
        var contact = seenEmails.FirstOrDefault(e => ContactPrefixes.Any(p => e.Email.StartsWith(p, StringComparison.OrdinalIgnoreCase)));
        if (contact.Email is { Length: > 0 })
            return (contact.Email, "Published on " + contact.Url, ContactStatus.HasEmail);

        return ("", "", ContactStatus.NeedsManualContact);
    }

    private static string? Normalize(string website)
    {
        if (string.IsNullOrWhiteSpace(website)) return null;
        var w = website.Trim();
        if (!w.Contains("://", StringComparison.Ordinal)) w = "https://" + w;
        return Uri.TryCreate(w, UriKind.Absolute, out var u) ? u.GetLeftPart(UriPartial.Authority) : null;
    }
}
