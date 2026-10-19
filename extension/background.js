/* TabRelay background service worker (Manifest V3).
 *
 * Polls the TabRelay relay server for commands (long-poll), executes them
 * against browser tabs, and posts results back. Configuration comes from
 * managed storage (headless deployments via Chrome policy) with the popup's
 * local storage as an override.
 */
"use strict";

const DEFAULTS = {
  relayUrl: "http://127.0.0.1:8765",
  apiKey: "",
  enabled: true,
  pollSeconds: 30,
};
const ALARM = "tabrelay-poll";
const LONG_POLL_S = 25;
const MAX_LOOP_MS = 4 * 60 * 1000; // keep the worker hot ~4 min per wake for low latency
let polling = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const managed = await chrome.storage.managed.get(null);
    for (const k of Object.keys(DEFAULTS)) {
      if (managed[k] !== undefined) cfg[k] = managed[k];
    }
  } catch (_e) {
    /* managed storage unavailable */
  }
  try {
    const local = await chrome.storage.local.get(null);
    for (const k of Object.keys(DEFAULTS)) {
      if (local[k] !== undefined && local[k] !== "") cfg[k] = local[k];
    }
  } catch (_e) {
    /* ignore */
  }
  return cfg;
}

async function ensureAlarm() {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM);
  if (cfg.enabled && cfg.apiKey && cfg.relayUrl) {
    // The platform clamps sub-30s periods; long-polling covers the gap.
    const minutes = Math.max(Number(cfg.pollSeconds) || 30, 30) / 60;
    await chrome.alarms.create(ALARM, { periodInMinutes: minutes });
  }
}

async function setBusy(busy) {
  try {
    await chrome.action.setBadgeText({ text: busy ? "\u25CF" : "" });
    if (busy) await chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
    await chrome.action.setTitle({ title: busy ? "TabRelay: executing command" : "TabRelay" });
  } catch (_e) {
    /* ignore */
  }
}

function baseUrl(cfg) {
  return cfg.relayUrl.replace(/\/+$/, "");
}

async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null) {
    return await chrome.tabs.get(Number(tabId));
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active) return active;
  const [first] = await chrome.tabs.query({});
  if (!first) throw new Error("no tabs open");
  return first;
}

async function sendToTab(tab, type, params) {
  const msg = { from: "tabrelay-bg", type, ...(params || {}) };
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, msg);
      if (!res) throw new Error("no response from tab");
      if (!res.ok) throw new Error(res.error || "tab action failed");
      return res.data;
    } catch (e) {
      lastErr = e;
      await sleep(1000);
    }
  }
  // Last resort: force-inject the content script (page may have loaded
  // before the extension was installed) and try once more.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const res = await chrome.tabs.sendMessage(tab.id, msg);
    if (!res) throw new Error("no response from tab");
    if (!res.ok) throw new Error(res.error || "tab action failed");
    return res.data;
  } catch (_e) {
    throw lastErr;
  }
}

async function dispatch(action, p, cmdId) {
  switch (action) {
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
    }

    case "tabs.goto": {
      if (!p.url) throw new Error("tabs.goto needs {url}");
      let tabId;
      if (p.tabId !== undefined && p.tabId !== null) {
        tabId = Number(p.tabId);
        await chrome.tabs.update(tabId, { url: p.url, active: true });
      } else {
        const t = await chrome.tabs.create({ url: p.url, active: true });
        tabId = t.id;
      }
      // Returns immediately; use tabs.ready to wait for the load. (A service
      // worker cannot await past its ~30s suspension window, so the wait is
      // a separate, alarm-driven command.)
      return { navigated: true, tabId };
    }

    case "tabs.ready": {
      const tab = await resolveTab(p.tabId);
      if (tab.status === "complete") return { ready: true, waitedMs: 0 };
      const timeoutMs = Math.max(1000, Math.min(Number(p.timeoutMs) || 30000, 300000));
      // Deferred completion: stash the pending wait in session storage and
      // re-check on short one-shot alarms. Each alarm wakes a fresh worker,
      // so this survives suspension. pollOnce skips posting a result now;
      // checkReadyAlarm posts it when the tab loads (or times out).
      const key = "ready:" + cmdId;
      await chrome.storage.session.set({
        [key]: { tabId: tab.id, cmdId, deadline: Date.now() + timeoutMs, started: Date.now() },
      });
      await chrome.alarms.create("tabrelay-ready-" + cmdId, { when: Date.now() + 1500 });
      return { __deferred: true };
    }

    case "tabs.close": {
      const tab = await resolveTab(p.tabId);
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }

    case "tabs.activate": {
      const tab = await resolveTab(p.tabId);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { activated: tab.id };
    }

    case "page.text": {
      const tab = await resolveTab(p.tabId);
      return await sendToTab(tab, "page.text", {});
    }

    case "page.title": {
      const tab = await resolveTab(p.tabId);
      return await sendToTab(tab, "page.title", {});
    }

    case "dom.exists": {
      if (!p.selector) throw new Error("dom.exists needs {selector}");
      const tab = await resolveTab(p.tabId);
      return await sendToTab(tab, "dom.exists", { selector: p.selector });
    }

    case "dom.click": {
      if (!p.selector) throw new Error("dom.click needs {selector}");
      const tab = await resolveTab(p.tabId);
      return await sendToTab(tab, "dom.click", { selector: p.selector });
    }

    case "dom.type": {
      if (!p.selector) throw new Error("dom.type needs {selector}");
      if (typeof p.text !== "string") throw new Error("dom.type needs {text}");
      const tab = await resolveTab(p.tabId);
      return await sendToTab(tab, "dom.type", {
        selector: p.selector,
        text: p.text,
        append: p.append === true,
        submit: p.submit === true,
      });
    }

    case "page.screenshot": {
      const tab = await resolveTab(p.tabId);
      await chrome.tabs.update(tab.id, { active: true });
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality: 60,
      });
      return { image: dataUrl };
    }

    case "page.wait": {
      // Capped well under the service worker's ~30s suspension window: a
      // longer sleep may never resolve because suspension destroys timers.
      const ms = Math.max(0, Math.min(Number(p.ms) || 0, 20000));
      await sleep(ms);
      return { waitedMs: ms };
    }

    default:
      throw new Error("unknown action: " + action);
  }
}

