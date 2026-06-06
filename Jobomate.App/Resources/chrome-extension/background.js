// Jobomate browser bridge (MV3 service worker).
// Connects to the Jobomate desktop app over a loopback WebSocket, extracts job
// postings from the user's own logged-in tabs, and — crucially — PAUSES and asks
// the user to take over whenever a login or CAPTCHA is detected. It never tries to
// solve or bypass a challenge.

const WS_URL = "ws://127.0.0.1:17893";
let ws = null;
let reconnectTimer = null;
let paused = false;

function setBadge(text, color) {
  try { chrome.action.setBadgeText({ text }); if (color) chrome.action.setBadgeBackgroundColor({ color }); } catch (_) {}
}

function connect() {
  try { ws = new WebSocket(WS_URL); }
  catch (_) { scheduleReconnect(); return; }

  ws.onopen = () => { setBadge("•", "#2F6BF6"); send({ type: "hello", ext: "jobomate", v: "1.0.0" }); };
  ws.onclose = () => { setBadge("", "#888888"); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
  ws.onmessage = (ev) => { try { handle(JSON.parse(ev.data)); } catch (_) {} };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
}

function send(obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {}
}

async function handle(msg) {
  switch (msg.type) {
    case "ping": send({ type: "pong" }); break;
    case "resume": paused = false; setBadge("•", "#2F6BF6"); send({ type: "resumed" }); break;
    case "extractActive": { const t = await activeTab(); if (t) await extractAndSend(t.id, msg.requestId, t.url); break; }
    case "extractUrl": await extractUrl(msg.url, msg.requestId); break;
    case "collect":
      for (const u of (msg.urls || [])) { if (paused) break; await extractUrl(u, msg.requestId); }
      send({ type: "collectDone", requestId: msg.requestId });
      break;
  }
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function extractUrl(url, requestId) {
  const tab = await chrome.tabs.create({ url, active: true });
  await waitComplete(tab.id);
  await sleep(1200);
  await extractAndSend(tab.id, requestId, url);
}

async function extractAndSend(tabId, requestId, url) {
  let res;
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId }, func: pageExtract });
    res = out && out[0] ? out[0].result : null;
  } catch (e) { res = { ok: false, blocked: false, reason: String(e) }; }

  if (res && res.blocked) {
    // Human-in-the-loop: stop and ask the user to handle the login/CAPTCHA themselves.
    paused = true;
    setBadge("!", "#E0A23B");
    send({ type: "needsUser", requestId, url: url || (res && res.url), reason: res.reason });
    try {
      chrome.notifications.create({
        type: "basic", iconUrl: "icons/icon128.png", title: "Jobomate needs you",
        message: (res.reason || "Action required") + " — handle it in the tab, then click Resume.",
      });
    } catch (_) {}
    return;
  }

  setBadge("•", "#2F6BF6");
  send({ type: "job", requestId, url: url || (res && res.url), ok: !!(res && res.ok), job: res && res.job });
}

// Runs in the page. Self-contained (no closures over the worker).
function pageExtract() {
  function detectBlocked() {
    const t = document.body ? document.body.innerText.toLowerCase() : "";
    const blockers = ["enter the characters you see", "verify you are human", "i'm not a robot",
      "unusual traffic", "captcha", "sign in to continue", "please log in", "log in to view",
      "authwall", "security check", "are you a robot"];
    for (const b of blockers) if (t.includes(b)) return b;
    if (document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[title*='captcha'], #captcha, .g-recaptcha, .h-captcha"))
      return "captcha challenge";
    return null;
  }
  function metaOr(p) { const m = document.querySelector('meta[property="' + p + '"]'); return m ? m.content : ""; }
  function findJobPosting(d) {
    if (!d) return null;
    if (Array.isArray(d)) { for (const x of d) { const r = findJobPosting(x); if (r) return r; } return null; }
    if (typeof d === "object") {
      if (d["@graph"]) { const r = findJobPosting(d["@graph"]); if (r) return r; }
      const t = d["@type"];
      if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return d;
    }
    return null;
  }
  function mapLd(d) {
    let loc = d.jobLocation && (Array.isArray(d.jobLocation) ? d.jobLocation[0] : d.jobLocation);
    const addr = loc && loc.address;
    const locStr = addr ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(", ") : "";
    return {
      title: d.title || "",
      company: (d.hiringOrganization && d.hiringOrganization.name) || "",
      location: locStr,
      description: (d.description || "").replace(/<[^>]+>/g, " ").slice(0, 4000),
      remote: String(d.jobLocationType || "").toUpperCase().indexOf("TELECOMMUTE") >= 0,
    };
  }

  const blocked = detectBlocked();
  if (blocked) return { ok: false, blocked: true, reason: "This page needs you: " + blocked, url: location.href };

  let job = null;
  const scripts = Array.prototype.slice.call(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const s of scripts) { try { const found = findJobPosting(JSON.parse(s.textContent)); if (found) { job = mapLd(found); break; } } catch (_) {} }
  if (!job) {
    const h1 = document.querySelector("h1");
    const main = document.querySelector("main") || document.body;
    job = {
      title: (h1 && h1.innerText) || document.title || "",
      company: metaOr("og:site_name") || "",
      location: "",
      description: (main ? main.innerText : "").slice(0, 4000),
      remote: /remote/i.test(document.body ? document.body.innerText : ""),
    };
  }
  job.sourceUrl = location.href;
  const m = (job.description || "").match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  job.email = m ? m[0] : "";
  return { ok: true, blocked: false, job: job, url: location.href };
}

function waitComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => { if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {} resolve(); }, 15000);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "status") { reply({ connected: !!(ws && ws.readyState === 1), paused }); return true; }
  if (msg.type === "sendActive") { activeTab().then((t) => t && extractAndSend(t.id, "popup", t.url)); reply({ ok: true }); return true; }
  if (msg.type === "resume") { paused = false; setBadge("•", "#2F6BF6"); send({ type: "resumed" }); reply({ ok: true }); return true; }
  if (msg.type === "reconnect") { connect(); reply({ ok: true }); return true; }
  return false;
});

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
