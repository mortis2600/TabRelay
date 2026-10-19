/* TabRelay content script: executes DOM actions inside a tab.
 * Only responds to messages from our own background worker.
 */
"use strict";

function setNativeValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function handle(msg) {
  switch (msg.type) {
    case "page.text": {
      const text = document.body ? document.body.innerText : "";
      return { text: (text || "").slice(0, 200000), truncated: (text || "").length > 200000 };
    }

    case "page.title":
      return { title: document.title, url: location.href };

    case "dom.exists": {
      const els = document.querySelectorAll(msg.selector);
      return { exists: els.length > 0, count: els.length };
    }

    case "dom.click": {
      const el = document.querySelector(msg.selector);
      if (!el) throw new Error("no such element: " + msg.selector);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.click();
      return { clicked: true };
    }

    case "dom.type": {
      const el = document.querySelector(msg.selector);
      if (!el) throw new Error("no such element: " + msg.selector);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus();
      const append = msg.append === true;
      if (el.isContentEditable) {
        if (!append) el.textContent = "";
        el.textContent = (el.textContent || "") + msg.text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      } else if ("value" in el) {
        const next = append ? (el.value || "") + msg.text : msg.text;
        setNativeValue(el, next);
      } else {
        throw new Error("element is not editable: " + msg.selector);
      }
      if (msg.submit) {
        const form = el.closest("form");
        if (form) {
          if (form.requestSubmit) form.requestSubmit();
          else form.submit();
        } else {
          el.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
          );
        }
      }
      return { typed: true };
    }

    default:
      throw new Error("unknown content action: " + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.from !== "tabrelay-bg") return false;
  handle(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});
