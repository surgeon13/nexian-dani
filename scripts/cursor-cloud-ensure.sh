#!/usr/bin/env bash
# Idempotent health check for Cursor Cloud Automations / agents.
# Restarts the 24/7 stack if keep-alive or dashboard is down.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TMUX_CFG="/exec-daemon/tmux.portal.conf"
TMUX=(tmux)
if [[ -f "$TMUX_CFG" ]]; then
  TMUX=(tmux -f "$TMUX_CFG")
fi

KEEP_SESSION="${KEEP_SESSION:-nexian-keep}"
DASH_URL="${DASH_URL:-http://127.0.0.1:3847/api/status}"
STALE_HEARTBEAT_MINUTES="${STALE_HEARTBEAT_MINUTES:-5}"

bash "$ROOT/scripts/materialize-dotenv.sh"

need_restart=0

if ! pgrep -f 'scripts/keep-alive.sh' >/dev/null 2>&1; then
  echo "[cursor-cloud-ensure] keep-alive process missing"
  need_restart=1
fi

if ! curl -sf --max-time 5 "$DASH_URL" >/dev/null 2>&1; then
  echo "[cursor-cloud-ensure] dashboard down"
  need_restart=1
fi

if [[ -f "$ROOT/keep-alive.log" ]]; then
  age_m=$(( ( $(date +%s) - $(stat -c %Y "$ROOT/keep-alive.log") ) / 60 ))
  if [[ "$age_m" -ge "$STALE_HEARTBEAT_MINUTES" ]]; then
    echo "[cursor-cloud-ensure] keep-alive.log stale ${age_m}m"
    need_restart=1
  fi
else
  echo "[cursor-cloud-ensure] keep-alive.log missing"
  need_restart=1
fi

if [[ "$need_restart" -eq 1 ]]; then
  echo "[cursor-cloud-ensure] restarting 24/7 stack..."
  bash "$ROOT/scripts/start-24-7.sh"
  # Brief wait for dashboard
  for _ in $(seq 1 30); do
    sleep 2
    if curl -sf --max-time 5 "$DASH_URL" >/dev/null 2>&1; then
      echo "[cursor-cloud-ensure] dashboard healthy"
      exit 0
    fi
  done
  echo "[cursor-cloud-ensure] WARNING: dashboard still down after restart" >&2
  exit 1
fi

echo "[cursor-cloud-ensure] ok — keep-alive + dashboard healthy"
"${TMUX[@]}" ls 2>/dev/null || true
tail -n 5 "$ROOT/keep-alive.log" 2>/dev/null || true
