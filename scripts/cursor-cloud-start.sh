#!/usr/bin/env bash
# Cursor Cloud Environment `start` hook — runs on every agent boot after Build.
# Materializes secrets → .env, then launches the 24/7 keep-alive stack in tmux.
# Must return quickly (do not block the agent).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[cursor-cloud-start] materializing runtime config..."
bash "$ROOT/scripts/materialize-dotenv.sh"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "[cursor-cloud-start] WARNING: no .env — bot will not login until secrets are set" >&2
  echo "[cursor-cloud-start] Add secret NEXIAN_DOTENV (full .env body) or NEXIAN_USERNAME/NEXIAN_PASSWORD/…" >&2
fi

chmod +x "$ROOT/scripts/keep-alive.sh" "$ROOT/scripts/start-24-7.sh" 2>/dev/null || true

echo "[cursor-cloud-start] launching 24/7 stack..."
bash "$ROOT/scripts/start-24-7.sh"

echo "[cursor-cloud-start] done — dashboard http://127.0.0.1:3847 keep-alive.log heartbeats"
