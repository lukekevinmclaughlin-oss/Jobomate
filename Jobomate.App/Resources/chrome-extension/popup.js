function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (res) => {
    const el = document.getElementById("status");
    if (!res) { el.innerHTML = '<span class="dot" style="background:#888"></span>Background not ready'; return; }
    if (res.paused) {
      el.innerHTML = '<span class="dot" style="background:#E0A23B"></span>Paused — please finish the login/CAPTCHA in the tab, then Resume.';
    } else if (res.connected) {
      el.innerHTML = '<span class="dot" style="background:#3BA776"></span>Connected to Jobomate.';
    } else {
      el.innerHTML = '<span class="dot" style="background:#E5534B"></span>Not connected. Open Jobomate and click Reconnect.';
    }
  });
}

document.getElementById("sendBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "sendActive" }, () => { window.close(); });
});
document.getElementById("resumeBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "resume" }, () => refresh());
});
document.getElementById("reconnectBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});

refresh();
