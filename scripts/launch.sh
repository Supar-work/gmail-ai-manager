#!/usr/bin/env bash
#
# Launch Gmail AI Manager by invoking the Mach-O binary directly, bypassing
# macOS LaunchServices (`open Gmail\ AI\ Manager.app`).
#
# Why: under LaunchServices-spawn, our node sidecar hangs inside
# @prisma/client's dlopen of libquery_engine before reaching app.listen().
# Shelling to the binary puts the process in a normal user session and
# everything works. Tracked as a TODO.

set -euo pipefail

BIN="$HOME/Applications/Gmail AI Manager.app/Contents/MacOS/gam-desktop"
[ -x "$BIN" ] || {
  echo "error: $BIN not found — run scripts/install-from-source.sh first" >&2
  exit 1
}

# Kill any existing instance so we start clean.
pkill -f "gam-desktop" 2>/dev/null || true
pkill -f "gmail-ai-manager/api/dist/server.js" 2>/dev/null || true
sleep 1

# Launch detached from the terminal so `logout` doesn't kill it.
nohup "$BIN" >/dev/null 2>&1 &
disown

echo "Gmail AI Manager launched (PID $!). Look for the icon in your menu bar."
echo "UI: http://localhost:3001"
