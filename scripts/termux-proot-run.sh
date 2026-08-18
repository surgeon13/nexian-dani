#!/data/data/com.termux/files/usr/bin/bash
# EXPERIMENTAL: launches nexian-dani inside the proot-distro Ubuntu chroot
# set up by scripts/termux-proot-setup.sh. Run this FROM TERMUX.
#
# Usage:
#   bash scripts/termux-proot-run.sh                # node login.js (headless)
#   bash scripts/termux-proot-run.sh --dashboard     # node login.js --dashboard --keep-open
#   bash scripts/termux-proot-run.sh --headed        # only works with termux-x11 set up separately
#
# See scripts/termux-proot-setup.sh for the one-time setup this depends on,
# and its "Known limitations" section before relying on this for real use.

set -uo pipefail

DISTRO="ubuntu"
GUEST_PROJECT_DIR="/root/nexian-dani"

log() { echo "[termux-proot-run] $*"; }
die() { echo "[termux-proot-run] ERROR: $*" >&2; exit 1; }

if [[ "${PREFIX:-}" != *com.termux* ]]; then
  die "This script must be run inside Termux (\$PREFIX does not look like a Termux prefix)."
fi

if ! command -v proot-distro >/dev/null 2>&1; then
  die "proot-distro not found. Run scripts/termux-proot-setup.sh first."
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  log "Acquiring wake lock (termux-wake-lock) so Termux is less likely to be killed in the background..."
  termux-wake-lock || log "termux-wake-lock failed — continuing anyway, but the process is more likely to be killed when the screen locks."
else
  log "termux-wake-lock not found — skipping. Install Termux:API / the base termux-tools wake-lock command if you have it, or accept the process may get killed in the background."
fi

NODE_ARGS=("login.js")
HAS_ENV_FILE_ARG=false
for arg in "$@"; do
  case "$arg" in
    --headed)
      log "NOTE: --headed has nowhere to render without termux-x11 set up separately."
      NODE_ARGS+=("--headed")
      ;;
    --dashboard)
      NODE_ARGS+=("--dashboard" "--keep-open")
      ;;
    --env-file=*)
      HAS_ENV_FILE_ARG=true
      NODE_ARGS+=("$arg")
      ;;
    *)
      NODE_ARGS+=("$arg")
      ;;
  esac
done

# Prefer the phone-friendly .env.termux (relaxed loop intervals, see
# .env.termux.example) over plain .env when it exists in the chroot copy of
# the repo, unless the caller already passed their own --env-file=.
if [[ "$HAS_ENV_FILE_ARG" == "false" ]]; then
  NODE_ARGS+=("--env-file-if-present=.env.termux")
fi

log "Launching: cd $GUEST_PROJECT_DIR && node ${NODE_ARGS[*]}"
proot-distro login "$DISTRO" -- bash -lc "
  cd '$GUEST_PROJECT_DIR' || exit 1
  args=($(printf '%q ' "${NODE_ARGS[@]}"))
  # Resolve the --env-file-if-present=... placeholder now that we're
  # actually inside the chroot and can see its filesystem.
  resolved=()
  for a in \"\${args[@]}\"; do
    case \"\$a\" in
      --env-file-if-present=*)
        f=\"\${a#--env-file-if-present=}\"
        if [ -f \"\$f\" ]; then
          resolved+=(\"--env-file=\$f\")
        fi
        ;;
      *)
        resolved+=(\"\$a\")
        ;;
    esac
  done
  exec node \"\${resolved[@]}\"
"
STATUS=$?

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock || true
fi

exit "$STATUS"
