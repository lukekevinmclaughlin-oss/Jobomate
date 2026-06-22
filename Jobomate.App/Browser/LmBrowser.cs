using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jobomate.Persistence;

namespace Jobomate.Browser;

/// <summary>
/// Jobomate's built-in <b>LLM Browser</b>, backed by the <b>LM_Browser</b> desktop app — an Electron,
/// Chrome-like browser that embeds a JSON-RPC control server on port 9222. Jobomate launches LM_Browser
/// and drives it over that API (navigate, run JS for observe/extract, click, type, scroll) while the
/// user logs in and clears CAPTCHAs in the same window. Because it's a normal Chrome-like browser,
/// Google / LinkedIn accept the user's sign-in. This keeps the exact same public surface the rest of
/// the app already uses, so the agent and UI are unchanged.
/// </summary>
public sealed class LmBrowser
{
    private const string RpcUrl = "http://127.0.0.1:9222/api/rpc";

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private readonly SemaphoreSlim _gate = new(1, 1);
    private int _rpcId;
    private bool _running;
    private string? _bridgeToken;
    private TaskCompletionSource<bool>? _resume;

    public bool IsRunning => _running;
    public string Status { get; private set; } = "Idle";
    public string? NeedsUserReason { get; private set; }
    public string CurrentUrl { get; private set; } = "";

    /// <summary>Raised on any status / state change so the UI can refresh (marshal to the UI thread).</summary>
    public event Action? Changed;

    private void Set(string status) { Status = status; Changed?.Invoke(); }

    /// <summary>Best-effort: are we on a Google sign-in page (i.e. not logged in yet)?</summary>
    public bool OnGoogleSignIn =>
        CurrentUrl.Contains("accounts.google.com", StringComparison.OrdinalIgnoreCase)
        || CurrentUrl.Contains("ServiceLogin", StringComparison.OrdinalIgnoreCase)
        || CurrentUrl.Contains("signin", StringComparison.OrdinalIgnoreCase);

    // ---------------------------------------------------------------- lifecycle ----

    /// <summary>Launch LM_Browser (if not already running) and wait for its control server. Idempotent.</summary>
    public async Task<bool> EnsureStartedAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (await PingAsync(ct).ConfigureAwait(false)) { _running = true; return true; }

            var app = FindApp();
            if (app is null)
            {
                Set("LM_Browser app not found — build it in the LLM_Browser project (npm run package:mac).");
                return false;
            }

            Set("Launching the LM Browser…");
            try { Process.Start(new ProcessStartInfo("open") { ArgumentList = { app }, UseShellExecute = false }); }
            catch (Exception ex) { Set("Couldn't launch LM Browser: " + ex.Message); return false; }

