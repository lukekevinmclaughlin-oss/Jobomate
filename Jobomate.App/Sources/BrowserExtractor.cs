using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Contracts;
using Jobomate.Persistence;
using Microsoft.Playwright;

namespace Jobomate.Sources;

public sealed class BrowserExtractionResult
{
    public List<JobPosting> Jobs { get; } = new();
    public bool BrowserAvailable { get; set; } = true;
    public string? Message { get; set; }
}

/// <summary>
/// Browser-assisted extraction (Playwright/Chromium) for login-walled sites
/// (LinkedIn/Indeed/Glassdoor/StepStone/Wellfound/Otta). Uses a persistent profile so
/// the user stays logged in and is present. Never bypasses CAPTCHA/anti-bot: a detected
/// wall yields a "manual portal application required" posting. If the Chromium binary
/// isn't installed, returns an actionable message instead of crashing.
/// </summary>
public sealed class BrowserExtractor
{
    private readonly string _userDataDir;

    public BrowserExtractor(string? userDataDir = null)
    {
        _userDataDir = userDataDir ?? JobomatePaths.EnsureDir(JobomatePaths.BrowserProfileDir);
    }

    public async Task<BrowserExtractionResult> ExtractAsync(
        IReadOnlyList<string> urls, bool headless = false, CancellationToken ct = default)
    {
        var result = new BrowserExtractionResult();
        if (urls.Count == 0) return result;

        IPlaywright? pw = null;
        IBrowserContext? context = null;
        try
        {
            pw = await Microsoft.Playwright.Playwright.CreateAsync().ConfigureAwait(false);
            context = await pw.Chromium
                .LaunchPersistentContextAsync(_userDataDir, new BrowserTypeLaunchPersistentContextOptions { Headless = headless })
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            result.BrowserAvailable = false;
            result.Message =
                "Browser engine unavailable. Install it once with " +
                "`pwsh Jobomate.App/bin/Debug/net8.0/playwright.ps1 install chromium`. (" + ex.Message + ")";
            context?.DisposeAsync().AsTask().Wait(1000);
            pw?.Dispose();
            return result;
        }

        try
        {
            foreach (var url in urls)
            {
                if (ct.IsCancellationRequested) break;
                var page = await context.NewPageAsync().ConfigureAwait(false);
                try
                {
                    await page.GotoAsync(url, new PageGotoOptions
                    {
                        WaitUntil = WaitUntilState.DOMContentLoaded,
                        Timeout = 45000,
                    }).ConfigureAwait(false);
                    await page.WaitForTimeoutAsync(1500).ConfigureAwait(false);

                    var html = await page.ContentAsync().ConfigureAwait(false);
                    if (HtmlScraper.LooksLoginWalled(html))
                    {
                        result.Jobs.Add(Manual(url, "Login/anti-bot wall detected. Log in in the opened browser and retry, or apply manually on the portal."));
                        continue;
                    }

                    var parsed = HtmlScraper.ParseJsonLdJobs(html, url, "Browser-assisted");
                    if (parsed.Count > 0)
                    {
                        result.Jobs.AddRange(parsed);
                        continue;
                    }

                    var title = await page.TitleAsync().ConfigureAwait(false);
                    var bodyText = await page.InnerTextAsync("body").ConfigureAwait(false);
                    var email = JobNormalization.ExtractFirstEmail(bodyText);
                    result.Jobs.Add(JobNormalization.Finalize(new JobPosting
                    {
                        Source = "Browser-assisted",
                        SourceUrl = url,
                        Company = HostOf(url),
                        Title = string.IsNullOrWhiteSpace(title) ? "(review)" : title,
                        RawDescription = Truncate(bodyText, 4000),
                        ContactEmail = email ?? "",
                        PortalUrl = string.IsNullOrEmpty(email) ? url : "",
                        ApplicationMethod = string.IsNullOrEmpty(email) ? ApplicationMethod.Portal : ApplicationMethod.Email,
                        ConfidenceScore = 0.5,
                        ExtractionNotes = "Browser-assisted DOM extraction (user present/logged in).",
                    }));
                }
                catch (Exception ex)
                {
                    result.Jobs.Add(Manual(url, "Extraction failed: " + ex.Message));
                }
                finally
                {
                    await page.CloseAsync().ConfigureAwait(false);
                }
            }
        }
        finally
        {
            if (context is not null) await context.CloseAsync().ConfigureAwait(false);
            pw?.Dispose();
        }
        return result;
    }

    private static JobPosting Manual(string url, string note) => JobNormalization.Finalize(new JobPosting
    {
        Source = "Browser-assisted",
        SourceUrl = url,
        Company = HostOf(url),
        Title = "(manual portal application required)",
        PortalUrl = url,
        ApplicationMethod = ApplicationMethod.ManualContact,
        ConfidenceScore = 0.2,
        ExtractionNotes = note,
    });

    private static string HostOf(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host.Replace("www.", "") : "";

    private static string Truncate(string s, int max) => string.IsNullOrEmpty(s) || s.Length <= max ? s ?? "" : s[..max];
}
