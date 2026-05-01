#!/usr/bin/env bash
#
# Restore a Gmail AI Manager backup created by scripts/backup.sh.
#
# Two modes:
#   --full   <dir>   Replace data.db wholesale. Everything in the live DB
#                    is discarded in favor of the snapshot. Safest if the
#                    live DB is broken.
#   --merge  <dir>   Keep the live DB intact but INSERT-OR-REPLACE the Rule
#                    and GmailFilter rows from the JSON backup. Use when
#                    you want to recover deleted rules without rolling
#                    back recent work.
#
# Either mode stops the running app first (the SQLite file is locked
# while the sidecar has it open) and optionally relaunches afterward.
#
# Usage:
#   scripts/restore.sh --full  path/to/backup-dir
#   scripts/restore.sh --merge path/to/backup-dir [--no-launch]

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

die()  { printf "${RED}error:${RESET} %s\n" "$*" >&2; exit 1; }
step() { printf "\n${BOLD}▸ %s${RESET}\n" "$1"; }

MODE=""
SRC=""
NO_LAUNCH=0
for arg in "$@"; do
  case "$arg" in
    --full)       MODE="full" ;;
    --merge)      MODE="merge" ;;
    --no-launch)  NO_LAUNCH=1 ;;
    --help|-h)
      sed -n '3,22p' "$0"
      exit 0
      ;;
    -*) die "unknown flag: $arg" ;;
    *)
      if [ -z "$SRC" ]; then SRC="$arg"; else die "unexpected arg: $arg"; fi
      ;;
  esac
done

[ -n "$MODE" ] || die "pick a mode: --full or --merge"
[ -n "$SRC" ]  || die "missing backup directory argument"
[ -d "$SRC" ]  || die "not a directory: $SRC"

# ── 1. Locate the live DB ────────────────────────────────────────────────
TARGET_DB=""
for d in \
  "$HOME/Library/Application Support/gmail-ai-manager" \
  "$HOME/Library/Application Support/gmail-ai-filters"
do
  if [ -d "$d" ]; then
    TARGET_DIR="$d"
    TARGET_DB="$d/data.db"
    break
  fi
done
[ -n "$TARGET_DB" ] || die "no install directory found under ~/Library/Application Support"

# ── 2. Stop the app + sidecar so we can write without corruption ─────────
step "Stopping Gmail AI Manager (if running)"
# Kill the tray app
for name in "Gmail AI Manager" "Gmail AI Filters"; do
  osascript -e "tell application \"$name\" to quit" >/dev/null 2>&1 || true
done
# Plus any straggler sidecar processes
pkill -f "Gmail AI Manager.app/Contents/MacOS" 2>/dev/null || true
pkill -f "Gmail AI Filters.app/Contents/MacOS" 2>/dev/null || true
pkill -f "gmail-ai-manager/api/dist/server.js" 2>/dev/null || true
pkill -f "gmail-ai-filters/api/dist/server.js" 2>/dev/null || true
sleep 1
# Wait for port 3001 to free up (up to 10s).
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! lsof -i :3001 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if lsof -i :3001 -sTCP:LISTEN >/dev/null 2>&1; then
  printf "  ${YELLOW}!${RESET} port 3001 still in use; continuing anyway\n"
else
  printf "  ${GREEN}✓${RESET} sidecar stopped\n"
fi

# ── 3. Take a safety copy of the current DB before we touch it ──────────
if [ -f "$TARGET_DB" ]; then
  SAFETY_DIR="$TARGET_DIR/backups/pre-restore-$(date +%Y-%m-%d-%H%M%S)"
  mkdir -p "$SAFETY_DIR"
  cp "$TARGET_DB" "$SAFETY_DIR/data.db"
  printf "  ${GREEN}✓${RESET} pre-restore safety copy: ${DIM}%s${RESET}\n" "$SAFETY_DIR/data.db"
fi