async function postResult(cfg, result) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(baseUrl(cfg) + "/api/results", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": cfg.apiKey },
        body: JSON.stringify(result),
      });
      if (res.ok) return;
    } catch (_e) {
      /* retry once */
    }
    await sleep(1000);
  }
}

async function pollOnce(cfg) {
  let res;
  try {
    res = await fetch(baseUrl(cfg) + "/api/commands/next?timeout=" + LONG_POLL_S, {
      headers: { "X-API-Key": cfg.apiKey },
    });
  } catch (_e) {
    return "error";
  }
  if (res.status === 204) return "empty";
  if (!res.ok) return "error";

  const cmd = await res.json();
  await setBusy(true);
  let result;
  try {
    const data = await dispatch(cmd.action, cmd.params || {}, cmd.id);
    if (data && data.__deferred) {
      // Completion will be posted later by the alarm handler; nothing to do.
      await setBusy(false);
      return "cmd";
    }
    result = { id: cmd.id, ok: true, data };
  } catch (e) {
    result = { id: cmd.id, ok: false, error: String((e && e.message) || e) };
  }
  await setBusy(false);
  await postResult(cfg, result);
  return "cmd";
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    const cfg = await getConfig();
    if (!cfg.enabled || !cfg.apiKey || !cfg.relayUrl) return;
    const deadline = Date.now() + MAX_LOOP_MS;
    while (Date.now() < deadline) {
      const outcome = await pollOnce(cfg);
      if (outcome === "error") break; // relay unreachable; alarm retries later
      if (outcome === "empty") await sleep(2000);
    }
  } finally {
    polling = false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  if (Object.keys(existing).length === 0) {
    await chrome.storage.local.set({ relayUrl: DEFAULTS.relayUrl, pollSeconds: DEFAULTS.pollSeconds, enabled: true });
  }
  await ensureAlarm();
  pollLoop();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  pollLoop();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    pollLoop();
    return;
  }
  if (alarm.name.startsWith("tabrelay-ready-")) checkReadyAlarm(alarm.name);
});

// Deferred tab-load waiter for tabs.ready. Each firing wakes a fresh worker,
// checks the tab, and either posts the command result or re-arms itself.
async function checkReadyAlarm(alarmName) {
  const key = "ready:" + alarmName.slice("tabrelay-ready-".length);
  let pending;
  try {
    pending = (await chrome.storage.session.get(key))[key];
  } catch (_e) {
    return;
  }
  if (!pending) return;
  const cfg = await getConfig();
  let tab = null;
  try {
    tab = await chrome.tabs.get(pending.tabId);
  } catch (_e) {
    /* tab closed */
  }
  if (tab && tab.status === "complete") {
    await chrome.storage.session.remove(key);
    await postResult(cfg, {
      id: pending.cmdId,
      ok: true,
      data: { ready: true, waitedMs: Date.now() - pending.started },
    });
  } else if (!tab || Date.now() >= pending.deadline) {
    await chrome.storage.session.remove(key);
    await postResult(cfg, {
      id: pending.cmdId,
      ok: false,
      error: tab ? "timed out waiting for tab to finish loading" : "tab was closed while waiting",
    });
  } else {
    await chrome.alarms.create(alarmName, { when: Date.now() + 1500 });
  }
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local" || area === "managed") {
    ensureAlarm();
    pollLoop();
  }
});
