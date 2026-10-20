#!/bin/bash
# TabRelay tunnel watchdog: keeps the SSH tunnels from this VM alive.
# Safe to run frequently; no-ops if up.
#
# Tunnel 1 (relay): localhost:18765 -> 127.0.0.1:8765 on 192.168.0.240 via valhalla-jump.
# Tunnel 2 (vault): the tabrelay VM has no route to Vaultwarden (deli box left
#   the home LAN 2026-10-18; the vault is Tailscale-only now). Chained path:
#   tabrelay-VM 127.0.0.1:18443 -R-> this VM 127.0.0.1:18444 -L-> Valhalla -> 100.108.47.121:80.
#   The VM's Bitwarden extension uses http://127.0.0.1:18443 as its server URL.
set -u
# One instance at a time: concurrent runs race on pkill and kill each other's ssh.
exec 200>/tmp/tabrelay-tunnel.lock
flock -n 200 || exit 0
KEY_FILE="$HOME/.config/tabrelay/key"
PORT=18765
VAULT_LOCAL=18444
VM="tabrelay@192.168.0.240"
SSH_OPTS="-F $HOME/.ssh/config -i $HOME/.ssh/id_ed25519 -o StrictHostKeyChecking=no -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes"

relay_ok=0
vault_ok=0
curl -s -m 6 -o /dev/null -H "X-API-Key: $(cat "$KEY_FILE" 2>/dev/null)" "http://127.0.0.1:$PORT/health" 2>/dev/null && relay_ok=1
curl -s -m 6 -o /dev/null "http://127.0.0.1:$VAULT_LOCAL/" 2>/dev/null && vault_ok=1
[ "$relay_ok" = 1 ] && [ "$vault_ok" = 1 ] && exit 0

# Leg A: this VM -> Valhalla -> Vaultwarden (listener on 127.0.0.1:18444)
if [ "$vault_ok" = 0 ]; then
  pkill -f "18444:100.108.47.121:80" 2>/dev/null
  sleep 1
  # shellcheck disable=SC2086
  ssh $SSH_OPTS -f -N -L "127.0.0.1:$VAULT_LOCAL:100.108.47.121:80" valhalla-jump </dev/null >/dev/null 2>&1
  sleep 2
fi
# Leg B: tabrelay VM listeners (relay 18765 + relay2 18766 + vault -R 18443), via valhalla-jump.
# Restarted when the relay is down OR the vault chain is down, so the -R
# forward always rides a fresh connection.
if [ "$relay_ok" = 0 ] || [ "$vault_ok" = 0 ]; then
  pkill -f "18765:127.0.0.1:8765" 2>/dev/null
  sleep 1
  # shellcheck disable=SC2086
  ssh $SSH_OPTS -J valhalla-jump -f -N \
    -L "$PORT:127.0.0.1:8765" \
    -L "18766:127.0.0.1:8766" \
    -R "127.0.0.1:18443:127.0.0.1:$VAULT_LOCAL" "$VM" </dev/null >/dev/null 2>&1
  sleep 2
fi

ok=1
curl -s -m 6 -o /dev/null -H "X-API-Key: $(cat "$KEY_FILE" 2>/dev/null)" "http://127.0.0.1:$PORT/health" 2>/dev/null || ok=0
curl -s -m 6 -o /dev/null "http://127.0.0.1:$VAULT_LOCAL/" 2>/dev/null || ok=0
if [ "$ok" = 1 ]; then
  echo "$(date -Iseconds) tunnel up (relay + vault)"
else
  echo "$(date -Iseconds) tunnel FAILED"
fi