# ── 4. Run the chosen restore mode ──────────────────────────────────────
case "$MODE" in
  full)
    step "Full restore — replacing data.db"
    SRC_DB="$SRC/data.db"
    [ -f "$SRC_DB" ] || die "no data.db found in $SRC"

    # Integrity gate — refuse to swap in a corrupt snapshot. `quick_check`
    # catches the majority of corruption issues without a full table
    # scan; integrity_check is the slow paranoid version. Use the cheap
    # one for the gate and bail loudly if it doesn't return "ok".
    INTEGRITY="$(sqlite3 "$SRC_DB" 'PRAGMA quick_check' 2>&1 | head -n1 || true)"
    if [ "$INTEGRITY" != "ok" ]; then
      die "snapshot fails SQLite integrity check ($INTEGRITY)"
    fi
    printf "  ${GREEN}✓${RESET} snapshot integrity ok\n"

    # Migration-version gate — reject snapshots whose Prisma migration
    # history is older than the live DB (running newer code against an
    # older schema would crash). Equal or newer is fine.
    if [ -f "$TARGET_DB" ]; then
      LIVE_MIGS="$(sqlite3 "$TARGET_DB" 'SELECT COUNT(*) FROM _prisma_migrations' 2>/dev/null || echo "0")"
      SNAP_MIGS="$(sqlite3 "$SRC_DB"    'SELECT COUNT(*) FROM _prisma_migrations' 2>/dev/null || echo "0")"
      if [ "$SNAP_MIGS" -lt "$LIVE_MIGS" ]; then
        die "snapshot has $SNAP_MIGS Prisma migrations vs live $LIVE_MIGS — schema is older than the running app. Aborting."
      fi
      printf "  ${GREEN}✓${RESET} migrations: snapshot %s ≥ live %s\n" "$SNAP_MIGS" "$LIVE_MIGS"
    fi

    mkdir -p "$TARGET_DIR"
    # Use sqlite3 .restore so we handle WAL / shm siblings cleanly.
    # If the target file doesn't exist, plain cp is fine.
    if [ -f "$TARGET_DB" ]; then
      # Atomic replace via a temporary side-file so a crash mid-copy
      # doesn't leave a half-written database.
      TMP="$TARGET_DB.restoring"
      cp "$SRC_DB" "$TMP"
      mv "$TMP" "$TARGET_DB"
      # Nuke any stale WAL/SHM left from the previous live DB.
      rm -f "$TARGET_DB-wal" "$TARGET_DB-shm"
    else
      cp "$SRC_DB" "$TARGET_DB"
    fi
    printf "  ${GREEN}✓${RESET} restored %s → %s\n" \
      "$(stat -f %z "$SRC_DB" 2>/dev/null || stat -c %s "$SRC_DB") bytes" "$TARGET_DB"

    # Restore api/.env (TOKEN_ENC_KEY + OAuth secret). Without this on a
    # fresh machine the snapshot's encrypted token columns are
    # unreadable. Only overwrite when the live file is missing or the
    # caller explicitly confirms — clobbering secrets without warning is
    # a data-loss vector.
    SRC_ENV="$SRC/api.env"
    LIVE_ENV="$TARGET_DIR/api/.env"
    if [ -f "$SRC_ENV" ]; then
      mkdir -p "$TARGET_DIR/api"
      if [ -f "$LIVE_ENV" ]; then
        if [ "${RESTORE_OVERWRITE_ENV:-0}" = "1" ]; then
          cp "$SRC_ENV" "$LIVE_ENV"
          chmod 600 "$LIVE_ENV"
          printf "  ${GREEN}✓${RESET} api/.env overwritten (RESTORE_OVERWRITE_ENV=1)\n"
        else
          printf "  ${YELLOW}!${RESET} api/.env already present; not overwriting.\n"
          printf "    Re-run with RESTORE_OVERWRITE_ENV=1 to replace it (this\n"
          printf "    is REQUIRED if the snapshot's encrypted tokens should be readable).\n"
        fi
      else
        cp "$SRC_ENV" "$LIVE_ENV"
        chmod 600 "$LIVE_ENV"
        printf "  ${GREEN}✓${RESET} api/.env restored\n"
      fi
    fi
    ;;

  merge)
    step "Merge restore — upserting Rule + GmailFilter rows"
    [ -f "$SRC/rules.json" ]         || die "missing rules.json in $SRC"
    [ -f "$SRC/gmail-filters.json" ] || die "missing gmail-filters.json in $SRC"
    [ -f "$TARGET_DB" ]              || die "live DB missing — use --full instead"

    # Pass paths via a parameter rather than interpolating into the SQL
    # heredoc — a backup directory containing a single quote would
    # otherwise break out of the SQL string.
    sqlite3 "$TARGET_DB" \
      -cmd ".param set @rules_path '$(printf %s "$SRC/rules.json" | sed "s/'/''/g")'" \
      -cmd ".param set @filters_path '$(printf %s "$SRC/gmail-filters.json" | sed "s/'/''/g")'" \
      <<'SQL'
