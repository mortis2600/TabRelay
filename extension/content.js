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

    case "dom.html": {
      const el = document.querySelector(msg.selector);
      if (!el) throw new Error("no such element: " + msg.selector);
      return { html: el.outerHTML.slice(0, 2000) };
    }

    case "dom.fill_by_label": {
      // Find an input by the text of its label (in a table cell or label element).
      // Searches for td/label containing the label text, then finds the input in the same row.
      const labelText = msg.label.toLowerCase();
      const cells = Array.from(document.querySelectorAll("td, th, label"));
      let input = null;
      for (const cell of cells) {
        if (cell.textContent.toLowerCase().includes(labelText)) {
          // Look for input in the same table row, or next sibling
          const row = cell.closest("tr");
          if (row) {
            input = row.querySelector('input[type="text"], input:not([type])');
            if (input) break;
          }
          // Try next sibling
          let sib = cell.nextElementSibling;
          while (sib && !input) {
            input = sib.querySelector('input[type="text"], input:not([type])');
            sib = sib.nextElementSibling;
          }
          if (input) break;
        }
      }
      if (!input) throw new Error("no input found for label: " + msg.label);
      // React-safe set
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(input, msg.text);
      else setter.call(input, msg.text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, label: msg.label };
    }

    case "dom.click": {
      const el = document.querySelector(msg.selector);
      if (!el) throw new Error("no such element: " + msg.selector);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.click();
      return { clicked: true };
    }

    case "dom.locate": {
      // Return a clickable point in viewport (CSS pixel) coordinates, for
      // the background worker's trusted CDP click (dom.realclick). A CSS
      // selector often matches a wide wrapper element (e.g. Angular custom
      // elements like <mw-fab-link class="start-chat">) whose center is
      // empty space beside the actual rendered button, so: prefer a visible
      // interactive descendant's box, then verify candidate points with
      // elementFromPoint and pick the center-most point that actually hits
      // the element's subtree.
      // First VISIBLE match wins: pages often carry hidden duplicates of a
      // control earlier in DOM order (e.g. DTRPG's three login.php links,
      // the first being a hidden one), and querySelector's first match
      // would locate a zero-size box (found 2026-10-20 on legacy homepage).
      let el = null;
      for (const cand of document.querySelectorAll(msg.selector)) {
        cand.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = cand.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          el = cand;
          break;
        }
        el = el || cand;
      }
      if (!el) throw new Error("no such element: " + msg.selector);
      await new Promise((r) => setTimeout(r, 60));
      let target = el;
      const inner = el.querySelector(
        "a[href], button, [role='button'], input, [data-e2e-start-button]"
      );
      if (inner) {
        const r = inner.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) target = inner;
      }
      const rect = target.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        throw new Error("element has no visible box: " + msg.selector);
      }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const candidates = [[cx, cy]];
      for (const fx of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        for (const fy of [0.2, 0.35, 0.5, 0.65, 0.8]) {
          candidates.push([rect.left + rect.width * fx, rect.top + rect.height * fy]);
        }
      }
      let best = null;
      let bestD = Infinity;
      for (const [px, py] of candidates) {
        if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) continue;
        const hit = document.elementFromPoint(px, py);
        if (hit && (hit === el || el.contains(hit) || hit === target || target.contains(hit))) {
          const d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
          if (d < bestD) {
            bestD = d;
            best = { x: Math.round(px), y: Math.round(py), hit };
          }
        }
      }
      if (!best) {
        throw new Error("no clickable point found (element covered?): " + msg.selector);
      }
      return {
        x: best.x,
        y: best.y,
        hitTag: best.hit.tagName + "." + String(best.hit.className || "").slice(0, 60),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
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

    case "dom.upload": {
      const el = document.querySelector(msg.selector);
      if (!el) throw new Error("no such element: " + msg.selector);
      if (!(el instanceof HTMLInputElement) || el.type !== "file") {
        throw new Error("element is not a file input: " + msg.selector);
      }
      // Fetch the file directly in the content script (avoids base64 message limits for large files).
      const headers = msg.apiKey ? { "X-API-Key": msg.apiKey } : {};
      const resp = await fetch(msg.url, { headers });
      if (!resp.ok) throw new Error("fetch failed: " + resp.status);
      const blob = await resp.blob();
      const file = new File([blob], msg.filename || "upload.bin", {
        type: msg.mimeType || blob.type || "application/octet-stream",
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { uploaded: true, filename: file.name, size: file.size };
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
