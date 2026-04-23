#!/usr/bin/env bash
#
# Back up user-editable data (AI rules + Gmail filter mirrors + user
# settings) to a timestamped directory, plus a full SQLite snapshot as a
# safety net.
#
# Works while the app is running — we use sqlite3's `.backup` command
# which is WAL-safe.
#
# Usage:
#   scripts/backup.sh                      # default: ~/.../backups/<ts>/
#   scripts/backup.sh /path/to/out-dir     # custom location
#
# Restore with scripts/restore.sh.

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

# ── 1. Locate the live database ──────────────────────────────────────────
DB=""
DATA_DIR=""
for d in \
  "$HOME/Library/Application Support/gmail-ai-manager" \
  "$HOME/Library/Application Support/gmail-ai-filters"
do
  if [ -f "$d/data.db" ]; then
    DB="$d/data.db"
    DATA_DIR="$d"
    break
  fi
done

# Fallback: the dev repo's prisma/dev.db, in case someone ran this from a
# fresh checkout with no install yet.
if [ -z "$DB" ]; then
  REPO="$(cd "$(dirname "$0")/.." && pwd)"
  if [ -f "$REPO/apps/api/prisma/dev.db" ]; then
    DB="$REPO/apps/api/prisma/dev.db"
    DATA_DIR="$REPO/apps/api/prisma"
  fi
fi

if [ -z "$DB" ]; then
  printf "${RED}error:${RESET} no data.db found. Checked:\n" >&2
  printf "  ~/Library/Application Support/gmail-ai-manager/data.db\n" >&2
  printf "  ~/Library/Application Support/gmail-ai-filters/data.db\n" >&2
  printf "  apps/api/prisma/dev.db\n" >&2
  exit 1
fi

# ── 2. Pick an output directory ──────────────────────────────────────────
TS="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="${1:-$DATA_DIR/backups/$TS}"
mkdir -p "$OUT_DIR"

printf "${BOLD}Backing up${RESET} ${DIM}%s${RESET}\n" "$DB"
printf "${BOLD}Writing to${RESET} ${DIM}%s${RESET}\n\n" "$OUT_DIR"

# ── 3. Full SQLite snapshot (WAL-safe, works while app is running) ───────
# sqlite3's `.backup` issues a proper online backup — it acquires a
# shared-lock and writes a consistent copy even if the sidecar is actively
# writing. Much safer than `cp` on a hot file.
printf "▸ full database snapshot\n"
sqlite3 "$DB" ".backup '$OUT_DIR/data.db'"
SNAP_BYTES=$(stat -f %z "$OUT_DIR/data.db" 2>/dev/null || stat -c %s "$OUT_DIR/data.db")
printf "  ${GREEN}✓${RESET} data.db  ${DIM}(%s bytes)${RESET}\n" "$SNAP_BYTES"

# ── 4. JSON exports for human-readable audit + selective restore ─────────
export_json() {
  local table="$1"
  local outfile="$2"
  local query="$3"
  # sqlite3's -json option formats each row as a JSON object. Empty result
  # gives empty string; normalize to [] so json_each on restore doesn't
  # barf on NULL.
  local content
  content="$(sqlite3 -json "$DB" "$query")"
  if [ -z "$content" ]; then
    content="[]"
  fi
  printf "%s\n" "$content" > "$OUT_DIR/$outfile"
  local count
  count="$(sqlite3 "$DB" "SELECT COUNT(*) FROM \"$table\";")"
  printf "  ${GREEN}✓${RESET} %-22s ${DIM}(%s rows)${RESET}\n" "$outfile" "$count"
}

printf "\n▸ JSON exports\n"
export_json "Rule"        "rules.json" \
  'SELECT * FROM "Rule" ORDER BY "userId", "position"'
export_json "GmailFilter" "gmail-filters.json" \
  'SELECT * FROM "GmailFilter" ORDER BY "userId", "updatedAt"'
export_json "User"        "users.json" \
  'SELECT "id","email","googleSub","timezone","status","migratedAt","pollIntervalSec","claudeModel","createdAt","updatedAt" FROM "User"'
export_json "FilterBackup" "filter-backups.json" \
  'SELECT * FROM "FilterBackup" ORDER BY "userId", "createdAt"'