-- Rules
INSERT OR REPLACE INTO "Rule"
  ("id","userId","naturalLanguage","actionsJson","originalFilterJson",
   "position","enabled","createdAt","updatedAt")
SELECT
  json_extract(value,'$.id'),
  json_extract(value,'$.userId'),
  json_extract(value,'$.naturalLanguage'),
  json_extract(value,'$.actionsJson'),
  json_extract(value,'$.originalFilterJson'),
  json_extract(value,'$.position'),
  json_extract(value,'$.enabled'),
  json_extract(value,'$.createdAt'),
  json_extract(value,'$.updatedAt')
FROM json_each(readfile(@rules_path));

-- Gmail filter mirrors
INSERT OR REPLACE INTO "GmailFilter"
  ("id","userId","currentGmailId","criteriaJson","actionJson","labelMap",
   "naturalLanguage","enabled","signature","syncedAt","createdAt","updatedAt")
SELECT
  json_extract(value,'$.id'),
  json_extract(value,'$.userId'),
  json_extract(value,'$.currentGmailId'),
  json_extract(value,'$.criteriaJson'),
  json_extract(value,'$.actionJson'),
  json_extract(value,'$.labelMap'),
  json_extract(value,'$.naturalLanguage'),
  json_extract(value,'$.enabled'),
  json_extract(value,'$.signature'),
  json_extract(value,'$.syncedAt'),
  json_extract(value,'$.createdAt'),
  json_extract(value,'$.updatedAt')
FROM json_each(readfile(@filters_path));
SQL

    RULES_AFTER=$(sqlite3 "$TARGET_DB" 'SELECT COUNT(*) FROM "Rule"')
    FILTERS_AFTER=$(sqlite3 "$TARGET_DB" 'SELECT COUNT(*) FROM "GmailFilter"')
    printf "  ${GREEN}✓${RESET} merged — live DB now has %d rule(s), %d filter(s)\n" \
      "$RULES_AFTER" "$FILTERS_AFTER"
    ;;
esac

# ── 5. Optional relaunch ────────────────────────────────────────────────
# Use launchctl if the LaunchAgent is loaded so we restart in place
# instead of racing a second copy of the .app against the keepalive
# child. Falls back to `open` only when the LaunchAgent isn't loaded
# (manual install or dev environment).
if [ "$NO_LAUNCH" = "0" ]; then
  step "Relaunching"
  LABEL="work.supar.gam"
  DOMAIN="gui/$(id -u)"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    printf "  ${GREEN}✓${RESET} kickstarted LaunchAgent %s\n" "$LABEL"
  else
    APP=""
    for candidate in \
      "$HOME/Applications/Gmail AI Manager.app" \
      "$HOME/Applications/Gmail AI Filters.app"
    do
      if [ -d "$candidate" ]; then APP="$candidate"; break; fi
    done
    if [ -n "$APP" ]; then
      open "$APP"
      printf "  ${GREEN}✓${RESET} opened %s\n" "$APP"
    else
      printf "  ${YELLOW}!${RESET} no LaunchAgent and no .app found; relaunch manually\n"
    fi
  fi
fi

echo
printf "${GREEN}${BOLD}Restore complete.${RESET}\n"
