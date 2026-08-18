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

if [[ "${PREFIX:-}" != *com.termux* ]]; then
  die "This script must be run inside Termux (\$PREFIX does not look like a Termux prefix). Detected PREFIX='${PREFIX:-<unset>}'."
fi

if ! command -v proot-distro >/dev/null 2>&1; then
  log "Installing proot-distro (and git) via pkg..."
  pkg update -y || true
  pkg install -y proot-distro git || die "pkg install proot-distro git failed"
fi

log "Checking for an existing '$DISTRO' proot-distro install..."
if proot-distro list --installed 2>/dev/null | grep -qiw "$DISTRO"; then
  log "'$DISTRO' is already installed under proot-distro — skipping install step."
else
  log "Installing '$DISTRO' rootfs (this downloads a few hundred MB, be patient)..."
  proot-distro install "$DISTRO" || die "proot-distro install $DISTRO failed. Run 'proot-distro list' to see available distro names for your proot-distro version — the CLI has changed across versions and this script cannot verify it for you."
fi

log "Provisioning inside the $DISTRO chroot: apt deps, Node.js $NODE_MAJOR, git clone, npm install, Playwright Chromium + OS deps..."
log "(This step does real work and can take several minutes on a phone.)"

proot-distro login "$DISTRO" -- bash -lc "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  echo '[inside $DISTRO] apt-get update/upgrade'
  apt-get update -y
  apt-get install -y curl git ca-certificates gnupg build-essential

  if ! command -v node >/dev/null 2>&1 || [ \"\$(node -v | sed -E 's/^v([0-9]+).*/\1/')\" -lt $NODE_MAJOR ]; then
    echo '[inside $DISTRO] installing Node.js $NODE_MAJOR via NodeSource'
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    apt-get install -y nodejs
  else
    echo '[inside $DISTRO] Node.js already present: '\"\$(node -v)\"
  fi

  if [ -d '$GUEST_PROJECT_DIR/.git' ]; then
    echo '[inside $DISTRO] repo already cloned at $GUEST_PROJECT_DIR — pulling latest'
    git -C '$GUEST_PROJECT_DIR' pull --ff-only || echo '[inside $DISTRO] pull failed/skipped (local changes?) — continuing with existing checkout'
  else
    echo '[inside $DISTRO] cloning $REPO_URL into $GUEST_PROJECT_DIR'
    git clone '$REPO_URL' '$GUEST_PROJECT_DIR'
  fi

  cd '$GUEST_PROJECT_DIR'
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
" || die "Provisioning inside the $DISTRO chroot failed — see the [inside $DISTRO] output above for which step broke."

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