# ── 5. Gmail-filters-only plaintext dump (useful if Gmail ever wipes) ────
# Small human-readable summary that's easy to eyeball.
{
  echo "Gmail AI Manager — Gmail filter mirror summary"
  echo "Exported at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Source DB:   $DB"
  echo "----------------------------------------------"
  sqlite3 "$DB" -column -header <<'SQL'
SELECT
  substr("id", 1, 10)         AS id,
  CASE WHEN "enabled"=1 THEN 'on ' ELSE 'off' END AS state,
  substr("currentGmailId",1,12) AS gmailId,
  substr("naturalLanguage", 1, 70) AS rule,
  substr("updatedAt", 1, 19)  AS updated
FROM "GmailFilter"
ORDER BY "userId","updatedAt" DESC;
SQL
} > "$OUT_DIR/gmail-filters.txt"
printf "  ${GREEN}✓${RESET} gmail-filters.txt\n"

# ── 6. Rules plaintext dump (same idea) ──────────────────────────────────
{
  echo "Gmail AI Manager — AI rules summary"
  echo "Exported at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Source DB:   $DB"
  echo "----------------------------------------------"
  sqlite3 "$DB" -column -header <<'SQL'
SELECT
  "position" AS pos,
  CASE WHEN "enabled"=1 THEN 'on ' ELSE 'off' END AS state,
  substr("id",1,10) AS id,
  substr("naturalLanguage",1,120) AS rule
FROM "Rule"
ORDER BY "userId", "position";
SQL
} > "$OUT_DIR/rules.txt"
printf "  ${GREEN}✓${RESET} rules.txt\n"

# ── 7. Write a README-like restore guide ────────────────────────────────
cat > "$OUT_DIR/RESTORE.md" <<'EOF'
# Backup contents

| File                  | Purpose                                                |
|-----------------------|--------------------------------------------------------|
| `data.db`             | Full SQLite snapshot — the safest thing to restore.    |
| `rules.json`          | Rule table (AI rules you authored), pretty JSON.       |
| `gmail-filters.json`  | GmailFilter table (Gmail filter mirrors), pretty JSON. |
| `users.json`          | User settings (timezone, poll interval, claude model). |
| `filter-backups.json` | Legacy FilterBackup snapshots (rarely used).           |
| `rules.txt`           | Human-readable rules summary.                          |
| `gmail-filters.txt`   | Human-readable Gmail-filter summary.                   |

## Restoring

### Full restore (safest)
Replaces your entire database with the snapshot. User data, history, cache
— everything. Recommended if you just broke something and want to rewind.

```sh
scripts/restore.sh --full "$PWD"
```

### Merge restore (selective)
Re-inserts the Rule + GmailFilter rows from the JSON files. Existing rows
with the same id are overwritten; rows in the live DB that aren't in the
backup are left alone. Useful when you only want to recover deleted rules
without rolling back other state.

```sh
scripts/restore.sh --merge "$PWD"
```

### Manual restore via sqlite3
If `scripts/restore.sh` is unavailable, you can replace the DB yourself.
First quit the app (tray → Quit) so nothing is writing to it, then:

```sh
cp data.db "$HOME/Library/Application Support/gmail-ai-manager/data.db"
```

Or merge a single JSON file:

```sh
sqlite3 "$HOME/Library/Application Support/gmail-ai-manager/data.db" \
  "INSERT OR REPLACE INTO Rule
   SELECT json_extract(v,'\$.id'),
          json_extract(v,'\$.userId'),
          json_extract(v,'\$.naturalLanguage'),
          json_extract(v,'\$.actionsJson'),
          json_extract(v,'\$.originalFilterJson'),
          json_extract(v,'\$.position'),
          json_extract(v,'\$.enabled'),
          json_extract(v,'\$.createdAt'),
          json_extract(v,'\$.updatedAt')
   FROM json_each(readfile('rules.json')) AS _(v)"
```
EOF
printf "  ${GREEN}✓${RESET} RESTORE.md\n"

# ── 8. Summary ──────────────────────────────────────────────────────────
RULES_COUNT="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM "Rule"')"
FILTERS_COUNT="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM "GmailFilter"')"
USERS_COUNT="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM "User"')"

echo
printf "${GREEN}${BOLD}Backup complete.${RESET}\n"
printf "  %d rule(s)\n" "$RULES_COUNT"
printf "  %d Gmail filter(s)\n" "$FILTERS_COUNT"
printf "  %d user(s)\n" "$USERS_COUNT"
echo
printf "  Location: ${BOLD}%s${RESET}\n" "$OUT_DIR"
printf "  Restore:  scripts/restore.sh --full \"%s\"\n" "$OUT_DIR"
echo
