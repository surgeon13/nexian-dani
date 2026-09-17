#!/data/data/com.termux/files/usr/bin/bash
# EXPERIMENTAL: pulls the newest debug/login-failure-*.{png,log} pair out of
# the proot-distro Ubuntu chroot (see scripts/termux-proot-setup.sh /
# termux-proot-run.sh) and into Termux's shared storage, where a normal
# Android file manager / share sheet can actually reach them.
#
# WHY THIS EXISTS: nexian-dani's debug/ folder already lives exactly where
# it should -- inside the project, next to login.js. But because the bot
# runs inside a proot chroot at /root/nexian-dani, that folder is invisible
# to every Android-side tool (Files app, Gallery, share sheets) even though
# the underlying bytes are real files on this device -- proot intercepts
# filesystem syscalls to present that chroot view, so a plain Termux-side
# `find` or file manager can't see into it at all. Piping data OUT through a
# running proot process's own stdout (which this script does) sidesteps
# that entirely, without needing to know proot-distro's exact on-disk mount
# layout, which can vary by device/version.
#
# Usage (run FROM TERMUX, not from inside `proot-distro login`):
#   bash scripts/termux-fetch-debug.sh
#
# Result: the newest login-failure-<timestamp>.png and .log land in
#   ~/storage/downloads/nexian-debug/
# ready to open/share from your phone's Downloads folder. Run
# `termux-setup-storage` first (one-time) if ~/storage doesn't exist yet.

set -uo pipefail

DISTRO="ubuntu"
GUEST_DEBUG_DIR="/root/nexian-dani/debug"
OUT_DIR="$HOME/storage/downloads/nexian-debug"

log() { echo "[termux-fetch-debug] $*"; }
die() { echo "[termux-fetch-debug] ERROR: $*" >&2; exit 1; }

if [[ "${PREFIX:-}" != *com.termux* ]]; then
  die "Run this from plain Termux, not from inside 'proot-distro login'."
fi

if ! command -v proot-distro >/dev/null 2>&1; then
  die "proot-distro not found. Run scripts/termux-proot-setup.sh first."
fi

if [ ! -d "$HOME/storage" ]; then
  die "$HOME/storage doesn't exist yet. Run 'termux-setup-storage' once (approve the permission popup), then retry."
fi

mkdir -p "$OUT_DIR" || die "Could not create $OUT_DIR"

log "Looking for the newest login-failure-*.png/.log pair in the chroot..."
LATEST_STAMP=$(proot-distro login "$DISTRO" -- bash -lc "
  ls -t '$GUEST_DEBUG_DIR'/login-failure-*.png 2>/dev/null | head -1
" | sed -E 's#.*/login-failure-(.*)\.png#\1#')

if [ -z "$LATEST_STAMP" ]; then
  die "No login-failure-*.png files found in $GUEST_DEBUG_DIR inside the chroot. Has a login actually failed yet on this machine?"
fi

log "Newest: login-failure-$LATEST_STAMP"

PNG_SRC="$GUEST_DEBUG_DIR/login-failure-$LATEST_STAMP.png"
LOG_SRC="$GUEST_DEBUG_DIR/login-failure-$LATEST_STAMP.log"
PNG_OUT="$OUT_DIR/login-failure-$LATEST_STAMP.png"
LOG_OUT="$OUT_DIR/login-failure-$LATEST_STAMP.log"

log "Copying screenshot..."
proot-distro login "$DISTRO" -- bash -lc "base64 '$PNG_SRC'" | base64 -d > "$PNG_OUT"
if [ ! -s "$PNG_OUT" ]; then
  die "Screenshot copy produced an empty file -- something went wrong reading $PNG_SRC."
fi
log "Saved: $PNG_OUT"

log "Copying diagnostics log (if present -- only exists on v1.8.106+)..."
if proot-distro login "$DISTRO" -- bash -lc "[ -f '$LOG_SRC' ]"; then
  proot-distro login "$DISTRO" -- bash -lc "cat '$LOG_SRC'" > "$LOG_OUT"
  log "Saved: $LOG_OUT"
else
  log "No .log file for this timestamp (older version, or this failure predates v1.8.106) -- skipped."
fi

log "Done. Open your Files/Downloads app -> nexian-debug -> and share these from there."
