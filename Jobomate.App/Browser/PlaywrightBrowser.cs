using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Persistence;
using Microsoft.Playwright;

namespace Jobomate.Browser;

/// <summary>
/// Jobomate's built-in <b>LLM Browser</b>: a real WebKit browser (driven through Playwright) that
/// the user can log into and that the connected LLM drives to collect job postings or companies.
/// This replaces the old Chrome extension entirely — there is no install step and no external
/// Chrome. The window is visible (headed) so the user handles any login or CAPTCHA themselves; the
/// browser pauses and waits ("human in the loop") and never bypasses a challenge. A persistent
/// browser profile keeps the user logged in between runs.
/// </summary>
public sealed class PlaywrightBrowser : IAsyncDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IPlaywright? _pw;
    private IBrowserContext? _ctx;
    private IPage? _page;
    private TaskCompletionSource<bool>? _resume;

    public bool IsRunning => _ctx is not null;
    public string Status { get; private set; } = "Idle";
    public string? NeedsUserReason { get; private set; }
    public string CurrentUrl => _page?.Url ?? "";

    /// <summary>Raised on any status / state change so the UI can refresh (marshal to UI thread).</summary>
    public event Action? Changed;

    private void Set(string status) { Status = status; Changed?.Invoke(); }

    public string UserDataDir => Path.Combine(JobomatePaths.DataDir, "llm-browser-profile");

    // Runs before every page's own scripts: hides the JS automation signals that sites like Google
    // and LinkedIn use to detect (and block) an automated browser, so the user can sign in normally.
    private const string StealthJs = @"
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 1 }); } catch (e) {}";

    private static bool BrowserInstalled(string name)
    {
        try
        {
            var cache = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Library", "Caches", "ms-playwright");
            return Directory.Exists(cache) && Directory.GetDirectories(cache, name + "-*").Length > 0;
        }
        catch { return false; }
    }

    private string? _brandedExe;

    /// <summary>One-time on macOS: make a Jobomate-owned copy of the bundled Chromium, rebranded
    /// "Jobomate LM Browser" with the Jobomate icon, and return its executable path. So the browser
    /// the user sees is genuinely the software's own — not "Google Chrome for Testing". Returns null
    /// (use the default browser) on non-macOS or any failure.</summary>
    private async Task<string?> EnsureBrandedBrowserAsync()
    {
        if (_brandedExe is not null) return _brandedExe;
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.OSX) || _pw is null) return null;
        try
        {
            var srcExe = _pw.Chromium.ExecutablePath;
            if (string.IsNullOrEmpty(srcExe) || !File.Exists(srcExe)) return null;
            var binName = Path.GetFileName(srcExe);                                   // "Google Chrome for Testing"
            var srcApp = Directory.GetParent(srcExe)?.Parent?.Parent?.FullName;        // …/<browser>.app
            if (srcApp is null || !srcApp.EndsWith(".app", StringComparison.OrdinalIgnoreCase)) return null;

            var brandedApp = Path.Combine(JobomatePaths.DataDir, "Jobomate LM Browser.app");
            var brandedExe = Path.Combine(brandedApp, "Contents", "MacOS", binName);
            var marker = Path.Combine(brandedApp, "Contents", ".jobomate-src");

            // Reuse the existing branded copy unless the underlying Playwright browser changed.
            if (File.Exists(brandedExe) && File.Exists(marker) && (await File.ReadAllTextAsync(marker).ConfigureAwait(false)).Trim() == srcApp)
            {
                _brandedExe = brandedExe;
                return brandedExe;
            }

            Set("Preparing the Jobomate LM Browser…");
            if (Directory.Exists(brandedApp)) Directory.Delete(brandedApp, true);
            await Run("cp", "-R", srcApp, brandedApp).ConfigureAwait(false);

            var plist = Path.Combine(brandedApp, "Contents", "Info.plist");
            await Run("/usr/libexec/PlistBuddy", "-c", "Set :CFBundleName Jobomate LM Browser", plist).ConfigureAwait(false);
            await Run("/usr/libexec/PlistBuddy", "-c", "Set :CFBundleDisplayName Jobomate LM Browser", plist).ConfigureAwait(false);

            var icns = FindJobomateIcns();
            if (icns is not null)
                try { File.Copy(icns, Path.Combine(brandedApp, "Contents", "Resources", "app.icns"), true); } catch { }

            await Run("codesign", "--force", "--deep", "--sign", "-", brandedApp).ConfigureAwait(false);
            try { await File.WriteAllTextAsync(marker, srcApp).ConfigureAwait(false); } catch { }

            if (File.Exists(brandedExe)) { _brandedExe = brandedExe; return brandedExe; }
            return null;
        }
        catch { return null; }
    }

    private static string? FindJobomateIcns()
    {
        foreach (var p in new[]
        {
            Path.Combine(AppContext.BaseDirectory, "AppIcon.icns"),
            Path.Combine(AppContext.BaseDirectory, "..", "Resources", "AppIcon.icns"),
            Path.Combine(AppContext.BaseDirectory, "Resources", "AppIcon.icns"),
        })
        {
            try { if (File.Exists(p)) return Path.GetFullPath(p); } catch { }
        }
        return null;
    }

    private static async Task Run(string file, params string[] args)
    {
        var psi = new ProcessStartInfo(file) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi);
        if (p is not null) await p.WaitForExitAsync().ConfigureAwait(false);
    }

    /// <summary>True while we have a live context with an open page (the user hasn't closed it).</summary>
    private bool Alive => _ctx is not null && _page is not null && !_page.IsClosed;

    /// <summary>A Playwright error meaning the page/context/browser was closed (e.g. the user closed
    /// the window) — recover by relaunching.</summary>
    private static bool IsClosed(Exception ex) =>
        ex.Message.Contains("closed", StringComparison.OrdinalIgnoreCase) ||
        ex.Message.Contains("Target page", StringComparison.OrdinalIgnoreCase) ||
        ex.Message.Contains("crash", StringComparison.OrdinalIgnoreCase);

    private void ResetIfClosed(Exception ex) { if (IsClosed(ex)) { _ctx = null; _page = null; } }

    /// <summary>Installs WebKit on first use (~100 MB, one-time) and launches the headed browser.
    /// Idempotent — relaunches automatically if the previous window was closed.</summary>
    public async Task<bool> EnsureStartedAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (Alive) return true;
            _page = null; _ctx = null; // drop any stale/closed session before relaunching

            if (!BrowserInstalled("chromium"))
            {
                Set("Setting up the LLM Browser (first run, ~150 MB)…");
                await Task.Run(() => Microsoft.Playwright.Program.Main(new[] { "install", "chromium" }), ct).ConfigureAwait(false);
            }

            Set("Launching the LLM Browser…");
            _pw ??= await Playwright.CreateAsync().ConfigureAwait(false);
            Directory.CreateDirectory(UserDataDir);

            // Jobomate's OWN browser: Playwright's bundled Chromium, headed, with the automation
            // markers stripped so Google / LinkedIn don't block the user's sign-in ("this browser may
            // not be secure"). The init script below hides the remaining JS automation signals.
            var opts = new BrowserTypeLaunchPersistentContextOptions
            {
                Headless = false,
                Args = new[] { "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check" },
                IgnoreDefaultArgs = new[] { "--enable-automation" },
                ViewportSize = new ViewportSize { Width = 1280, Height = 900 },
            };
            // Launch a Jobomate-branded copy ("Jobomate LM Browser", Jobomate icon) when available.
            var brandedExe = await EnsureBrandedBrowserAsync().ConfigureAwait(false);
            if (brandedExe is not null) opts.ExecutablePath = brandedExe;

            var ctx = await _pw.Chromium.LaunchPersistentContextAsync(UserDataDir, opts).ConfigureAwait(false);
            try { await ctx.AddInitScriptAsync(StealthJs).ConfigureAwait(false); } catch { }
            // If the user closes the browser window, drop our references so the next action relaunches.
            ctx.Close += (_, __) => { _ctx = null; _page = null; NeedsUserReason = null; Set("Browser closed"); };
            var page = ctx.Pages.Count > 0 ? ctx.Pages[0] : await ctx.NewPageAsync().ConfigureAwait(false);
            page.Close += (_, __) => { _page = null; };
            _ctx = ctx;
            _page = page;
            Set("Browser ready");
            return true;
        }
        catch (Exception ex) { _ctx = null; _page = null; Set("Browser error: " + ex.Message); return false; }
        finally { _gate.Release(); }
    }

    /// <summary>Open a URL and bring the window to the front. Relaunches once if the browser was closed.</summary>
    public async Task<bool> OpenAsync(string url, CancellationToken ct = default)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            if (!await EnsureStartedAsync(ct).ConfigureAwait(false)) return false;
            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                Set("Opening " + url);
                await _page!.GotoAsync(url, new PageGotoOptions
                {
                    WaitUntil = WaitUntilState.DOMContentLoaded,
                    Timeout = 45000,
                }).ConfigureAwait(false);
                try { await _page.BringToFrontAsync().ConfigureAwait(false); } catch { }
                Set("Open: " + _page.Url);
                return true;
            }
            catch (Exception ex) when (IsClosed(ex) && attempt == 0)
            {
                _ctx = null; _page = null; // browser was closed — relaunch and retry once
            }
            catch (Exception ex) { Set("Open problem: " + ex.Message); return false; }
            finally { _gate.Release(); }
        }
        return false;
    }

    /// <summary>Create a draft in the user's Gmail by navigating to Gmail's compose URL (which Gmail
    /// auto-saves as a draft). Requires the user to already be signed into Gmail in this browser.</summary>
    public async Task<bool> ComposeGmailDraftAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        var url = "https://mail.google.com/mail/?view=cm&fs=1&tf=1"
                + "&to=" + Uri.EscapeDataString(to ?? "")
                + "&su=" + Uri.EscapeDataString(subject ?? "")
                + "&body=" + Uri.EscapeDataString(body ?? "");
        if (!await OpenAsync(url, ct).ConfigureAwait(false)) return false;

        // Give Gmail a moment to register and auto-save the draft before we navigate away.
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try { if (_page is not null) await _page.WaitForTimeoutAsync(2800).ConfigureAwait(false); }
        catch { }
        finally { _gate.Release(); }
        return true;
    }

    /// <summary>Best-effort check: are we sitting on a Google sign-in page (i.e. not logged in yet)?</summary>
    public bool OnGoogleSignIn =>
        CurrentUrl.Contains("accounts.google.com", StringComparison.OrdinalIgnoreCase)
        || CurrentUrl.Contains("ServiceLogin", StringComparison.OrdinalIgnoreCase)
        || CurrentUrl.Contains("signin", StringComparison.OrdinalIgnoreCase);

    /// <summary>Navigate to the Gmail inbox and report whether the user is actually signed in — i.e.
    /// we land on the real mailbox (mail.google.com/mail) rather than a sign-in or marketing page.
    /// Used to avoid falsely reporting "drafts created" when no one is logged in.</summary>
    public async Task<bool> IsGmailLoggedInAsync(CancellationToken ct = default)
    {
        if (!await OpenAsync("https://mail.google.com/mail/u/0/", ct).ConfigureAwait(false)) return false;
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try { if (_page is not null) await _page.WaitForTimeoutAsync(1500).ConfigureAwait(false); }
        catch { }
        finally { _gate.Release(); }
        var url = CurrentUrl;
        return url.Contains("mail.google.com/mail", StringComparison.OrdinalIgnoreCase)
            && !url.Contains("accounts.google.com", StringComparison.OrdinalIgnoreCase)
            && !url.Contains("signin", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Return a compact JSON snapshot of the current page for the LLM to reason over.</summary>
    public async Task<string> ObserveAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_page is null) return "{}";
            return await _page.EvaluateAsync<string>(ObserveJs).ConfigureAwait(false);
        }
        catch (Exception ex) { ResetIfClosed(ex); return "{\"error\":\"" + Escape(ex.Message) + "\"}"; }
        finally { _gate.Release(); }
    }

    /// <summary>Execute one LLM-chosen action against the page.</summary>
    public async Task<string> ActAsync(string kind, int index, string text, string direction, bool enter, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_page is null) return "no page";
            switch (kind)
            {
                case "navigate":
                    if (string.IsNullOrWhiteSpace(text)) return "navigate needs a url";
                    await _page.GotoAsync(text, new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 45000 }).ConfigureAwait(false);
                    break;
                case "click":
                    try { await _page.EvalOnSelectorAsync($"[data-jmlink='{index}']", "el => el.scrollIntoView({block:'center'})").ConfigureAwait(false); } catch { }
                    await _page.ClickAsync($"[data-jmlink='{index}']", new PageClickOptions { Timeout = 8000 }).ConfigureAwait(false);
                    await WaitSettleAsync().ConfigureAwait(false);
                    break;
                case "type":
                    await _page.FillAsync($"[data-jminput='{index}']", text, new PageFillOptions { Timeout = 8000 }).ConfigureAwait(false);
                    if (enter)
                    {
                        await _page.PressAsync($"[data-jminput='{index}']", "Enter").ConfigureAwait(false);
                        await WaitSettleAsync().ConfigureAwait(false);
                    }
                    break;
                case "scroll":
                    await _page.Mouse.WheelAsync(0, direction == "up" ? -900 : 900).ConfigureAwait(false);
                    await _page.WaitForTimeoutAsync(600).ConfigureAwait(false);
                    break;
                case "back":
                    try { await _page.GoBackAsync(new PageGoBackOptions { Timeout = 15000 }).ConfigureAwait(false); } catch { }
                    break;
                default:
                    return "unknown action " + kind;
            }
            Set("Did: " + kind);
            return "ok";
        }
        catch (Exception ex) { ResetIfClosed(ex); return "action error: " + ex.Message; }
        finally { _gate.Release(); }
    }

    private async Task WaitSettleAsync()
    {
        try { await _page!.WaitForLoadStateAsync(LoadState.DOMContentLoaded, new PageWaitForLoadStateOptions { Timeout = 12000 }).ConfigureAwait(false); } catch { }
        try { await _page!.WaitForTimeoutAsync(800).ConfigureAwait(false); } catch { }
    }

    /// <summary>Extract job postings ("jobs") or employers ("companies") from the current page.</summary>
    public async Task<string> ExtractAsync(string goal, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_page is null) return "[]";
            return await _page.EvaluateAsync<string>(goal == "companies" ? ExtractCompaniesJs : ExtractJobsJs).ConfigureAwait(false);
        }
        catch (Exception ex) { ResetIfClosed(ex); return "[]"; }
        finally { _gate.Release(); }
    }

    // ---- human in the loop ----
    public void FlagNeedsUser(string reason)
    {
        NeedsUserReason = reason;
        _resume = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Set("Action needed — " + reason);
    }

    public void Resume()
    {
        NeedsUserReason = null;
        _resume?.TrySetResult(true);
        Set("Resumed");
    }

    public Task WaitForResumeAsync(CancellationToken ct)
        => _resume is null ? Task.CompletedTask : Task.WhenAny(_resume.Task, Task.Delay(Timeout.Infinite, ct));

    public async Task StopAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try { if (_ctx is not null) await _ctx.CloseAsync().ConfigureAwait(false); } catch { }
        _ctx = null; _page = null;
        NeedsUserReason = null;
        Set("Closed");
        _gate.Release();
    }

    public async ValueTask DisposeAsync()
    {
        try { await StopAsync().ConfigureAwait(false); } catch { }
        _pw?.Dispose();
    }

    private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "'");

    // ---------------------------------------------------------------------------------------------
    // In-page scripts. Each returns a JSON string (we parse it in C#). Single quotes throughout so
    // the C# verbatim literals need no escaping; the only doubled quotes ("") are CSS attr values.
    // ---------------------------------------------------------------------------------------------

    private const string ObserveJs = @"(() => {
  const txt = (document.body ? document.body.innerText : '') || '';
  const low = txt.toLowerCase();
  const blockers = ['enter the characters you see','verify you are human',""i'm not a robot"",'unusual traffic','captcha','sign in to continue','please log in','log in to view','authwall','security check','are you a robot','verify your identity','complete the security check'];
  let blocked = '';
  for (const b of blockers) { if (low.indexOf(b) >= 0) { blocked = b; break; } }
  if (!blocked && document.querySelector(""iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[title*='captcha'], #captcha, .g-recaptcha, .h-captcha"")) blocked = 'captcha challenge';

  document.querySelectorAll('[data-jmlink]').forEach(e => e.removeAttribute('data-jmlink'));
  document.querySelectorAll('[data-jminput]').forEach(e => e.removeAttribute('data-jminput'));

  const seen = new Set();
  const links = [];
  const anchors = Array.from(document.querySelectorAll('a[href], [role=link], button'));
  let li = 0;
  for (const a of anchors) {
    if (li >= 60) break;
    const rect = a.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    let t = (a.innerText || a.getAttribute('aria-label') || a.value || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length < 2 || t.length > 140) continue;
    let h = a.getAttribute('href') || '';
    try { if (h) h = new URL(h, location.href).href; } catch (e) {}
    const key = t + '|' + h;
    if (seen.has(key)) continue;
    seen.add(key);
    a.setAttribute('data-jmlink', li);
    links.push({ i: li, t: t.slice(0, 140), h: h });
    li++;
  }

  const inputs = [];
  const fields = Array.from(document.querySelectorAll(""input[type=text], input[type=search], input:not([type]), textarea""));
  let ii = 0;
  for (const f of fields) {
    if (ii >= 10) break;
    const rect = f.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    f.setAttribute('data-jminput', ii);
    const ph = (f.getAttribute('placeholder') || f.getAttribute('aria-label') || f.getAttribute('name') || '').trim();
    inputs.push({ i: ii, ph: ph.slice(0, 80) });
    ii++;
  }

  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    needsUser: !!blocked,
    reason: blocked,
    digest: txt.replace(/\s+/g, ' ').trim().slice(0, 2500),
    links: links,
    inputs: inputs
  });
})()";

    private const string ExtractJobsJs = @"(() => {
  const out = [];
  function collect(d) {
    if (!d) return;
    if (Array.isArray(d)) { d.forEach(collect); return; }
    if (typeof d === 'object') {
      if (d['@graph']) collect(d['@graph']);
      const t = d['@type'];
      if (t === 'JobPosting' || (Array.isArray(t) && t.indexOf('JobPosting') >= 0)) {
        const loc = d.jobLocation && (Array.isArray(d.jobLocation) ? d.jobLocation[0] : d.jobLocation);
        const addr = loc && loc.address;
        out.push({
          title: d.title || '',
          company: (d.hiringOrganization && d.hiringOrganization.name) || '',
          location: addr ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ') : '',
          url: d.url || location.href,
          description: (d.description || '').replace(/<[^>]+>/g, ' ').slice(0, 1500)
        });
      }
    }
  }
  document.querySelectorAll(""script[type='application/ld+json']"").forEach(s => { try { collect(JSON.parse(s.textContent)); } catch (e) {} });

  // Heuristic listing extraction when there's little/no JSON-LD. Skip navigation, category and
  // utility links; require each candidate to sit inside a real job 'card' (an li/article/job
  // element with a couple of distinct text lines: usually a title plus a company).
  if (out.length < 4) {
    const NAV = /^(find jobs|search by.*|top trending.*|programming|design|product|sales.*|marketing.*|management.*|customer support|devops.*|all jobs|view all|browse.*|see all|more jobs|next|previous|sign in|sign up|log ?in|register|post a job|pricing|about|faq|contact|newsletter|home|jobs|companies|remote jobs|categories)$/i;
    const BADHREF = /(\/categories\/|\/category\/|\/search|\/login|\/sign|\/register|\/post|\/pricing|\/about|\/faq|\/terms|\/privacy|\/page\/|#$|^#|javascript:|mailto:|twitter\.com|facebook\.com|instagram\.com|youtube\.com|linkedin\.com\/(company|in)\/)/i;
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const a of anchors) {
      let t = (a.innerText || '').trim().replace(/\s+/g, ' ');
      if (t.length < 6 || t.length > 120) continue;
      if (NAV.test(t)) continue;
      let url = a.getAttribute('href') || '';
      try { url = new URL(url, location.href).href; } catch (e) {}
      if (!/^https?:/i.test(url) || BADHREF.test(url)) continue;
      const card = a.closest('li, article, [class*=job i], [class*=Job], [class*=listing i], [class*=card i], tr');
      if (!card) continue;
      const lines = (card.innerText || '').split('\n').map(x => x.trim()).filter(x => x.length > 0);
      if (lines.length < 2) continue; // a real posting card has a title + company/meta
      const META = /^(new|featured|hot|urgent|promoted|remote|hybrid|on-?site|full-?time|part-?time|contract|freelance|internship|apply|save|share|view|usd|eur|gbp|\$|€|£|anywhere.*|worldwide|\d+\s*(d|h|w|m|days?|hours?|weeks?|months?)\s*(ago)?|\d{4})$/i;
      // Title: prefer a structured title element; else the first non-badge line.
      const titEl = card.querySelector('[class*=title i] , h1, h2, h3, h4');
      let title = (titEl && titEl.innerText.trim().replace(/\s+/g, ' ')) || '';
      if (!title || title.length > 120) { const ln = lines.find(l => !META.test(l)); title = (ln || lines[0]); }
      title = title.replace(/\s+/g, ' ').slice(0, 120);
      // Company: prefer a structured company element; else the next meaningful, non-title line.
      const compEl = card.querySelector('[class*=company i], [class*=employer i], [class*=organization i], [class*=org i]');
      let company = (compEl && compEl.innerText.trim().replace(/\s+/g, ' ')) || '';
      if (!company) company = lines.find(l => l !== title && l.length > 1 && l.length < 60 && !META.test(l)) || '';
      out.push({ title: title, company: company.slice(0, 80), location: '', url: url, description: (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 320) });
      if (out.length >= 60) break;
    }
  }

  const seen = new Set();
  const res = [];
  for (const j of out) {
    const k = (j.title + '|' + j.url).toLowerCase();
    if (!j.title || seen.has(k)) continue;
    seen.add(k);
    res.push(j);
    if (res.length >= 50) break;
  }
  return JSON.stringify(res);
})()";

    private const string ExtractCompaniesJs = @"(() => {
  const out = [];
  function collect(d) {
    if (!d) return;
    if (Array.isArray(d)) { d.forEach(collect); return; }
    if (typeof d === 'object') {
      if (d['@graph']) collect(d['@graph']);
      const t = d['@type'];
      if (t === 'Organization' || t === 'Company' || (Array.isArray(t) && t.indexOf('Organization') >= 0)) {
        out.push({ name: d.name || '', website: d.url || '', location: (d.address && (d.address.addressLocality || '')) || '' });
      }
    }
  }
  document.querySelectorAll(""script[type='application/ld+json']"").forEach(s => { try { collect(JSON.parse(s.textContent)); } catch (e) {} });

  if (out.length === 0) {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const a of anchors) {
      let t = (a.innerText || '').trim().replace(/\s+/g, ' ');
      if (t.length < 2 || t.length > 80) continue;
      let url = a.getAttribute('href') || '';
      try { url = new URL(url, location.href).href; } catch (e) {}
      if (!/company|companies|employer|organization|organisation|careers|jobs-at|about/i.test(url + ' ' + t)) continue;
      out.push({ name: t.slice(0, 80), website: url, location: '' });
      if (out.length >= 60) break;
    }
  }

  const seen = new Set();
  const res = [];
  for (const c of out) {
    const k = (c.name || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    res.push(c);
    if (res.length >= 50) break;
  }
  return JSON.stringify(res);
})()";
}
