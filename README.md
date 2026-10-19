# TabRelay

Keyed remote control for browser tabs. A Chrome extension polls a small relay
server for commands, executes them in a tab, and posts the results back. An
agent (or script) with the API key drives the browser: navigate, read pages,
click, type, screenshot.

```
 agent/script                relay server               Chrome extension
┌──────────────┐  API key   ┌──────────────┐  long-poll  ┌──────────────────┐
│ client.py    │ ─────────▶ │ relay.py     │ ◀────────── │ background.js    │
│ (or curl)    │ ◀───────── │ :8765        │ ──────────▶ │  + content.js    │
└──────────────┘  results   └──────────────┘  commands  └──────────────────┘
```

Zero dependencies. The relay is Python 3.8+ stdlib only; the extension is
Manifest V3 with no libraries.

## Quickstart

**1. Run the relay** (on the machine Chrome runs on, or anywhere reachable):

```bash
cd relay
./relay.py --host 127.0.0.1 --port 8765
# first run prints where the generated API key was stored (~/.config/tabrelay/key)
```

**2. Install the extension** in Chrome:

- Open `chrome://extensions`, enable Developer mode, "Load unpacked",
  select the `extension/` folder.
- Click the TabRelay toolbar icon, enter the relay URL and API key, Save.

For headless/always-on deployments, skip the popup and push config via Chrome
managed policy instead (`/etc/opt/chrome/policies/managed/tabrelay.json`):

```json
{
  "relayUrl": { "Value": "http://127.0.0.1:8765" },
  "apiKey":   { "Value": "trl_..." },
  "enabled":  { "Value": true }
}
```

**3. Send a command:**

```bash
cd relay
export TABRELAY_KEY=trl_...
./client.py tabs.list
./client.py tabs.goto url="https://example.com"
./client.py page.text
./client.py dom.click selector="#submit"
./client.py dom.type selector="#q" text="hello" submit=true
./client.py page.screenshot > shot.json
```

Raw HTTP works too: `POST /api/commands` with `{"action": ..., "params": {...}}`,
then `GET /api/results/<id>?timeout=60`. Auth via the `X-API-Key` header
(or `?key=`).

## Deployment

Mesh-first, tunnel as fallback.

**Mesh (recommended):** run `deploy/deploy-mesh.sh` on the relay host. It
installs Tailscale, joins your tailnet with an auth key, and binds the relay
to the Tailscale IP so any tailnet peer with the API key can reach it:

```bash
TS_AUTH_KEY=tskey-auth-... ./deploy/deploy-mesh.sh
# optional: TS_HOSTNAME=my-relay RELAY_PORT=8765
```

Generate the auth key at `https://login.tailscale.com/admin/settings/keys`
(Settings → Keys). The key is only used at join time and is never stored.
The script installs a `tabrelay-relay.service` systemd unit and prints the
tailnet URL when the relay is up.

**Tunnel fallback:** when the mesh is unreachable, forward the relay port
over SSH instead — the client then talks to `http://127.0.0.1:8765` locally:

```bash
ssh -J <jump-host> -L 8765:127.0.0.1:8765 <user>@<relay-host>
```

(`tunnel.sh` in this repo is one deployment's watchdog version of this
pattern; adapt the hosts to yours.)

## Actions

| action | params | returns |
|---|---|---|
| `tabs.list` | — | `[{id, url, title, active}]` |
| `tabs.goto` | `url`, optional `tabId` | navigates (or opens) a tab; returns immediately — use `tabs.ready` to wait |
| `tabs.ready` | optional `tabId`, `timeoutMs` (default 30000) | waits for the tab to finish loading (survives worker suspension) |
| `tabs.close` | optional `tabId` | closes the tab (default: active) |
| `tabs.activate` | optional `tabId` | focuses the tab |
| `page.text` | optional `tabId` | visible text (200k char cap) |
| `page.title` | optional `tabId` | `{title, url}` |
| `page.screenshot` | optional `tabId` | `{image}` JPEG data URL |
| `page.wait` | `ms` (max 30000) | — |
| `dom.exists` | `selector`, optional `tabId` | `{exists, count}` |
| `dom.click` | `selector`, optional `tabId` | clicks the element |
| `dom.type` | `selector`, `text`, optional `tabId`, `append`, `submit` | types with real input events (React-safe) |

`tabId` defaults to the active tab. Selectors are CSS (`#id`, `.class`, `input[name=q]`).

## Security model

- Every `/api/*` call needs the API key (constant-time compare). There is no
  unauthenticated control path.
- Bind the relay to localhost or a Tailscale IP. Do not expose it to the
  public internet; the threat model is "anyone with the key drives the
  browser", so treat the key like a password and rotate it by replacing the
  key file / policy value.
- The extension shows a red badge on the toolbar icon while a command
  executes, and the popup has an Enabled kill-switch.
- Nothing phones home. The extension only ever talks to the relay URL you
  configure.

## Limitations

- Manifest V3 service workers sleep, so the extension polls (30s minimum via
  `chrome.alarms`, plus long-polling and a 4-minute hot loop per wake for
  near-realtime response while active). Expect seconds of latency, not
  milliseconds.
- Extensions cannot touch `chrome://` pages or the Web Store.
- This cannot be distributed via the Chrome Web Store (remote-control code
  violates store policy). Install unpacked / via policy. That is the intended
  distribution for a self-hosted tool.

## Roadmap

- File download capture, cookie jar read, multi-profile support
- Optional WebSocket transport for sub-second latency
- Firefox port (same relay protocol)

## License

MIT. See LICENSE.
