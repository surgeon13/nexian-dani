#!/data/data/com.termux/files/usr/bin/bash
# EXPERIMENTAL: launches nexian-dani inside the proot-distro Ubuntu chroot
# set up by scripts/termux-proot-setup.sh. Run this FROM TERMUX.
#
# Usage:
#   bash scripts/termux-proot-run.sh                # node login.js (headless)
#   bash scripts/termux-proot-run.sh --dashboard     # node login.js --dashboard --keep-open
#   bash scripts/termux-proot-run.sh --headed        # only works with termux-x11 set up separately
#   bash scripts/termux-proot-run.sh --no-sync       # skip the chroot git sync below (faster restarts)
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

# The chroot at $GUEST_PROJECT_DIR is a SEPARATE git checkout from the
# Termux-side one this script itself lives in — they do not stay in sync
# automatically. Pulling updates on the Termux side (e.g. to get this very
# script's latest version) does nothing to the chroot's copy of login.js,
# which is what actually runs. This bit real users repeatedly (stale flag
# names, stale bugfixes) until this sync was added: by default, every run
# fetches/checks-out/pulls the same branch as the Termux-side checkout
# before launching, so the two can't silently drift apart. Pass --no-sync to
# skip this (e.g. for faster restarts once you know both sides match, or if
# you're offline).
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_BRANCH="${NEXIAN_REPO_BRANCH:-$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"
if [ -z "$REPO_BRANCH" ] || [ "$REPO_BRANCH" = "HEAD" ]; then
  REPO_BRANCH=""
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  log "Acquiring wake lock (termux-wake-lock) so Termux is less likely to be killed in the background..."
  termux-wake-lock || log "termux-wake-lock failed — continuing anyway, but the process is more likely to be killed when the screen locks."
else
  log "termux-wake-lock not found — skipping. Install Termux:API / the base termux-tools wake-lock command if you have it, or accept the process may get killed in the background."
fi

NODE_ARGS=("login.js")
HAS_ENV_FILE_ARG=false
DO_SYNC=true
for arg in "$@"; do
  case "$arg" in
    --headed)
      log "NOTE: --headed has nowhere to render without termux-x11 set up separately."
      NODE_ARGS+=("--headed")
      ;;
    --dashboard)
      NODE_ARGS+=("--dashboard" "--keep-open")
      ;;
    --nexian-env-file=*)
      HAS_ENV_FILE_ARG=true
      NODE_ARGS+=("$arg")
      ;;
    --no-sync)
      DO_SYNC=false
      ;;
    *)
      NODE_ARGS+=("$arg")
      ;;
  esac
done

SYNC_CMD="true"
if [[ "$DO_SYNC" == "true" ]]; then
  # git reset --hard before switching/pulling: npm install regularly leaves
  # package-lock.json locally modified inside the chroot, which previously
  # made 'git checkout'/'git pull' fail outright (a real user hit exactly
  # this). This chroot copy is a deployment target, not a workspace with
  # precious local edits, so discarding tracked-file changes here is safe —
  # .env/.env.termux are gitignored and untouched by this.
  if [ -n "$REPO_BRANCH" ]; then
    SYNC_CMD="if [ -d .git ]; then git fetch origin '$REPO_BRANCH' && git reset --hard >/dev/null 2>&1 && git checkout -B '$REPO_BRANCH' 'origin/$REPO_BRANCH' || echo '[termux-proot-run] chroot git sync failed/skipped — continuing with whatever is checked out ('\"\$(git rev-parse --abbrev-ref HEAD 2>&1)\"')'; fi"
    log "Will sync the chroot's checkout to branch '$REPO_BRANCH' before launching (pass --no-sync to skip)."
  else
    SYNC_CMD="if [ -d .git ]; then git reset --hard >/dev/null 2>&1 && git pull --ff-only || echo '[termux-proot-run] chroot git pull failed/skipped — continuing with existing checkout'; fi"
    log "Could not detect a branch from the Termux-side checkout — will just 'git pull' the chroot's current branch before launching (pass --no-sync to skip)."
  fi
fi

# Default to the phone-friendly .env.termux unless the caller passed their
# own --nexian-env-file=. This no longer needs to check whether the file
# exists: login.js's ensureEnvFile() auto-creates any missing
# --nexian-env-file target, preferring a same-named "<file>.example"
# template (.env.termux.example, with the relaxed intervals) when present,
# falling back to the generic .env.example otherwise. Either way you get a
# working, running config — only real credentials (NEXIAN_USERNAME/PASSWORD,
# GAME_HOST) need editing.
#
# This must be --nexian-env-file, NOT --env-file: Node itself (>=20.6) has a
# native --env-file=<path> flag that intercepts that exact argument before
# login.js runs, and exits hard with "node: <path>: not found" if the file
# doesn't exist yet — bypassing ensureEnvFile()'s auto-creation entirely.
# This bit a real user on first run. See the same note in login.js.
if [[ "$HAS_ENV_FILE_ARG" == "false" ]]; then
  NODE_ARGS+=("--nexian-env-file=.env.termux")
fi

log "Launching: cd $GUEST_PROJECT_DIR && node ${NODE_ARGS[*]}"
proot-distro login "$DISTRO" -- bash -lc "
  # Force a chroot-only PATH — see the same note in termux-proot-setup.sh.
  # Without this, a leaked Termux/Android node can silently run the bot
  # against the wrong Node build (surfaces as the exact same Playwright
  # 'Unsupported platform: android' error we're specifically avoiding here).
  export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  cd '$GUEST_PROJECT_DIR' || exit 1
  $SYNC_CMD
  if ! command -v node >/dev/null 2>&1 || ! node -e \"process.exit(process.platform === 'linux' ? 0 : 1)\"; then
    echo '[termux-proot-run] FATAL: node inside the chroot is missing or not a Linux build (found: '\"\$(command -v node || echo none)\"' platform='\"\$(node -p process.platform 2>&1 || echo '?')\"'). Re-run scripts/termux-proot-setup.sh.' >&2
    exit 1
  fi
  exec node $(printf '%q ' "${NODE_ARGS[@]}")
"
STATUS=$?

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock || true
fi

exit "$STATUS"