            for (var i = 0; i < 60; i++)
            {
                if (ct.IsCancellationRequested) return false;
                await Task.Delay(500, ct).ConfigureAwait(false);
                if (await PingAsync(ct).ConfigureAwait(false)) { _running = true; Set("Browser ready"); return true; }
            }
            Set("LM Browser didn't respond on port 9222.");
            return false;
        }
        catch (Exception ex) { Set("Browser error: " + ex.Message); return false; }
        finally { _gate.Release(); }
    }

    private async Task<bool> PingAsync(CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(1500);
            var r = await RpcAsync("browser.get_url", null, cts.Token).ConfigureAwait(false);
            return r is not null;
        }
        catch { return false; }
    }

    // ---------------------------------------------------------------- JSON-RPC ----

    /// <summary>
    /// The per-launch bearer token the Electron host writes to <c>bridge-auth.json</c> in the data dir.
    /// The control server on :9222 rejects RPC without it (401), so every call must present it. Cached
    /// once read; a 401 clears the cache so the next call re-reads (handles an engine that started before
    /// the host wrote the file).
    /// </summary>
    private string? LoadBridgeToken()
    {
        if (_bridgeToken is not null) return _bridgeToken;
        try
        {
            var path = Path.Combine(JobomatePaths.DataDir, "bridge-auth.json");
            if (!File.Exists(path)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.TryGetProperty("token", out var t) && t.ValueKind == JsonValueKind.String)
                _bridgeToken = t.GetString();
        }
        catch { /* file missing / unreadable — caller falls through to a tokenless attempt */ }
        return _bridgeToken;
    }

    private async Task<JsonElement?> RpcAsync(string method, object? prms, CancellationToken ct)
    {
        var id = Interlocked.Increment(ref _rpcId);
        var payload = JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["method"] = method,
            ["params"] = prms,
        });

        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var req = new HttpRequestMessage(HttpMethod.Post, RpcUrl) { Content = content };
            var token = LoadBridgeToken();
            if (!string.IsNullOrEmpty(token))
                req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            // 401 means our cached token is stale (host relaunched) — drop it and re-read once.
            if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized && attempt == 0)
            {
                _bridgeToken = null;
                continue;
            }
            var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("result", out var result))
            {
                if (result.ValueKind == JsonValueKind.Object && result.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String)
                    CurrentUrl = u.GetString() ?? CurrentUrl;
                return result.Clone();
            }
            return null;
        }
        return null;
    }

    /// <summary>Run JS in the active page and return the result value as a string.</summary>
    private async Task<string> ExecJsAsync(string code, CancellationToken ct)
    {
        var r = await RpcAsync("browser.execute_js", new { code }, ct).ConfigureAwait(false);
        if (r is { } res && res.TryGetProperty("result", out var inner))
            return inner.ValueKind == JsonValueKind.String ? (inner.GetString() ?? "") : inner.GetRawText();
        return "";
    }

    private async Task RefreshUrlAsync(CancellationToken ct)
    {
        try { await RpcAsync("browser.get_url", null, ct).ConfigureAwait(false); } catch { }
    }

    // ---------------------------------------------------------------- navigation ----

    public async Task<bool> OpenAsync(string url, CancellationToken ct = default)
    {
        if (!await EnsureStartedAsync(ct).ConfigureAwait(false)) return false;
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            Set("Opening " + url);
            await RpcAsync("browser.navigate", new { url }, ct).ConfigureAwait(false);
            await Task.Delay(1800, ct).ConfigureAwait(false);
            await RefreshUrlAsync(ct).ConfigureAwait(false);
            try { var app = FindApp(); if (app is not null) Process.Start(new ProcessStartInfo("open") { ArgumentList = { app }, UseShellExecute = false }); } catch { }
            Set("Open: " + CurrentUrl);
            return true;
        }
        catch (Exception ex) { Set("Open problem: " + ex.Message); return false; }
        finally { _gate.Release(); }
    }

    /// <summary>Create a draft in the user's Gmail via Gmail's compose URL (Gmail auto-saves it).
    /// Requires the user to already be signed into Gmail in this browser.</summary>
    public async Task<bool> ComposeGmailDraftAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        var url = "https://mail.google.com/mail/?view=cm&fs=1&tf=1"
                + "&to=" + Uri.EscapeDataString(to ?? "")
                + "&su=" + Uri.EscapeDataString(subject ?? "")
                + "&body=" + Uri.EscapeDataString(body ?? "");
        if (!await OpenAsync(url, ct).ConfigureAwait(false)) return false;
        await Task.Delay(2800, ct).ConfigureAwait(false);
        return true;
    }

    /// <summary>Navigate to the Gmail inbox and report whether the user is actually signed in.</summary>
    public async Task<bool> IsGmailLoggedInAsync(CancellationToken ct = default)
    {
        if (!await OpenAsync("https://mail.google.com/mail/u/0/", ct).ConfigureAwait(false)) return false;
        await Task.Delay(1500, ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try { await RefreshUrlAsync(ct).ConfigureAwait(false); } finally { _gate.Release(); }
        var url = CurrentUrl;
        return url.Contains("mail.google.com/mail", StringComparison.OrdinalIgnoreCase)
            && !url.Contains("accounts.google.com", StringComparison.OrdinalIgnoreCase)
            && !url.Contains("signin", StringComparison.OrdinalIgnoreCase);
    }

    // ---------------------------------------------------------------- observe / act / extract ----

    public async Task<string> ObserveAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var r = await ExecJsAsync(ObserveJs, ct).ConfigureAwait(false);
            return string.IsNullOrEmpty(r) ? "{}" : r;
        }
        catch (Exception ex) { return "{\"error\":\"" + Escape(ex.Message) + "\"}"; }
        finally { _gate.Release(); }
    }

    public async Task<string> ActAsync(string kind, int index, string text, string direction, bool enter, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            switch (kind)
            {
                case "navigate":
                    if (string.IsNullOrWhiteSpace(text)) return "navigate needs a url";
                    await RpcAsync("browser.navigate", new { url = text }, ct).ConfigureAwait(false);
                    await Task.Delay(1500, ct).ConfigureAwait(false);
                    await RefreshUrlAsync(ct).ConfigureAwait(false);
                    break;
                case "click":
                    await ExecJsAsync($"(function(){{var e=document.querySelector(\"[data-jmlink='{index}']\");if(!e)return 'no-el';e.scrollIntoView({{block:'center'}});e.click();return 'ok';}})()", ct).ConfigureAwait(false);
                    await Task.Delay(1200, ct).ConfigureAwait(false);
                    await RefreshUrlAsync(ct).ConfigureAwait(false);
                    break;
                case "type":
                    var t = JsonSerializer.Serialize(text ?? "");
                    var enterJs = enter
                        ? "e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true}));if(e.form){try{e.form.requestSubmit?e.form.requestSubmit():e.form.submit();}catch(x){}}"
                        : "";
                    await ExecJsAsync($"(function(){{var e=document.querySelector(\"[data-jminput='{index}']\");if(!e)return 'no-el';e.focus();e.value={t};e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}));{enterJs}return 'ok';}})()", ct).ConfigureAwait(false);
                    if (enter) { await Task.Delay(1500, ct).ConfigureAwait(false); await RefreshUrlAsync(ct).ConfigureAwait(false); }
                    break;
                case "scroll":
                    await ExecJsAsync($"window.scrollBy(0,{(direction == "up" ? -900 : 900)});'ok'", ct).ConfigureAwait(false);
                    await Task.Delay(500, ct).ConfigureAwait(false);
                    break;
                case "back":
                    await RpcAsync("browser.go_back", null, ct).ConfigureAwait(false);
                    await Task.Delay(1200, ct).ConfigureAwait(false);
                    await RefreshUrlAsync(ct).ConfigureAwait(false);
                    break;
                default:
                    return "unknown action " + kind;
            }
            Set("Did: " + kind);
            return "ok";
        }
        catch (Exception ex) { return "action error: " + ex.Message; }
        finally { _gate.Release(); }
    }

    public async Task<string> ExtractAsync(string goal, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var r = await ExecJsAsync(goal == "companies" ? ExtractCompaniesJs : ExtractJobsJs, ct).ConfigureAwait(false);
            return string.IsNullOrEmpty(r) ? "[]" : r;
        }
        catch { return "[]"; }
        finally { _gate.Release(); }
    }

    // ---------------------------------------------------------------- human in the loop ----

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

    public Task StopAsync()
    {
        _running = false;
        NeedsUserReason = null;
        try { Process.Start(new ProcessStartInfo("pkill") { ArgumentList = { "-f", "LM_Browser.app/Contents/MacOS/LM_Browser" }, UseShellExecute = false }); } catch { }
        Set("Closed");
        return Task.CompletedTask;
    }

    // ---------------------------------------------------------------- locate the app ----

    private static string? FindApp()
    {
        foreach (var p in new[]
        {
            Path.Combine(AppContext.BaseDirectory, "..", "Resources", "LM_Browser.app"), // shipped in the .app bundle
            Path.Combine(AppContext.BaseDirectory, "LM_Browser.app"),
            "/Users/lukemclaughlin/Documents/GitHub/LLM_Browser/release/mac-arm64/LM_Browser.app", // dev build
        })
        {
            try { var full = Path.GetFullPath(p); if (Directory.Exists(full)) return full; } catch { }
        }
        return null;
    }

    private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "'");

    // ---------------------------------------------------------------------------------------------
    // In-page scripts (run via browser.execute_js). Each returns a JSON string we parse in C#.
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
      if (lines.length < 2) continue;
      const META = /^(new|featured|hot|urgent|promoted|remote|hybrid|on-?site|full-?time|part-?time|contract|freelance|internship|apply|save|share|view|usd|eur|gbp|\$|€|£|anywhere.*|worldwide|\d+\s*(d|h|w|m|days?|hours?|weeks?|months?)\s*(ago)?|\d{4})$/i;
      const titEl = card.querySelector('[class*=title i] , h1, h2, h3, h4');
      let title = (titEl && titEl.innerText.trim().replace(/\s+/g, ' ')) || '';
      if (!title || title.length > 120) { const ln = lines.find(l => !META.test(l)); title = (ln || lines[0]); }
      title = title.replace(/\s+/g, ' ').slice(0, 120);
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
