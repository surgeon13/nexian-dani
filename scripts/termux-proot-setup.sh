#!/data/data/com.termux/files/usr/bin/bash
# EXPERIMENTAL: sets up a real glibc Linux userland (via proot-distro/Ubuntu)
# inside Termux so Playwright's Chromium — which Termux's own Bionic-libc
# environment cannot run at all ("Unsupported platform: android" from
# playwright-core, and even patched around that, a glibc Chromium binary
# will not load under Bionic) — has somewhere it can actually execute.
#
# Run this FROM TERMUX (not from inside the proot chroot):
#   pkg install git -y   # if you don't already have this repo cloned
#   bash scripts/termux-proot-setup.sh
#
# What this does NOT do: make the bot reliable for real 24/7 use on a phone.
# Android still aggressively kills backgrounded apps, proot adds real syscall
# overhead, and Chromium-under-proot is not officially supported by anyone.
# See the "Known limitations" section this script prints at the end.
#
# Preferred for actual 24/7 operation is still an always-on PC/VPS
# (see AGENTS.md / README.md). Use this only if you specifically want to
# run on-device.

set -uo pipefail

DISTRO="ubuntu"
GUEST_PROJECT_DIR="/root/nexian-dani"
REPO_URL="${NEXIAN_REPO_URL:-https://github.com/surgeon13/nexian-dani.git}"
NODE_MAJOR="20"

log() { echo "[termux-proot-setup] $*"; }
die() { echo "[termux-proot-setup] ERROR: $*" >&2; exit 1; }

# Clone/checkout the SAME branch as the Termux-side checkout this script is
# running from, not whatever GitHub's default branch happens to be. Without
# this, the chroot's independent git clone can silently diverge from what
# you're actually working from — e.g. missing files that only exist on an
# unmerged feature branch (this bit a real user: the chroot cloned main,
# which doesn't have .env.termux.example, so .env.termux was never created).
# Override with NEXIAN_REPO_BRANCH= if you deliberately want something else.
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_BRANCH="${NEXIAN_REPO_BRANCH:-$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"
if [ -z "$REPO_BRANCH" ] || [ "$REPO_BRANCH" = "HEAD" ]; then
  log "Could not detect a branch from the Termux-side checkout at $SCRIPT_DIR (detached HEAD or not a git repo) — the chroot clone will use GitHub's default branch instead."
  REPO_BRANCH=""
else
  log "Termux-side checkout is on branch '$REPO_BRANCH' — the chroot clone/checkout will match it."
fi

if [[ "${PREFIX:-}" != *com.termux* ]]; then
  die "This script must be run inside Termux (\$PREFIX does not look like a Termux prefix). Detected PREFIX='${PREFIX:-<unset>}'."
fi

if ! command -v proot-distro >/dev/null 2>&1; then
  log "Installing proot-distro (and git) via pkg..."
  pkg update -y || true
  pkg install -y proot-distro git || die "pkg install proot-distro git failed"
fi

log "Installing '$DISTRO' rootfs if not already present (this downloads a few hundred MB on first run, be patient)..."
# Don't rely on 'proot-distro list --installed' — its output format isn't
# guaranteed stable across proot-distro versions. Instead, treat "already
# exists" from 'install' itself as the ground truth (it's a normal, expected
# outcome on a second run, not a failure).
INSTALL_OUTPUT="$(proot-distro install "$DISTRO" 2>&1)"
INSTALL_STATUS=$?
if [ "$INSTALL_STATUS" -ne 0 ]; then
  if echo "$INSTALL_OUTPUT" | grep -qi "already exists"; then
    log "'$DISTRO' is already installed under proot-distro — continuing with the existing rootfs."
  else
    echo "$INSTALL_OUTPUT" >&2
    die "proot-distro install $DISTRO failed (see output above). Run 'proot-distro list' to see available distro names for your proot-distro version if 'ubuntu' itself is the problem."
  fi
else
  echo "$INSTALL_OUTPUT"
fi

log "Provisioning inside the $DISTRO chroot: apt deps, Node.js $NODE_MAJOR, git clone, npm install, Playwright Chromium + OS deps..."
log "(This step does real work and can take several minutes on a phone.)"

CLONE_BRANCH_ARGS=""
BRANCH_CHECKOUT_CMD="true"
if [ -n "$REPO_BRANCH" ]; then
  CLONE_BRANCH_ARGS="--branch '$REPO_BRANCH'"
  BRANCH_CHECKOUT_CMD="git fetch origin '$REPO_BRANCH' && git checkout '$REPO_BRANCH' || echo '[inside $DISTRO] could not fetch/checkout branch $REPO_BRANCH — continuing with whatever is checked out'"
fi

