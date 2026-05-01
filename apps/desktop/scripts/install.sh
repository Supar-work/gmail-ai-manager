#!/usr/bin/env bash
# Install the API runtime + data files into a macOS-standard per-user
# location so the tray app doesn't trigger iCloud / Documents TCC prompts.
#
#   ~/Library/Application Support/gmail-ai-manager/
#     api/                 – deployed @gam/api with its prod dependencies
#     api/.env             – env file, DATABASE_URL rewritten to absolute path
#     data.db              – SQLite database
#
# Also copies the bundled .app to ~/Applications/ if one exists.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEST="$HOME/Library/Application Support/gmail-ai-manager"
APPS_DIR="$HOME/Applications"
BUNDLE_SRC="$REPO/apps/desktop/src-tauri/target/release/bundle/macos/Gmail AI Manager.app"
BUNDLE_DST="$APPS_DIR/Gmail AI Manager.app"

echo "[install] staging to $DEST"

# ── 0. Stop the running API + tray before we rm -rf into its install dir.
# Without this, an active Node sidecar holds the SQLite WAL open while we
# wipe + replace $DEST/api, which can corrupt the on-disk file. Bootout
# the LaunchAgent (cleanest), fall back to pkill, then wait for port
# 3001 to free.
LABEL="work.supar.gam"
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "[install] stopping LaunchAgent $LABEL before deploy"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi
pkill -f "gam-desktop" 2>/dev/null || true
pkill -f "gmail-ai-manager/api/dist/server.js" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! lsof -i :3001 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 1
done
if lsof -i :3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[install] warn: port 3001 still in use after 10s; continuing" >&2
fi

mkdir -p "$DEST"

# ── 1. deploy the api package with its prod deps ─────────────────────────
# `pnpm --filter @gam/api deploy` produces a standalone directory: dist/,
# package.json, node_modules/ with only production deps flattened in.
STAGE="$DEST/.stage-api"
rm -rf "$STAGE"
(
  cd "$REPO"
  pnpm --filter @gam/api --prod --legacy deploy "$STAGE"
)

# Prisma schema/migrations aren't in dist; copy them alongside.
rm -rf "$STAGE/prisma"
cp -R "$REPO/apps/api/prisma" "$STAGE/prisma"

rm -rf "$DEST/api"
mv "$STAGE" "$DEST/api"

# The API serves the web build statically in production, resolved at
# ../../web/dist relative to apps/api/dist. Copy the built web app to match.
WEB_SRC="$REPO/apps/web/dist"
WEB_DEST="$DEST/web/dist"
if [[ ! -d "$WEB_SRC" ]]; then
  echo "[install] $WEB_SRC missing — build it with \`pnpm --filter @gam/web build\`" >&2
  exit 1
fi
rm -rf "$WEB_DEST"
mkdir -p "$DEST/web"
cp -R "$WEB_SRC" "$WEB_DEST"

# ── 2. .env ───────────────────────────────────────────────────────────────
cp "$REPO/apps/api/.env" "$DEST/api/.env"
# Rewrite DATABASE_URL to an absolute file path under Application Support so
# the sidecar doesn't look for the DB relative to its cwd at launch time.
ABSOLUTE_DB="$DEST/data.db"
# Use | as delimiter since paths contain /.
sed -i '' -E "s|^DATABASE_URL=.*$|DATABASE_URL=file:${ABSOLUTE_DB}|" "$DEST/api/.env"

# ── 3. Prisma client (pnpm deploy skips postinstall by default) ──────────
# `prisma` is a devDependency so it isn't in the deployed node_modules. Run
# the CLI from the repo, with --schema pointing at the install location so
# the generated client lands in $DEST/api/node_modules/.prisma.
echo "[install] generating prisma client"
(
  cd "$REPO"
  DATABASE_URL="file:$ABSOLUTE_DB" pnpm --filter @gam/api exec prisma generate \
    --schema "$DEST/api/prisma/schema.prisma" >/dev/null
)

# ── 4. SQLite DB ──────────────────────────────────────────────────────────
# Prisma puts the dev-mode SQLite file in prisma/dev.db (relative to
# schema.prisma). Copy it if present; otherwise apply migrations to create
# a fresh schema at the install location.
SRC_DB="$REPO/apps/api/prisma/dev.db"
if [[ ! -f "$DEST/data.db" ]]; then
  if [[ -f "$SRC_DB" ]]; then
    echo "[install] copying $SRC_DB → data.db"
    cp "$SRC_DB" "$DEST/data.db"
  else
    echo "[install] no source db; applying migrations fresh at $ABSOLUTE_DB"
    (
      cd "$REPO"
      DATABASE_URL="file:$ABSOLUTE_DB" pnpm --filter @gam/api exec prisma migrate deploy \
        --schema "$DEST/api/prisma/schema.prisma"
    )
  fi
fi

# ── 4. .app bundle → ~/Applications ──────────────────────────────────────
if [[ -d "$BUNDLE_SRC" ]]; then
  echo "[install] stamping LSUIElement into bundle Info.plist"
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$BUNDLE_SRC/Contents/Info.plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$BUNDLE_SRC/Contents/Info.plist"

  echo "[install] copying bundle → $BUNDLE_DST"
  mkdir -p "$APPS_DIR"
  rm -rf "$BUNDLE_DST"
  cp -R "$BUNDLE_SRC" "$BUNDLE_DST"
  # Clear the quarantine bit so macOS doesn't throw the Gatekeeper prompt on
  # first launch of an unsigned ad-hoc build.
  xattr -dr com.apple.quarantine "$BUNDLE_DST" 2>/dev/null || true
else
  echo "[install] bundle not found at $BUNDLE_SRC — run \`pnpm --filter @gam/desktop exec tauri build\` first"
fi

echo "[install] done."
echo "  API runtime:  $DEST/api"
echo "  Database:     $DEST/data.db"
echo "  App bundle:   $BUNDLE_DST"
echo
echo "Launch with:  open \"$BUNDLE_DST\""
