#!/usr/bin/env bash
# Keep Nexian bot + network sampler running 24/7.
# Restarts the bot if the process dies, the dashboard stops answering,
# or automation logs go stale while loops are expected to be active.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TMUX_CFG="/exec-daemon/tmux.portal.conf"
TMUX=(tmux)
if [[ -f "$TMUX_CFG" ]]; then
  TMUX=(tmux -f "$TMUX_CFG")
fi

BOT_SESSION="${BOT_SESSION:-nexian-dani}"
NET_SESSION="${NET_SESSION:-net-usage}"
KEEP_SESSION="${KEEP_SESSION:-nexian-keep}"
DASH_URL="${DASH_URL:-http://127.0.0.1:3847/api/status}"
STALE_MINUTES="${STALE_MINUTES:-20}"
CHECK_SECONDS="${CHECK_SECONDS:-15}"
# After a restart, wait this long before treating a still-old log.jsonl as stalled.
# Prevents restart loops while the bot is logging in / waiting for the first loop tick.
STALE_GRACE_MINUTES="${STALE_GRACE_MINUTES:-5}"
LOG_FILE="${LOG_FILE:-$ROOT/keep-alive.log}"
LAST_RESTART_EPOCH=0

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$msg" | tee -a "$LOG_FILE" >/dev/null
  echo "$msg"
}

ensure_session() {
  local name="$1"
  "${TMUX[@]}" has-session -t "=$name" 2>/dev/null && return 0
  "${TMUX[@]}" new-session -d -s "$name" -c "$ROOT" -- "${SHELL:-bash}" -l
  log "created tmux session $name"
}

pane_running_login() {
  pgrep -f 'node --max-old-space-size=768 login.js' >/dev/null 2>&1
}

dashboard_ok() {
  curl -sf --max-time 5 "$DASH_URL" >/dev/null 2>&1
}

file_age_minutes() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo 99999
    return
  fi
  local mtime now
  mtime=$(stat -c %Y "$path" 2>/dev/null || echo 0)
  now=$(date +%s)
  echo $(( (now - mtime) / 60 ))
}

minutes_since_restart() {
  local now
  now=$(date +%s)
  if [[ "$LAST_RESTART_EPOCH" -le 0 ]]; then
    echo 99999
    return
  fi
  echo $(( (now - LAST_RESTART_EPOCH) / 60 ))
}

start_bot() {
  ensure_session "$BOT_SESSION"
  # Clear any leftover prompt, then launch dashboard mode.
  "${TMUX[@]}" send-keys -t "$BOT_SESSION:0.0" C-c
  sleep 0.4
  "${TMUX[@]}" send-keys -t "$BOT_SESSION:0.0" "cd '$ROOT' && npm run dashboard" Enter
  log "started bot in tmux session $BOT_SESSION"
}

stop_bot() {
  if pane_running_login; then
    "${TMUX[@]}" send-keys -t "$BOT_SESSION:0.0" "Q" Enter 2>/dev/null || true
    sleep 2
    pkill -f 'node --max-old-space-size=768 login.js' 2>/dev/null || true
    sleep 1
  fi
}

restart_bot() {
  local reason="$1"
  log "restarting bot ($reason)"
  stop_bot
  start_bot
  LAST_RESTART_EPOCH=$(date +%s)
  # Wait for dashboard to come back.
  local i
  for i in $(seq 1 40); do
    sleep 3
    if dashboard_ok; then
      log "bot dashboard healthy after restart (stale-check grace ${STALE_GRACE_MINUTES}m)"
      return 0
    fi
  done
  log "WARNING: dashboard still down after restart wait"
  return 1
}

start_net_usage() {
  ensure_session "$NET_SESSION"
  if pgrep -f 'sample-once.sh' >/dev/null 2>&1; then
    return 0
  fi
  if [[ ! -x "$ROOT/network-usage/sample-once.sh" ]]; then
    log "net-usage sampler missing; skip"
    return 0
  fi
  "${TMUX[@]}" send-keys -t "$NET_SESSION:0.0" C-c
  sleep 0.3
  "${TMUX[@]}" send-keys -t "$NET_SESSION:0.0" "cd '$ROOT/network-usage' && while true; do ./sample-once.sh || true; sleep 60; done" Enter
  log "started network-usage sampler in tmux session $NET_SESSION"
}

automation_expected() {
  # If .env enables any of the main loops, expect fresh activity logs.
  rg -q '^(FARMLIST_LOOP_ENABLED|BUILDER_LOOP_ENABLED|TROOP_TRAINING_ROUND_ROBIN_ENABLED|TOP10_TRACKING_ENABLED|ACTIVITY_SIMULATION_ENABLED)=true' "$ROOT/.env" 2>/dev/null
}

log "keep-alive starting (stale=${STALE_MINUTES}m check=${CHECK_SECONDS}s grace=${STALE_GRACE_MINUTES}m)"
ensure_session "$BOT_SESSION"
ensure_session "$NET_SESSION"
start_net_usage

if ! pane_running_login || ! dashboard_ok; then
  restart_bot "initial ensure"
fi

while true; do
  start_net_usage

  if ! pane_running_login; then
    restart_bot "login.js not running"
  elif ! dashboard_ok; then
    restart_bot "dashboard API down"
  else
    age=$(file_age_minutes "$ROOT/log.jsonl")
    grace_age=$(minutes_since_restart)
    log "heartbeat bot=up dash=up log_age=${age}m restart_age=${grace_age}m"
    if automation_expected; then
      if [[ "$age" -ge "$STALE_MINUTES" ]]; then
        if [[ "$grace_age" -lt "$STALE_GRACE_MINUTES" ]]; then
          log "log.jsonl stale ${age}m but within ${STALE_GRACE_MINUTES}m post-restart grace — skip"
        else
          # During intentional session rest, automation is paused — don't thrash.
          paused=$(curl -sf --max-time 5 "$DASH_URL" 2>/dev/null | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)["status"]
  a=d.get("automation") or {}
  print("1" if a.get("paused") else "0")
except Exception:
  print("0")' 2>/dev/null || echo 0)
          if [[ "$paused" == "1" ]]; then
            log "log.jsonl stale ${age}m but automation paused (likely session rest) — skip restart"
          else
            restart_bot "log.jsonl stale ${age}m while online"
          fi
        fi
      fi
    fi
  fi

  sleep "$CHECK_SECONDS"
done
