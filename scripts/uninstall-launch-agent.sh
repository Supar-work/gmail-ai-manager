#!/usr/bin/env bash
#
# Remove the Gmail AI Manager LaunchAgent — stop the job, unload it from
# launchd, delete the plist. Leaves the .app bundle, data, and logs alone.

set -euo pipefail

LABEL="work.supar.gam"
LOGROTATE_LABEL="work.supar.gam.logrotate"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGROTATE_PLIST="$HOME/Library/LaunchAgents/$LOGROTATE_LABEL.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

# Stop any running instance.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootout "$DOMAIN/$LOGROTATE_LABEL" 2>/dev/null || true
launchctl unload "$LOGROTATE_PLIST" 2>/dev/null || true
pkill -f "gam-desktop" 2>/dev/null || true
pkill -f "gmail-ai-manager/api/dist/server.js" 2>/dev/null || true

removed_any=0
for p in "$PLIST" "$LOGROTATE_PLIST"; do
  if [ -f "$p" ]; then
    rm -f "$p"
    printf "${GREEN}✓ Removed${RESET} ${DIM}%s${RESET}\n" "$p"
    removed_any=1
  fi
done
[ "$removed_any" -eq 0 ] && echo "Nothing to remove — no LaunchAgent plists present."
