#!/usr/bin/env bash
# Start (or restart) the full 24/7 stack: bot dashboard + network sampler + keep-alive watchdog.
set -euo pipefail

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

ensure_session() {
  local name="$1"
  "${TMUX[@]}" has-session -t "=$name" 2>/dev/null && return 0
  "${TMUX[@]}" new-session -d -s "$name" -c "$ROOT" -- "${SHELL:-bash}" -l
}

echo "[start-24-7] preparing tmux sessions..."
ensure_session "$BOT_SESSION"
ensure_session "$NET_SESSION"
ensure_session "$KEEP_SESSION"

chmod +x "$ROOT/scripts/keep-alive.sh"

# Stop previous keep-alive in its session, then launch a fresh one.
"${TMUX[@]}" send-keys -t "$KEEP_SESSION:0.0" C-c
sleep 0.4
"${TMUX[@]}" send-keys -t "$KEEP_SESSION:0.0" "cd '$ROOT' && ./scripts/keep-alive.sh" Enter

echo "[start-24-7] keep-alive running in tmux session: $KEEP_SESSION"
echo "[start-24-7] bot session: $BOT_SESSION"
echo "[start-24-7] net session: $NET_SESSION"
echo "[start-24-7] dashboard: http://127.0.0.1:3847"
echo "[start-24-7] log: $ROOT/keep-alive.log"
