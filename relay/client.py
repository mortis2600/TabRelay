#!/usr/bin/env python3
"""TabRelay agent CLI.

Enqueue a command on the relay server and wait for the extension to execute
it, printing the result as JSON.

Usage:
    client.py [--url URL] [--key KEY] [--timeout SEC] <action> [key=value ...]

Values are JSON-decoded when possible, so numbers, booleans and quoted
strings all work:  client.py dom.type selector=#q text="hello" submit=true

The key is taken from --key, the TABRELAY_KEY env var, or
~/.config/tabrelay/key. The URL defaults to TABRELAY_URL or
http://127.0.0.1:8765.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

KEY_FILE = os.path.expanduser("~/.config/tabrelay/key")


def resolve_key(explicit):
    if explicit:
        return explicit
    env = os.environ.get("TABRELAY_KEY")
    if env:
        return env.strip()
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as f:
            return f.read().strip()
    sys.exit("no API key: pass --key, set TABRELAY_KEY, or save one at " + KEY_FILE)


def api(url, key, method, path, body=None, timeout=35):
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"X-API-Key": key, "Content-Type": "application/json",
                 "User-Agent": "TabRelay-Client/0.1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            if res.status == 204:
                return None
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode()).get("error", e.reason)
        except Exception:
            detail = e.reason
        sys.exit(f"relay error HTTP {e.code}: {detail}")
    except OSError as e:
        sys.exit(f"cannot reach relay at {url}: {e}")


def parse_params(pairs):
    params = {}
    for pair in pairs:
        if "=" not in pair:
            sys.exit(f"bad param {pair!r}: expected key=value")
        k, v = pair.split("=", 1)
        try:
            params[k] = json.loads(v)
        except ValueError:
            params[k] = v
    return params


def main():
    ap = argparse.ArgumentParser(description="Send a TabRelay command and wait for the result")
    ap.add_argument("--url", default=os.environ.get("TABRELAY_URL", "http://127.0.0.1:8765"))
    ap.add_argument("--key", default=None)
    ap.add_argument("--timeout", type=float, default=120,
                    help="seconds to wait for the result (default 120)")
    ap.add_argument("action")
    ap.add_argument("params", nargs="*", help="key=value pairs")
    args = ap.parse_args()

    key = resolve_key(args.key)
    cmd = api(args.url, key, "POST", "/api/commands",
              {"action": args.action, "params": parse_params(args.params)})
    result = api(args.url, key, "GET", f"/api/results/{cmd['id']}?timeout={args.timeout}",
                 timeout=args.timeout + 10)
    if result is None:
        sys.exit(f"timed out after {args.timeout}s waiting for result of {cmd['id']}")
    print(json.dumps(result, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
