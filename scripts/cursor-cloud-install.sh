#!/usr/bin/env bash
# Idempotent Cursor Cloud Environment install (Build snapshot step).
# Installs npm deps + Playwright Chromium. Do not start long-running processes here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[cursor-cloud-install] node=$(node -v) npm=$(npm -v) cwd=$ROOT"

if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# Chromium + OS deps for headless automation in Cursor VMs.
npx playwright install chromium
npx playwright install-deps chromium 2>/dev/null || true

chmod +x \
  "$ROOT/scripts/keep-alive.sh" \
  "$ROOT/scripts/start-24-7.sh" \
  "$ROOT/scripts/cursor-cloud-install.sh" \
  "$ROOT/scripts/cursor-cloud-start.sh" \
  "$ROOT/scripts/materialize-dotenv.sh" \
  "$ROOT/scripts/cursor-cloud-ensure.sh" 2>/dev/null || true

echo "[cursor-cloud-install] done"