proot-distro login "$DISTRO" -- bash -lc "
  set -e
  # Force a chroot-only PATH. proot does not always fully reset \$PATH on
  # login, and Termux's own (Android/Bionic) node binary can otherwise
  # still be found first — which looks like success but is actually the
  # exact same 'Unsupported platform: android' failure in disguise.
  export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  export DEBIAN_FRONTEND=noninteractive
  echo '[inside $DISTRO] apt-get update/upgrade'
  apt-get update -y
  apt-get install -y curl git ca-certificates gnupg build-essential

  node_is_valid() {
    command -v node >/dev/null 2>&1 || return 1
    node -e \"process.exit((process.platform === 'linux' && parseInt(process.versions.node, 10) >= $NODE_MAJOR) ? 0 : 1)\"
  }

  if node_is_valid; then
    echo '[inside $DISTRO] Node.js already present and valid: '\"\$(command -v node)\"' '\"\$(node -v)\"' (platform='\"\$(node -p process.platform)\"')'
  else
    echo '[inside $DISTRO] installing Node.js $NODE_MAJOR via NodeSource'
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    apt-get install -y nodejs
    if ! node_is_valid; then
      echo '[inside $DISTRO] node after install: '\"\$(command -v node || echo not-found)\"' '\"\$(node -v 2>&1 || true)\"' platform='\"\$(node -p process.platform 2>&1 || true)\"'' >&2
      echo '[inside $DISTRO] FATAL: node still is not a valid Linux Node.js $NODE_MAJOR+ after install — refusing to continue with an Android node.' >&2
      exit 1
    fi
  fi
  echo '[inside $DISTRO] using node: '\"\$(command -v node)\"' '\"\$(node -v)\"' platform='\"\$(node -p process.platform)\"

  if [ -d '$GUEST_PROJECT_DIR/.git' ]; then
    echo '[inside $DISTRO] repo already cloned at $GUEST_PROJECT_DIR — syncing branch and pulling latest'
    cd '$GUEST_PROJECT_DIR'
    $BRANCH_CHECKOUT_CMD
    git pull --ff-only || echo '[inside $DISTRO] pull failed/skipped (local changes?) — continuing with existing checkout'
  else
    echo '[inside $DISTRO] cloning $REPO_URL into $GUEST_PROJECT_DIR (branch: ${REPO_BRANCH:-default})'
    git clone $CLONE_BRANCH_ARGS '$REPO_URL' '$GUEST_PROJECT_DIR'
  fi

  cd '$GUEST_PROJECT_DIR'

  # Wipe any node_modules/lockfile left over from a prior run that may have
  # installed under a leaked non-Linux node (see node_is_valid above) —
  # cheap safety net against a partially-poisoned install.
  rm -rf node_modules package-lock.json

  echo '[inside $DISTRO] npm install'
  npm install --no-audit --no-fund

  echo '[inside $DISTRO] npx playwright install chromium'
  npx playwright install chromium

  echo '[inside $DISTRO] npx playwright install-deps chromium (apt system libs Chromium needs)'
  npx playwright install-deps chromium

  if [ ! -f '$GUEST_PROJECT_DIR/.env.termux' ] && [ -f '$GUEST_PROJECT_DIR/.env.termux.example' ]; then
    echo '[inside $DISTRO] creating .env.termux from the phone-friendly .env.termux.example template'
    cp '$GUEST_PROJECT_DIR/.env.termux.example' '$GUEST_PROJECT_DIR/.env.termux'
  fi
" || die "Provisioning inside the $DISTRO chroot failed — see the [inside $DISTRO] output above for which step broke. If it failed at 'npx playwright install chromium' with 'Unsupported platform: android' again, that means proot is still leaking Termux's own node onto \$PATH even with PATH forced above — run 'proot-distro login $DISTRO -- bash -lc \"command -v node; node -p process.platform\"' by hand to see what it resolves to."

log "Provisioning finished."
echo
log "Next steps:"
cat <<EOF

1) A phone-friendly '$GUEST_PROJECT_DIR/.env.termux' was created from
   .env.termux.example — same as .env.example but with several loop
   intervals relaxed (mostly 2-4x longer) to cut how often Chromium wakes
   up through proot's overhead. It still has PLACEHOLDER credentials.
   Fill in real NEXIAN_USERNAME / NEXIAN_PASSWORD / GAME_HOST by pulling
   them from your Termux-side .env (a SEPARATE filesystem from the chroot
   copy — edits to one do not affect the other), without clobbering the
   relaxed intervals:

     proot-distro login $DISTRO --bind "\$HOME:/root/termux-home" -- bash -lc '
       SRC=/root/termux-home/nexian-dani/.env
       DST=$GUEST_PROJECT_DIR/.env.termux
       for key in NEXIAN_USERNAME NEXIAN_PASSWORD GAME_HOST; do
         val=\$(grep -E "^\${key}=" "\$SRC" | tail -1)
         [ -z "\$val" ] && continue
         grep -qE "^\${key}=" "\$DST" \\
           && sed -i "s|^\${key}=.*|\$val|" "\$DST" \\
           || echo "\$val" >> "\$DST"
       done
     '

   (If your proot-distro version's 'login' does not support --bind the same
   way, just edit $GUEST_PROJECT_DIR/.env.termux by hand instead.)

2) Grab a wake lock so Termux is less likely to be killed in the background,
   and disable Android's battery optimization for Termux in
   Settings -> Apps -> Termux -> Battery -> Unrestricted:

     termux-wake-lock

3) Run it (headless — there is no display here unless you separately set up
   termux-x11). scripts/termux-proot-run.sh does this automatically and
   uses .env.termux when present (falls back to .env otherwise):

     bash scripts/termux-proot-run.sh

   or by hand:

     proot-distro login $DISTRO -- bash -lc "cd $GUEST_PROJECT_DIR && node login.js --env-file=.env.termux"

Known limitations (read before relying on this for real use):
  - Chromium runs through proot's syscall-translation layer — expect it to
    be slower and occasionally flakier than a native Linux host.
  - Android will still try to kill backgrounded apps to reclaim memory.
    termux-wake-lock + "unrestricted" battery settings reduce but do not
    eliminate this.
  - --headed mode has nowhere to render without termux-x11 (a separate
    Termux add-on providing an X server via its own Android app) — this
    script only sets you up for headless.
  - This whole path is unofficial: neither Playwright nor Termux's
    proot-distro claims to support this combination. Treat it as
    experimental, not a replacement for running on a PC/VPS.
EOF
