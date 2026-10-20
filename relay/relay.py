#!/usr/bin/env python3
"""TabRelay relay server.

A tiny keyed HTTP relay between an agent (or script) and the TabRelay Chrome
extension. The extension polls this server for commands, executes them in a
browser tab, and posts the results back.

Zero dependencies -- Python 3.8+ stdlib only.

API (all /api/* routes require the API key, via the X-API-Key header or the
?key= query parameter):

    GET  /health                      -> {"ok": true, ...}            (no auth)
    POST /api/commands  {action, params} -> {"id": ..., "status": "queued"}
    GET  /api/commands/next?timeout=N -> next command, or 204 if none in N sec
    POST /api/results   {id, ok, data, error} -> {"status": "recorded"}
    GET  /api/results/<id>?timeout=N -> the result, or 204 if none in N sec
    GET  /api/queue                   -> {"queued": N}

The key is taken from --key, the TABRELAY_KEY env var, or generated once and
stored at ~/.config/tabrelay/key (mode 0600).
"""

import argparse
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

VERSION = "0.1.0"
CONFIG_DIR = os.path.expanduser("~/.config/tabrelay")
KEY_FILE = os.path.join(CONFIG_DIR, "key")


def load_or_create_key(explicit=None):
    if explicit:
        return explicit
    env = os.environ.get("TABRELAY_KEY")
    if env:
        return env.strip()
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    os.makedirs(CONFIG_DIR, exist_ok=True)
    key = "trl_" + secrets.token_urlsafe(32)
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(key)
    print(f"[tabrelay] generated new API key, stored at {KEY_FILE}", file=sys.stderr)
    return key


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.commands = deque()
        self.results = {}  # id -> result dict


class Handler(BaseHTTPRequestHandler):
    server_version = "TabRelay/" + VERSION

    # -- helpers -----------------------------------------------------------
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _no_content(self):
        self.send_response(204)
        self.end_headers()

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return "INVALID"

    def _authorized(self, parsed):
        # constant-time compare; accept header or query param
        provided = self.headers.get("X-API-Key", "")
        if not provided:
            q = parse_qs(parsed.query).get("key", [""])[0]
            provided = q
        return hmac.compare_digest(provided, self.server.api_key)

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[tabrelay] " + fmt % args + "\n")

    def do_OPTIONS(self):
        # CORS preflight for content-script fetches to /api/files/.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-API-Key, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        # Chrome Private Network Access: public HTTPS pages (the content
        # script's context) fetching loopback must see this on the preflight,
        # or the fetch dies with "Failed to fetch" (found 2026-10-20, DTRPG
        # cover upload on tools.drivethrurpg.com).
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    # -- routing -----------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        st = self.server.state

        if path == "/health":
            with st.lock:
                queued = len(st.commands)
            self._json(200, {"ok": True, "version": VERSION, "queued": queued})
            return

        if not path.startswith("/api/"):
            self._json(404, {"ok": False, "error": "not found"})
            return
        if not self._authorized(parsed):
            self._json(401, {"ok": False, "error": "bad or missing API key"})
            return

        if path == "/api/commands/next":
            timeout = self._timeout(parsed, default=25.0)
            with st.cond:
                if not st.commands:
                    st.cond.wait(timeout=timeout)
                if st.commands:
                    cmd = st.commands.popleft()
                    self._json(200, cmd)
                else:
                    self._no_content()
            return

        if path == "/api/queue":
            with st.lock:
                self._json(200, {"queued": len(st.commands)})
            return

        if path.startswith("/api/files/"):
            # Serve files from the files directory for dom.upload.
            # The content script fetches directly (with API key header).
            import os
            files_dir = os.environ.get("TABRELAY_FILES", "/opt/tabrelay/files")
            name = path[len("/api/files/"):]
            # Prevent directory traversal.
            if ".." in name or name.startswith("/") or not name:
                self._json(400, {"ok": False, "error": "invalid filename"})
                return
            fpath = os.path.join(files_dir, name)
            if not os.path.isfile(fpath):
                self._json(404, {"ok": False, "error": "file not found"})
                return
            # Stream the file with CORS headers for content-script fetches.
            ctype = "application/pdf" if name.lower().endswith(".pdf") else "application/octet-stream"
            try:
                fsize = os.path.getsize(fpath)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(fsize))
                self.send_header("Content-Disposition", f'attachment; filename="{name}"')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "X-API-Key, Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.end_headers()
                with open(fpath, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if path.startswith("/api/results/"):
            cmd_id = path[len("/api/results/"):]
            timeout = self._timeout(parsed, default=30.0)
            with st.cond:
                result = st.results.pop(cmd_id, None)
                if result is None:
                    st.cond.wait(timeout=timeout)
                    result = st.results.pop(cmd_id, None)
                if result is None:
                    self._no_content()
                else:
                    self._json(200, result)
            return

        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        st = self.server.state

        if not path.startswith("/api/") or not self._authorized(parsed):
            self._json(401, {"ok": False, "error": "bad or missing API key"})
            return

        body = self._read_json()
        if body is None or body == "INVALID":
            self._json(400, {"ok": False, "error": "expected a JSON body"})
            return

        if path == "/api/commands":
            action = body.get("action")
            if not action or not isinstance(action, str):
                self._json(400, {"ok": False, "error": "missing 'action'"})
                return
            cmd = {
                "id": uuid.uuid4().hex[:12],
                "action": action,
                "params": body.get("params") or {},
            }
            with st.cond:
                st.commands.append(cmd)
                st.cond.notify_all()
            self._json(200, {"id": cmd["id"], "status": "queued"})
            return

        if path == "/api/results":
            cmd_id = body.get("id")
            if not cmd_id:
                self._json(400, {"ok": False, "error": "missing 'id'"})
                return
            result = {
                "id": cmd_id,
                "ok": bool(body.get("ok")),
                "data": body.get("data"),
                "error": body.get("error"),
            }
            with st.cond:
                st.results[cmd_id] = result
                st.cond.notify_all()
            self._json(200, {"status": "recorded"})
            return

        self._json(404, {"ok": False, "error": "not found"})

    def _timeout(self, parsed, default):
        try:
            t = float(parse_qs(parsed.query).get("timeout", [default])[0])
        except (ValueError, TypeError):
            t = default
        return max(0.0, min(t, 120.0))


def main():
    ap = argparse.ArgumentParser(description="TabRelay keyed command relay server")
    ap.add_argument("--host", default="127.0.0.1",
                    help="interface to bind (default 127.0.0.1; use a Tailscale IP to expose on the tailnet)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--key", default=None,
                    help="API key (or TABRELAY_KEY env var, or ~/.config/tabrelay/key)")
    args = ap.parse_args()

    key = load_or_create_key(args.key)
    key_hash = hashlib.sha256(key.encode()).hexdigest()[:12]

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.api_key = key
    server.state = State()

    print(f"[tabrelay] v{VERSION} listening on http://{args.host}:{args.port} (key sha256:{key_hash}...)", file=sys.stderr)
    if args.host in ("0.0.0.0", ""):
        print("[tabrelay] WARNING: bound to all interfaces; prefer a Tailscale IP", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[tabrelay] shutting down", file=sys.stderr)


if __name__ == "__main__":
    main()
