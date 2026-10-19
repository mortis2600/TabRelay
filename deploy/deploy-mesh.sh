#!/bin/bash
# TabRelay mesh-first deployment.
#
# Sets up Tailscale on this machine and joins it to your tailnet, then binds
# the TabRelay relay server to the Tailscale IP so any tailnet peer with the
# API key can drive the browser. The SSH tunnel (tunnel.sh) stays as the
# fallback path when the mesh is unreachable.
#
# Usage:
#   TS_AUTH_KEY=tskey-auth-... ./deploy/deploy-mesh.sh
#
# Optional:
#   TS_HOSTNAME=my-relay        # tailnet machine name (default: tabrelay)
#   RELAY_PORT=8765             # relay listen port (default: 8765)
#
# The auth key is a Tailscale auth key (admin console -> Settings -> Keys).
# Use a reusable or ephemeral key; it is only needed at join time and is
# never stored. Generate one at https://login.tailscale.com/admin/settings/keys
set -u

TS_HOSTNAME="${TS_HOSTNAME:-tabrelay}"
RELAY_PORT="${RELAY_PORT:-8765}"

if [ -z "${TS_AUTH_KEY:-}" ]; then
  echo "error: TS_AUTH_KEY is not set." >&2
  echo "Generate a Tailscale auth key at https://login.tailscale.com/admin/settings/keys" >&2
  echo "then run: TS_AUTH_KEY=tskey-auth-... $0" >&2
  exit 1
fi

# Resolve the repo root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RELAY_PY="$REPO_DIR/relay/relay.py"
if [ ! -f "$RELAY_PY" ]; then
  echo "error: cannot find relay.py at $RELAY_PY" >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if ! sudo -n true 2>/dev/null; then
    echo "error: this script needs root (for install + systemd). Run with sudo or as root." >&2
    exit 1
  fi
  SUDO="sudo"
fi

# 1. Install Tailscale if missing (official installer; client is BSD-3-Clause).
if ! command -v tailscale >/dev/null 2>&1; then
  echo "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | $SUDO sh
fi

# 2. Join the tailnet (skip if already logged in).
if tailscale status >/dev/null 2>&1; then
  echo "Tailscale already up; skipping join."
else
  echo "Joining tailnet as $TS_HOSTNAME..."
  $SUDO tailscale up --auth-key="$TS_AUTH_KEY" --hostname="$TS_HOSTNAME"
fi

TS_IP="$(tailscale ip -4 | head -1)"
if [ -z "$TS_IP" ]; then
  echo "error: could not determine Tailscale IPv4 address." >&2
  exit 1
fi
echo "Tailnet IP: $TS_IP"

# 3. Install the relay systemd unit, bound to the Tailscale IP only
#    (per the README security model: localhost or a Tailscale IP, never 0.0.0.0).
UNIT_SRC="$SCRIPT_DIR/tabrelay-relay.service"
UNIT_DST="/etc/systemd/system/tabrelay-relay.service"
sed -e "s|@RELAY_PY@|$RELAY_PY|" \
    -e "s|@TS_IP@|$TS_IP|" \
    -e "s|@RELAY_PORT@|$RELAY_PORT|" \
    "$UNIT_SRC" | $SUDO tee "$UNIT_DST" >/dev/null
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now tabrelay-relay.service
sleep 2

if systemctl is-active --quiet tabrelay-relay.service; then
  echo "Relay is up on the mesh: http://$TS_IP:$RELAY_PORT"
else
  echo "error: tabrelay-relay.service failed to start; check 'journalctl -u tabrelay-relay'." >&2
  exit 1
fi

echo
echo "API key: the relay generates one on first run at ~/.config/tabrelay/key"
echo "         (for the 'tabrelay' user if installed as a system service)."
echo "Distribute the key + relay/client.py to whoever should drive the browser."
echo "Fallback: if the mesh is unreachable, tunnel the port over SSH instead"
echo "         (see README 'Deployment: tunnel fallback')."
