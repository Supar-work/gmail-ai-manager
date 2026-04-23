#!/usr/bin/env bash
#
# Remove the Gmail AI Manager LaunchAgent — stop the job, unload it from
# launchd, delete the plist. Leaves the .app bundle, data, and logs alone.

set -euo pipefail

LABEL="work.supar.gam"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

# Stop any running instance.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
pkill -f "gam-desktop" 2>/dev/null || true
pkill -f "gmail-ai-manager/api/dist/server.js" 2>/dev/null || true

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  printf "${GREEN}✓ Removed${RESET} ${DIM}%s${RESET}\n" "$PLIST"
else
  echo "Nothing to remove — $PLIST does not exist."
fi
