/* LM_Browser end-to-end test: drives the REAL LlmConnectionManager.sendPrompt agentic loop
 * with a scripted OpenAI-compatible model server, so every bridge tool actually executes
 * through the genuine pipeline (tool catalog -> LLM round-trip -> dispatchBrowserTool ->
 * BrowserController -> tool-result feedback -> response assembly). The model is scripted
 * (keyed by [[Tn]] tags in the prompt); LM_Browser's execution is 100% real.
 *
 * Coverage:
 *  - All 20 browser bridge tools against a mock BrowserController implementing the full
 *    interface (in-memory tabs + canned pages + a call log): navigate, snapshot, get_text,
 *    get_html, click, fill, type, select_option, press_key, scroll, highlight, screenshot,
 *    reload, back+forward, tabs (new/list/switch/close via op aliases), cdp, the generic
 *    `browser` JSON op router, done, ask_user.
 *  - Loop robustness: stall guard (same call repeated -> breaks at STALL_LIMIT=8),
 *    finite-cap wrap-up (maxToolRounds=2 + never-stopping model -> distinctive final answer
 *    from the no-tools wrap call), tool_choice degradation (400 on any request carrying
 *    tool_choice -> required -> auto -> omit -> completes), universal-template fallback
 *    (400 "does not support tools" -> folded no-tools retry -> textual JSON tool call parsed
 *    by parseJsonToolCalls -> tool executes), requireToolUse first-round tool_choice=required.
 *  - Streaming note: sendPrompt takes no onToken callback and the agent loop always posts
 *    stream:false (enableLlmStreaming is stored config that the loop does not consume).
 *    Row L4 verifies and documents that: even with enableLlmStreaming=true the request
 *    carries stream:false and the loop completes over plain JSON.
 *
 * Run with:  npm run test:e2e   (builds electron first, then runs this)
 * Exit 0 = all rows passed. Requires dist-electron to be built.
 */
const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "lmbrowser-e2e-ud-"));
const MOCK_PORT = 8731;

// ---- 1) Stub electron BEFORE requiring the compiled manager ----
const electronStub = {
  app: {
    getPath: () => USERDATA,
    getName: () => "LM_Browser",
    getAppPath: () => REPO,
    whenReady: () => Promise.resolve(),
    on: () => {},
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s)),
    decryptString: (b) => Buffer.from(b).toString(),
  },
  shell: { openPath: async () => "", openExternal: async () => {} },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};

