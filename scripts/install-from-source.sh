#!/usr/bin/env bash
#
# Build Gmail AI Manager from a local checkout and install it into
# ~/Applications + ~/Library/Application Support/gmail-ai-manager/.
#
# Intended to be run from the repo root. Safe to re-run (idempotent).
#
# Flags:
#   --skip-prereqs   don't run scripts/check-requirements.sh
#   --skip-oauth     don't run the OAuth wizard even if .env is missing
#                    (you'll have to create .env manually before launch)
#   --skip-build     reuse existing apps/*/dist and src-tauri bundle output
#   --no-launch      don't open the .app after install

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

SKIP_PREREQS=0
SKIP_OAUTH=0
SKIP_BUILD=0
SKIP_BACKUP=0
NO_LAUNCH=0
for arg in "$@"; do
  case "$arg" in
    --skip-prereqs) SKIP_PREREQS=1 ;;
    --skip-oauth)   SKIP_OAUTH=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    --skip-backup)  SKIP_BACKUP=1 ;;
    --no-launch)    NO_LAUNCH=1 ;;
    --help|-h)
      sed -n '3,15p' "$0"
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RESET='\033[0m'

step() { printf "\n${BOLD}▸ %s${RESET}\n" "$1"; }
done_() { printf "  ${GREEN}✓ %s${RESET}\n" "$1"; }

DATA_DIR="$HOME/Library/Application Support/gmail-ai-manager"
API_ENV_INSTALLED="$DATA_DIR/api/.env"
API_ENV_REPO="$REPO/apps/api/.env"
APP_DST="$HOME/Applications/Gmail AI Manager.app"

# ── 1. Prerequisites ─────────────────────────────────────────────────────
if [ "$SKIP_PREREQS" = "0" ]; then
  step "Checking prerequisites"
  "$REPO/scripts/check-requirements.sh"
fi

# ── 2. Pre-install backup of the live DB ────────────────────────────────
# Run backup.sh first thing so even a catastrophic failure later leaves a
# known-good rollback point. No-op if there's no DB yet (fresh install).
if [ "$SKIP_BACKUP" = "0" ]; then
  LIVE_DB=""
  for d in "$DATA_DIR" "$HOME/Library/Application Support/gmail-ai-filters"; do
    if [ -f "$d/data.db" ]; then LIVE_DB="$d/data.db"; break; fi
  done
  if [ -n "$LIVE_DB" ]; then
    step "Pre-install backup of live database"
    "$REPO/scripts/backup.sh" >/dev/null
    done_ "backup written under ~/Library/Application Support/.../backups/"
  fi
fi

# ── 3. Migrate old install dir (pre-rename) if present ───────────────────
OLD_DIR="$HOME/Library/Application Support/gmail-ai-filters"
OLD_LOG="$HOME/Library/Logs/gmail-ai-filters"
OLD_APP="$HOME/Applications/Gmail AI Filters.app"
if [ -d "$OLD_DIR" ] && [ ! -e "$DATA_DIR" ]; then
  step "Migrating data from pre-rename install"
  mv "$OLD_DIR" "$DATA_DIR"
  done_ "moved $OLD_DIR → $DATA_DIR"
fi
if [ -d "$OLD_LOG" ] && [ ! -e "$HOME/Library/Logs/gmail-ai-manager" ]; then
  mv "$OLD_LOG" "$HOME/Library/Logs/gmail-ai-manager"
fi
if [ -d "$OLD_APP" ]; then
  rm -rf "$OLD_APP"
fi

# ── 3. Ensure a Google OAuth .env exists ─────────────────────────────────
# The deployer (apps/desktop/scripts/install.sh) copies apps/api/.env into
# the install dir. $API_ENV_REPO MUST be a real file — not a symlink into
# $DEST/api, because the deployer `rm -rf`s that directory before copying.
# Older installer versions created such symlinks; dereference or delete them.
if [ -L "$API_ENV_REPO" ]; then
  if [ -e "$API_ENV_REPO" ]; then
    step "Dereferencing apps/api/.env symlink to a real file"
    TMP_ENV="$(mktemp)"
    cp "$API_ENV_REPO" "$TMP_ENV"
    rm -f "$API_ENV_REPO"
    mv "$TMP_ENV" "$API_ENV_REPO"
  else
    rm -f "$API_ENV_REPO"  # dangling symlink from the broken flow
  fi
