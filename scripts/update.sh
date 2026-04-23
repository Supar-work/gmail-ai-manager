#!/usr/bin/env bash
#
# Update an existing Gmail AI Manager checkout: pull latest main, rebuild
# everything, redeploy to ~/Library/Application Support, re-launch.
#
# This is safe to run repeatedly — nothing is cloned or overwritten besides
# the install target. User data ($DATA_DIR/data.db) and .env are preserved.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RESET='\033[0m'

step() { printf "\n${BOLD}▸ %s${RESET}\n" "$1"; }

# 1. Verify this is a git checkout and the tree is clean-ish.
if [ ! -d "$REPO/.git" ]; then
  echo "error: $REPO is not a git checkout. Re-install with the public installer." >&2
  exit 1
fi

if ! git -C "$REPO" diff-index --quiet HEAD -- 2>/dev/null; then
  printf "${YELLOW}Warning: you have uncommitted local changes.${RESET} The update will git pull on top of them.\n"
fi

# 2. Pull latest.
step "Pulling latest changes"
BEFORE="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" pull --ff-only
AFTER="$(git -C "$REPO" rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  printf "${GREEN}Already up to date.${RESET} Re-running the deploy step anyway so any local rebuild takes effect.\n"
fi

# 3. Rebuild + redeploy via the installer (it's idempotent).
exec "$REPO/scripts/install-from-source.sh" --skip-prereqs --skip-oauth "$@"
