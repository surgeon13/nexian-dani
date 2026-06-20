#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ENV_FILE="${NEXIAN_ENV_FILE:-.env}"
HEADLESS=false

usage() {
  cat <<'EOF'
Usage: ./dashboard-dev.sh [options]

  --env-file PATH   Env file (default: .env)
  --headless        Run Playwright headless (dashboard still opens)
  -h, --help        Show this help

Examples:
  ./dashboard-dev.sh
  ./dashboard-dev.sh --env-file .env.nexian
  ./dashboard-dev.sh --env-file .env.nexian --headless
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?missing path after --env-file}"
      shift 2
      ;;
    --headless)
      HEADLESS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ARGS=(login.js --dashboard --keep-open "--env-file=$ENV_FILE")
if [[ "$HEADLESS" == false ]]; then
  ARGS+=(--headed)
fi

echo ""
echo "Nexian dashboard (dev)"
echo "  Env file:  $ENV_FILE"
echo "  Browser:   $(if [[ "$HEADLESS" == true ]]; then echo headless; else echo headed; fi)"
echo "  Dashboard: http://127.0.0.1:3847"
echo ""

exec node "${ARGS[@]}"