fi

if [ ! -f "$API_ENV_REPO" ]; then
  if [ -f "$API_ENV_INSTALLED" ]; then
    step "Restoring apps/api/.env from $API_ENV_INSTALLED"
    cp "$API_ENV_INSTALLED" "$API_ENV_REPO"
  elif [ "$SKIP_OAUTH" = "1" ]; then
    echo "error: no .env file and --skip-oauth set. Create $API_ENV_REPO manually." >&2
    exit 1
  else
    step "No .env file found — running Google OAuth setup wizard"
    mkdir -p "$(dirname "$API_ENV_REPO")"
    "$REPO/scripts/setup-google-oauth.sh" "$(dirname "$API_ENV_REPO")"
  fi
fi

# Self-heal: older installer versions wrote TOKEN_ENC_KEY as a 64-char hex
# string, but apps/api/src/auth/crypto.ts decodes it as base64 and requires
# exactly 32 bytes. Hex decoded as base64 yields 48 bytes → startup crash.
CURRENT_KEY="$(grep -E '^TOKEN_ENC_KEY=' "$API_ENV_REPO" | head -n1 | cut -d= -f2- || true)"
if [ -n "$CURRENT_KEY" ] && ! node -e \
  "try{process.exit(Buffer.from(process.argv[1],'base64').length===32?0:1)}catch{process.exit(1)}" \
  "$CURRENT_KEY" 2>/dev/null; then
  step "Regenerating TOKEN_ENC_KEY (existing value not valid base64(32 bytes))"
  NEW_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  ESCAPED_KEY="$(printf '%s' "$NEW_KEY" | sed -e 's/[\/&|]/\\&/g')"
  sed -i '' -E "s|^TOKEN_ENC_KEY=.*$|TOKEN_ENC_KEY=${ESCAPED_KEY}|" "$API_ENV_REPO"
fi

# ── 4. Build everything ──────────────────────────────────────────────────
if [ "$SKIP_BUILD" = "0" ]; then
  step "Installing JS dependencies (pnpm install)"
  pnpm install --silent

  step "Generating Prisma client"
  pnpm --filter @gam/api run db:generate >/dev/null

  step "Building API + web (pnpm build:webapi)"
  pnpm -w run build:webapi

  step "Building Tauri release bundle (takes a few minutes the first time)"
  # tauri build reads tauri.conf.json which currently declares dmg + app
  # targets. We only need .app — skip dmg to save ~20s and avoid needing
  # a signed identity.
  pnpm --filter @gam/desktop exec tauri build --bundles app
fi

# ── 5. Deploy built artifacts to ~/Library/Application Support + ~/Applications
step "Deploying to ~/Library/Application Support/gmail-ai-manager"
"$REPO/apps/desktop/scripts/install.sh"

# ── 6. Install LaunchAgent + launch ──────────────────────────────────────
# LaunchAgent is the primary way to run this app: auto-start on login,
# restart on crash, no "click the Finder icon" needed. It also dodges a
# quirk where `open Gmail\ AI\ Manager.app` spawns the sidecar in a
# context that hangs @prisma/client's dlopen — launchd's own exec path
# is fine.
if [ "$NO_LAUNCH" = "0" ] && [ -d "$APP_DST" ]; then
  step "Registering LaunchAgent (auto-start on login)"
  "$REPO/scripts/install-launch-agent.sh"
fi

echo
printf "${BOLD}Done.${RESET} Gmail AI Manager is installed.\n"
cat <<EOF
  App:         $APP_DST
  Data:        $DATA_DIR
  Logs:        ~/Library/Logs/gmail-ai-manager/server.log

  Look for the ${CYAN}Gmail AI Manager${RESET} icon in your menu bar.
  To update later:         $REPO/scripts/update.sh
  To reconfigure OAuth:    $REPO/scripts/setup-google-oauth.sh

EOF