// ---- 2) Config writer: LocalServer pointed at the scripted model ----
const BASE_CONFIG = {
  connectionType: "LocalServer",
  localServerUrl: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`,
  localModelName: "mock",
  connected: true,
  maxToolRounds: 12,
  enableLlmStreaming: false,
  requireToolUse: false,
  reasoningEffort: "Medium",
};
function writeConfig(overrides) {
  fs.writeFileSync(
    path.join(USERDATA, "llm-connection.json"),
    JSON.stringify({ ...BASE_CONFIG, ...(overrides || {}) })
  );
}
writeConfig();

// ---- 3) Mock BrowserController: full LM_Browser interface, in-memory tabs + canned pages ----
const PAGES = {
  "https://example.com/": {
    title: "Example Domain",
    text: "Example Domain\nThis domain is for use in illustrative examples.",
    html: "<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><input id='q'><select id='s'><option value='a'>A</option></select><a href='https://example.org/'>more</a></body></html>",
  },
  "https://example.org/": {
    title: "Example Org",
    text: "Example Org\nAnother illustrative page.",
    html: "<html><head><title>Example Org</title></head><body><h1>Example Org</h1></body></html>",
  },
  "https://wikipedia.org/": {
    title: "Wikipedia",
    text: "Wikipedia, the free encyclopedia.",
    html: "<html><head><title>Wikipedia</title></head><body><h1>Wikipedia</h1></body></html>",
  },
  "about:blank": { title: "New Tab", text: "", html: "<html><body></body></html>" },
};
function pageFor(url) {
  return PAGES[url] || PAGES[url + "/"] || { title: url, text: `Canned page for ${url}`, html: `<html><title>${url}</title></html>` };
}
const browserCalls = [];
function makeMockController() {
  let nextId = 1;
  const tabs = [];
  let activeId = null;
  function newTab(url) {
    const t = { id: `tab_${nextId++}`, url: url || "about:blank", hist: [url || "about:blank"], idx: 0 };
    tabs.push(t);
    return t;
  }
  function active(tabId) {
    const t = tabId ? tabs.find((x) => x.id === tabId) : tabs.find((x) => x.id === activeId);
    if (!t) throw new Error("No such tab");
    return t;
  }
  function asBrowserTab(t) {
    return {
      id: t.id,
      url: t.url,
      title: pageFor(t.url).title,
      active: t.id === activeId,
      isLoading: false,
      canGoBack: t.idx > 0,
      canGoForward: t.idx < t.hist.length - 1,
    };
  }
  const first = newTab("about:blank");
  activeId = first.id;
  const log = (name, args, ret) => { browserCalls.push({ name, args }); return ret; };
  return {
    listTabs: async () => log("listTabs", {}, tabs.map(asBrowserTab)),
    getCurrentTab: async () => log("getCurrentTab", {}, activeId ? asBrowserTab(active()) : null),
    createTab: async (url, activate) => {
      const t = newTab(url);
      if (activate !== false) activeId = t.id;
      return log("createTab", { url }, asBrowserTab(t));
    },
    closeTab: async (tabId) => {
      const t = active(tabId);
      const i = tabs.indexOf(t);
      tabs.splice(i, 1);
      const newActive = tabs[Math.max(0, i - 1)] || null;
      activeId = newActive ? newActive.id : null;
      return log("closeTab", { tabId }, { success: true, closedTabId: t.id, newActiveTabId: activeId });
    },
    switchTab: async (tabId) => {
      const t = active(tabId);
      activeId = t.id;
      return log("switchTab", { tabId }, asBrowserTab(t));
    },
    navigate: async (url, tabId) => {
      const t = active(tabId);
      t.hist = t.hist.slice(0, t.idx + 1).concat([url]);
      t.idx += 1;
      t.url = url;
      return log("navigate", { url }, asBrowserTab(t));
    },
    goBack: async (tabId) => {
      const t = active(tabId);
      if (t.idx > 0) { t.idx -= 1; t.url = t.hist[t.idx]; }
      return log("goBack", {}, { success: true });
    },
    goForward: async (tabId) => {
      const t = active(tabId);
      if (t.idx < t.hist.length - 1) { t.idx += 1; t.url = t.hist[t.idx]; }
      return log("goForward", {}, { success: true });
    },
    reload: async () => log("reload", {}, { success: true }),
    stop: async () => log("stop", {}, { success: true }),
    getContent: async (format, tabId) => {
      const t = active(tabId);
      const p = pageFor(t.url);
      return log("getContent", { format }, format === "html" ? { url: t.url, html: p.html } : { url: t.url, title: p.title, text: p.text });
    },
    executeJS: async (code, tabId) => log("executeJS", { code: String(code) }, { result: `js-ok:${String(code).slice(0, 40)}` }),
    click: async (selector) => log("click", { selector }, { success: true, found: true, selector }),
    fill: async (selector, value) => log("fill", { selector, value }, { success: true, found: true, selector }),
    waitFor: async (selector) => log("waitFor", { selector }, { found: true, selector, elapsed: 0 }),
    screenshot: async () => {
      const b64 = Buffer.from("e2e-shot").toString("base64");
      return log("screenshot", {}, { screenshot: b64, dataUrl: "data:image/png;base64," + b64, format: "png" });
    },
    getCookies: async () => log("getCookies", {}, { cookies: [] }),
    setCookie: async (cookie) => log("setCookie", { cookie }, { success: true }),
    clearCookies: async () => log("clearCookies", {}, { success: true }),
  };
}
const mockController = makeMockController();

// ---- 4) Scripted model server ----
const tag = (m) => (m.match(/\[\[([A-Z]+\d+)\]\]/) || [])[1];
const toolMsg = (name, args) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
});
const textMsg = (t) => ({ choices: [{ message: { role: "assistant", content: t } }] });

// Flags recorded server-side, asserted by rows.
const seen = { toolChoice400: 0, noToolsFallback: false, streamValue: "unset", r1Choices: [] };

// One scripted tool call then a wrap text; `seq` rows handle multi-step.
function oneShot(step, name, args, wrap) {
  return step === 0 ? toolMsg(name, args) : textMsg(wrap || "Done.");
}

function scriptFor(test, step) {
  switch (test) {
    // ---------- 20 bridge tools ----------
    case "B1": return oneShot(step, "browser_navigate", { url: "https://example.com/" }, "Navigated.");
    case "B2": return oneShot(step, "browser_snapshot", {}, "Snapped.");
    case "B3": return oneShot(step, "browser_get_text", {}, "Got text.");
    case "B4": return oneShot(step, "browser_get_html", {}, "Got HTML.");
    case "B5": return oneShot(step, "browser_click", { selector: "a" }, "Clicked.");
    case "B6": return oneShot(step, "browser_fill", { selector: "#q", text: "hello" }, "Filled.");
    case "B7": return oneShot(step, "browser_type", { selector: "#q", text: " world" }, "Typed.");
    case "B8": return oneShot(step, "browser_select_option", { selector: "#s", value: "a" }, "Selected.");
    case "B9": return oneShot(step, "browser_press_key", { key: "Enter" }, "Pressed.");
    case "B10": return oneShot(step, "browser_scroll", { deltaY: 600 }, "Scrolled.");
    case "B11": return oneShot(step, "browser_highlight", { selector: "h1" }, "Highlighted.");
    case "B12": return oneShot(step, "browser_take_screenshot", {}, "Shot.");
    case "B13": return oneShot(step, "browser_reload", {}, "Reloaded.");
    case "B14":
      if (step === 0) return toolMsg("browser_navigate", { url: "https://example.org/" });
      if (step === 1) return toolMsg("browser_back", {});
      return textMsg("Went back.");
    case "B15": return oneShot(step, "browser_forward", {}, "Went forward.");
    case "B16": // exercises the op-alias fix in dispatchBrowserTabs (op:new_tab, op:list)
      if (step === 0) return toolMsg("browser_tabs", { op: "new_tab", url: "https://example.org/" });
      if (step === 1) return toolMsg("browser_tabs", { op: "list" });
      return textMsg("Tabs managed.");
    case "B17": // op:switch_tab / op:close_tab normalization
      if (step === 0) return toolMsg("browser_tabs", { op: "switch_tab", tabId: "tab_1" });
      if (step === 1) return toolMsg("browser_tabs", { op: "close_tab", tabId: "tab_2" });
      return textMsg("Switched and closed.");
    case "B18": return oneShot(step, "browser_cdp", { js: "document.title" }, "Ran JS.");
    case "B19": return oneShot(step, "browser", { input: JSON.stringify({ op: "navigate", url: "https://wikipedia.org/" }) }, "Routed.");
    case "B20": return oneShot(step, "browser", { input: JSON.stringify({ op: "new_tab", url: "https://example.org/" }) }, "Router tab.");
    case "B21": return toolMsg("done", { message: "B21-DONE-MESSAGE" });
    case "B22": return toolMsg("ask_user", { question: "B22-WHICH-TAB?" });

    // ---------- loop robustness ----------
    case "L2": return oneShot(step, "browser_navigate", { url: "https://degraded.example/" }, "Navigated after degradation.");
    case "L4": return oneShot(step, "browser_get_text", {}, "STREAMING-DOC-DONE");
    case "R1": return oneShot(step, "browser_get_text", {}, "R1-DONE");
    default: return textMsg("Done.");
  }
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    const msgs = payload.messages || [];
    const blockText = (c) => (typeof c === "string" ? c : "");
    const test = msgs.map((m) => tag(blockText(m.content))).find(Boolean) || "";
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const step = msgs.filter((m) => blockText(m.content).startsWith("Tool result for")).length;
    const reply = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // L2: tool_choice degradation — reject any request carrying tool_choice.
    // Real loop path: required -> 400 -> auto -> 400 -> omit -> 200.
    if (test === "L2") {
      if (payload.tool_choice !== undefined) {
        seen.toolChoice400 += 1;
        return reply(400, { error: { message: "tool_choice is not supported by this model" } });
      }
      return reply(200, scriptFor(test, step));
    }

    // L3: universal-template fallback — reject requests WITH tools; answer the folded
    // no-tools retry with a textual JSON tool call (parsed by parseJsonToolCalls).
    if (test === "L3") {
      if (hasTools) return reply(400, { error: { message: "this model does not support tools" } });
      seen.noToolsFallback = true;
      return reply(200, step === 0
        ? textMsg(JSON.stringify({ tool: "browser_navigate", url: "https://universal.example/" }))
        : textMsg("UNIVERSAL-TEMPLATE-OK"));
    }

    // L4: record the stream flag the loop actually sends (documents non-streaming loop).
    if (test === "L4") seen.streamValue = payload.stream;

    // R1: record the tool_choice the loop sends per round (required on round 0, then auto).
    if (test === "R1" && hasTools) seen.r1Choices.push(payload.tool_choice);

    // L1: stall guard — same tool call forever; the no-tools wrap-up gets a marker text.
    if (test === "L1") {
      return reply(200, hasTools ? toolMsg("browser_get_text", {}) : textMsg("STALL-BROKEN"));
    }

    // L5: finite-cap wrap-up — fresh tool calls forever (args vary to dodge the stall
    // guard); the no-tools wrap-up call gets a distinctive final answer.
    if (test === "L5") {
      return reply(200, hasTools ? toolMsg("browser_get_text", { probe: step }) : textMsg("CAPPED-ANSWER"));
    }

    return reply(200, scriptFor(test, step));
  });
});

// ---- 5) Run the matrix against the REAL manager ----
async function main() {
  await new Promise((r) => server.listen(MOCK_PORT, "127.0.0.1", r));
  const { LlmConnectionManager } = require(path.join(REPO, "dist-electron/llm-connection.js"));
  const mgr = new LlmConnectionManager(() => mockController);

  const results = [];
  const record = (id, name, pass, detail) => results.push({ id, name, pass, detail });
  const ranTool = (resp, n) => (resp.toolRuns || []).find((t) => t.name === n);
  const resultStr = (run) => (run && typeof run.result === "string" ? run.result : JSON.stringify(run && run.result));
  const calledBrowser = (n, after) => browserCalls.slice(after).find((c) => c.name === n);

  async function run(id, name, prompt, check, opts) {
    const mark = browserCalls.length;
    try {
      writeConfig(opts && opts.config);
      const resp = await mgr.sendPrompt({ prompt: `[[${id}]] ${prompt}` });
      const { pass, detail } = check(resp, mark);
      record(id, name, pass, detail);
    } catch (e) {
      record(id, name, false, "threw: " + (e && e.message));
    }
  }

  // ---------- the 20 bridge tools ----------
  await run("B1", "browser_navigate", "go to example.com", (r, m) => {
    const c = calledBrowser("navigate", m);
    return { pass: !!ranTool(r, "browser_navigate") && !!c && c.args.url === "https://example.com/", detail: c ? "navigated " + c.args.url : "no controller call" };
  });
  await run("B2", "browser_snapshot", "what page am I on", (r) => {
    const run_ = ranTool(r, "browser_snapshot");
    return { pass: !!run_ && resultStr(run_).includes("Example Domain"), detail: run_ ? "snapshot has tab + text" : "no run" };
  });
  await run("B3", "browser_get_text", "read the page", (r) => {
    const run_ = ranTool(r, "browser_get_text");
    return { pass: !!run_ && resultStr(run_).includes("illustrative examples"), detail: run_ ? "text ok" : "no run" };
  });
  await run("B4", "browser_get_html", "get the html", (r) => {
    const run_ = ranTool(r, "browser_get_html");
    return { pass: !!run_ && resultStr(run_).includes("<h1>Example Domain</h1>"), detail: run_ ? "html ok" : "no run" };
  });
  await run("B5", "browser_click", "click the link", (r, m) => {
    const c = calledBrowser("click", m);
    return { pass: !!c && c.args.selector === "a", detail: c ? "clicked " + c.args.selector : "no click" };
  });
  await run("B6", "browser_fill", "fill the box", (r, m) => {
    const c = calledBrowser("fill", m);
    return { pass: !!c && c.args.value === "hello", detail: c ? `filled ${c.args.selector}=${c.args.value}` : "no fill" };
  });
  await run("B7", "browser_type", "type more", (r, m) => {
    const c = calledBrowser("executeJS", m);
    return { pass: !!ranTool(r, "browser_type") && !!c, detail: c ? "type→executeJS" : "no js" };
  });
  await run("B8", "browser_select_option", "select A", (r, m) => {
    const c = calledBrowser("executeJS", m);
    return { pass: !!ranTool(r, "browser_select_option") && !!c, detail: c ? "select→executeJS" : "no js" };
  });
  await run("B9", "browser_press_key", "press enter", (r, m) => {
    const c = calledBrowser("executeJS", m);
    return { pass: !!ranTool(r, "browser_press_key") && !!c, detail: c ? "key→executeJS" : "no js" };
  });
  await run("B10", "browser_scroll", "scroll down", (r, m) => {
    const c = calledBrowser("executeJS", m);
    return { pass: !!c && /scrollBy\(0, 600\)/.test(c.args.code), detail: c ? "scrollBy(0,600)" : "no js" };
  });
  await run("B11", "browser_highlight", "highlight h1", (r, m) => {
    const c = calledBrowser("executeJS", m);
    return { pass: !!ranTool(r, "browser_highlight") && !!c, detail: c ? "highlight→executeJS" : "no js" };
  });
  await run("B12", "browser_take_screenshot", "screenshot", (r) => {
    const run_ = ranTool(r, "browser_take_screenshot");
    return { pass: !!run_ && resultStr(run_).includes("data:image/png;base64"), detail: run_ ? "png dataUrl + bytes" : "no run" };
  });
  await run("B13", "browser_reload", "reload", (r, m) => {
    const c = calledBrowser("reload", m);
    return { pass: !!c, detail: c ? "reloaded" : "no reload" };
  });
  await run("B14", "browser_back", "navigate then back", (r, m) => {
    const c = calledBrowser("goBack", m);
    return { pass: !!c && !!ranTool(r, "browser_back"), detail: c ? "went back" : "no goBack" };
  });
  await run("B15", "browser_forward", "go forward", (r, m) => {
    const c = calledBrowser("goForward", m);
    return { pass: !!c, detail: c ? "went forward" : "no goForward" };
  });
  await run("B16", "browser_tabs op:new_tab + op:list", "open a tab and list", (r, m) => {
    const created = calledBrowser("createTab", m);
    const listed = calledBrowser("listTabs", m);
    const ok = !!created && created.args.url === "https://example.org/" && !!listed;
    return { pass: ok, detail: ok ? "op alias: tab created + listed" : created ? "created but not listed" : "no createTab (op alias broken)" };
  });
  await run("B17", "browser_tabs op:switch_tab + op:close_tab", "switch then close", (r, m) => {
    const sw = calledBrowser("switchTab", m);
    const cl = calledBrowser("closeTab", m);
    const ok = !!sw && sw.args.tabId === "tab_1" && !!cl && cl.args.tabId === "tab_2";
    return { pass: ok, detail: ok ? "switched tab_1, closed tab_2" : "switch/close alias broken" };
  });
  await run("B18", "browser_cdp", "run document.title", (r, m) => {
    const c = calledBrowser("executeJS", m);
    return { pass: !!c && c.args.code.includes("document.title"), detail: c ? "cdp ran js" : "no js" };
  });
  await run("B19", "browser JSON op router (navigate)", "use the generic browser tool", (r, m) => {
    const c = calledBrowser("navigate", m);
    return { pass: !!c && c.args.url === "https://wikipedia.org/", detail: c ? "op:navigate routed" : "not routed" };
  });
  await run("B20", "browser JSON op router → tabs alias", "open a tab via the router", (r, m) => {
    const c = calledBrowser("createTab", m);
    return { pass: !!c && c.args.url === "https://example.org/", detail: c ? "op:new_tab routed to createTab" : "router→tabs alias broken" };
  });
  await run("B21", "done control flow", "finish now", (r) => {
    return { pass: r.content === "B21-DONE-MESSAGE" && !!ranTool(r, "done"), detail: "content=" + String(r.content).slice(0, 40) };
  });
  await run("B22", "ask_user control flow", "ambiguous", (r) => {
    return { pass: r.content === "B22-WHICH-TAB?" && !!ranTool(r, "ask_user"), detail: "question=" + String(r.content).slice(0, 40) };
  });

  // ---------- loop robustness ----------
  await run("L1", "stall guard (breaks at 8 identical rounds)", "loop forever", (r) => {
    const n = (r.toolRuns || []).length;
    const ok = n === 8 && r.content.includes("STALL-BROKEN");
    return { pass: ok, detail: `broke after ${n} identical rounds, wrap="${String(r.content).slice(0, 20)}"` };
  }, { config: { maxToolRounds: 0 } });

  await run("L2", "tool_choice degradation required→auto→omit", "navigate after degradation", (r, m) => {
    const c = calledBrowser("navigate", m);
    const ok = !!c && c.args.url === "https://degraded.example/" && seen.toolChoice400 >= 2;
    return { pass: ok, detail: ok ? `degraded after ${seen.toolChoice400}×400, then navigated` : "no degradation" };
  }, { config: { requireToolUse: true } });

  await run("L3", "universal-template fallback (no-tools model)", "navigate via folded retry", (r, m) => {
    const c = calledBrowser("navigate", m);
    const ok = !!c && c.args.url === "https://universal.example/" && seen.noToolsFallback && r.content.includes("UNIVERSAL-TEMPLATE-OK");
    return { pass: ok, detail: ok ? "tools dropped → JSON tool call parsed from text → executed" : "fallback did not run" };
  });

  await run("L4", "streaming config: loop posts stream:false (documented)", "stream a reply", (r) => {
    const ok = seen.streamValue === false && r.content.includes("STREAMING-DOC-DONE");
    return { pass: ok, detail: `payload.stream=${String(seen.streamValue)} (sendPrompt has no onToken; loop is JSON non-streaming)` };
  }, { config: { enableLlmStreaming: true } });

  await run("L5", "finite-cap wrap-up answer", "never stop calling tools", (r) => {
    const ok = r.content.includes("CAPPED-ANSWER") && (r.toolRuns || []).length === 2;
    return { pass: ok, detail: `rounds=${(r.toolRuns || []).length} content="${String(r.content).slice(0, 30)}"` };
  }, { config: { maxToolRounds: 2 } });

  await run("R1", "requireToolUse: round 0 tool_choice=required, then auto", "force first tool", (r) => {
    const ok = seen.r1Choices[0] === "required" && seen.r1Choices[1] === "auto" && r.content.includes("R1-DONE");
    return { pass: ok, detail: `tool_choice per round: [${seen.r1Choices.join(", ")}]` };
  }, { config: { requireToolUse: true } });

  server.close();
  const pass = results.filter((r) => r.pass).length;
  console.log("\n============ LM_Browser E2E (real agent loop, scripted model) ============");
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${String(r.id).padEnd(4)} ${r.name.padEnd(46)} — ${r.detail}`);
  console.log(`\n  ${pass}/${results.length} passed`);
  fs.rmSync(USERDATA, { recursive: true, force: true });
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
