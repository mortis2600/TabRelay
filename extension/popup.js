"use strict";

const $ = (id) => document.getElementById(id);

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = cls || "";
}

async function load() {
  const cfg = await chrome.storage.local.get(["relayUrl", "apiKey", "pollSeconds", "enabled"]);
  if (cfg.relayUrl) $("relayUrl").value = cfg.relayUrl;
  if (cfg.apiKey) $("apiKey").value = cfg.apiKey;
  if (cfg.pollSeconds) $("pollSeconds").value = String(cfg.pollSeconds);
  $("enabled").checked = cfg.enabled !== false;
}

async function test() {
  const url = $("relayUrl").value.trim().replace(/\/+$/, "");
  const key = $("apiKey").value.trim();
  setStatus("Contacting relay\u2026");
  try {
    const res = await fetch(url + "/health", { headers: { "X-API-Key": key } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    setStatus(`Relay OK (v${body.version}, ${body.queued} queued)`, "ok");
  } catch (e) {
    setStatus("Failed: " + e.message, "err");
  }
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    relayUrl: $("relayUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    pollSeconds: Number($("pollSeconds").value),
    enabled: $("enabled").checked,
  });
  setStatus("Saved. Polling restarts automatically.", "ok");
});

$("test").addEventListener("click", test);

load();
