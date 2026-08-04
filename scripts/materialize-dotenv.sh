#!/usr/bin/env bash
# Build local runtime files from Cursor Secrets (env vars). Never commit outputs.
# Priority for .env:
#   1) NEXIAN_DOTENV / DOTENV full file body (if set)
#   2) existing .env (left alone, then force dashboard/keep-open/headless)
#   3) synthesize from individual env vars listed in .env.example
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-$ROOT/.env}"
EXAMPLE="${EXAMPLE:-$ROOT/.env.example}"

write_full_dotenv() {
  local body="$1"
  printf '%s\n' "${body//$'\r'/}" | sed -e '$a\' > "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo "[materialize-dotenv] wrote $ENV_FILE from full-body secret ($(wc -l < "$ENV_FILE") lines)"
}

if [[ -n "${NEXIAN_DOTENV:-}" ]]; then
  write_full_dotenv "$NEXIAN_DOTENV"
elif [[ -n "${DOTENV:-}" ]]; then
  write_full_dotenv "$DOTENV"
elif [[ -f "$ENV_FILE" ]]; then
  echo "[materialize-dotenv] keeping existing $ENV_FILE"
else
  if [[ ! -f "$EXAMPLE" ]]; then
    echo "[materialize-dotenv] ERROR: no $ENV_FILE and no $EXAMPLE" >&2
    exit 1
  fi
  python3 - "$EXAMPLE" "$ENV_FILE" <<'PY'
import os, sys
example, out = sys.argv[1], sys.argv[2]
lines = open(example, encoding="utf-8").read().splitlines()
out_lines = []
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        out_lines.append(line)
        continue
    key, _, _ = line.partition("=")
    key = key.strip()
    if key in os.environ:
        out_lines.append(f"{key}={os.environ[key]}")
    else:
        out_lines.append(line)
# Append any required keys present in env but missing from example
known = {l.partition("=")[0].strip() for l in out_lines if "=" in l and not l.strip().startswith("#")}
for key in ("NEXIAN_USERNAME", "NEXIAN_PASSWORD", "GAME_HOST", "NEXIAN_URL"):
    if key in os.environ and key not in known:
        out_lines.append(f"{key}={os.environ[key]}")
open(out, "w", encoding="utf-8").write("\n".join(out_lines) + "\n")
print(f"[materialize-dotenv] synthesized {out} from .env.example + secrets")
PY
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi

mkdir -p "$ROOT/templates"
if [[ -n "${NEXIAN_TROOP_PLANS_JSON:-}" ]]; then
  printf '%s\n' "${NEXIAN_TROOP_PLANS_JSON}" > "$ROOT/templates/troop_plans.json"
  echo "[materialize-dotenv] wrote templates/troop_plans.json"
fi
if [[ -n "${NEXIAN_PROXY_LIST_JSON:-}" ]]; then
  printf '%s\n' "${NEXIAN_PROXY_LIST_JSON}" > "$ROOT/templates/proxy_list.json"
  echo "[materialize-dotenv] wrote templates/proxy_list.json"
fi

# Cloud 24/7 needs dashboard + keep-open + headless
if [[ -f "$ENV_FILE" ]]; then
  python3 - "$ENV_FILE" <<'PY'
import sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
wanted = {
    "DASHBOARD_ENABLED": "true",
    "KEEP_OPEN": "true",
    "HEADLESS": "true",
    "DASHBOARD_OPEN_BROWSER": "false",
}
seen = set()
out = []
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key = line.partition("=")[0].strip()
        if key in wanted:
            out.append(f"{key}={wanted[key]}")
            seen.add(key)
            continue
    out.append(line)
for key, val in wanted.items():
    if key not in seen:
        out.append(f"{key}={val}")
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
fi
