#!/usr/bin/env bash
#
# Interactive wizard to set up Google OAuth credentials for Gmail AI Manager.
#
# Gmail's filter/label scopes are "restricted" at Google. Rather than have
# everyone share one audited OAuth client, each user creates their own
# Google Cloud project and pastes the Client ID / Secret into their local
# .env. That keeps the app permanently unlisted (Google calls this "testing
# mode") — you add your own email as a test user and nothing else is needed.
#
# Final artifact:
#   <env-dir>/.env   with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
#                    SESSION_SECRET / TOKEN_ENC_KEY / DATABASE_URL set.
#
# Usage:  scripts/setup-google-oauth.sh [env-dir]
#
# If env-dir is omitted, writes to
#   ~/Library/Application Support/gmail-ai-manager/api/.env

set -euo pipefail

# If we were invoked via `curl … | bash`, stdin is the pipe — `read` would hit
# EOF and, combined with `set -e`, silently exit after the first `pause`.
# Reopen stdin from the controlling terminal so prompts actually block.
if [ ! -t 0 ] && [ -r /dev/tty ]; then
  exec < /dev/tty
fi

ENV_DIR="${1:-$HOME/Library/Application Support/gmail-ai-manager/api}"
ENV_FILE="$ENV_DIR/.env"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

mkdir -p "$ENV_DIR"

# Preserve existing .env so re-runs don't clobber. Read values we need.
EXISTING_CLIENT_ID=""
EXISTING_CLIENT_SECRET=""
EXISTING_SESSION_SECRET=""
EXISTING_TOKEN_ENC_KEY=""
EXISTING_DB_URL=""
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC2002
  EXISTING_CLIENT_ID="$(grep -E '^GOOGLE_CLIENT_ID=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  EXISTING_CLIENT_SECRET="$(grep -E '^GOOGLE_CLIENT_SECRET=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  EXISTING_SESSION_SECRET="$(grep -E '^SESSION_SECRET=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  EXISTING_TOKEN_ENC_KEY="$(grep -E '^TOKEN_ENC_KEY=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  EXISTING_DB_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
fi

open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$1" >/dev/null 2>&1 || true
  fi
}

prompt() {
  # $1 = prompt label, $2 = default (optional)
  local label="$1"
  local default="${2:-}"
  local reply
  if [ -n "$default" ]; then
    printf "  %b (press ↵ to keep existing): " "$label"
  else
    printf "  %b: " "$label"
  fi
  read -r reply
  if [ -z "$reply" ] && [ -n "$default" ]; then
    echo "$default"
  else
    echo "$reply"
  fi
}

mask() {
  # Shorten a secret for display.
  local s="$1"
  local n="${#s}"
  if [ "$n" -le 10 ]; then
    echo "(short)"
  else
    echo "${s:0:6}…${s: -4}"
  fi
}

pause() {
  printf "\n  %b[press ↵ to continue]%b " "$DIM" "$RESET"
  read -r _
}

echo
printf "${BOLD}Gmail AI Manager — Google OAuth setup${RESET}\n"
cat <<'EOF'

  Gmail's filter/label scopes are restricted, so each user ships their own
  OAuth client. This wizard walks you through the five clicks on Google
  Cloud Console and saves the result to your local .env file.

  You will NOT publish this client. It stays in "testing mode" and only
  your own Google account is authorized. Google prompts you once with an
  "unverified app" warning — click "Advanced → Go to (unsafe)" to continue.

EOF

# ── Step 1: create a project ──────────────────────────────────────────────
printf "${BOLD}Step 1 — Create a Google Cloud project${RESET}\n"
cat <<'EOF'

  Opening:  https://console.cloud.google.com/projectcreate

  Suggested name:  gmail-ai-manager
  Leave "Location" as "No organization".
  Click CREATE.
EOF
open_url "https://console.cloud.google.com/projectcreate"
pause

# ── Step 2: enable Gmail API ─────────────────────────────────────────────
printf "\n${BOLD}Step 2 — Enable the Gmail API${RESET}\n"
cat <<'EOF'

  Make sure the new project is selected (top bar), then open:
  https://console.cloud.google.com/apis/library/gmail.googleapis.com

  Click ENABLE. (May take ~30 seconds.)
EOF
open_url "https://console.cloud.google.com/apis/library/gmail.googleapis.com"
pause

# ── Step 3: OAuth consent screen ─────────────────────────────────────────
printf "\n${BOLD}Step 3 — Configure the OAuth consent screen${RESET}\n"
cat <<'EOF'

  Opening:  https://console.cloud.google.com/auth/branding

  Click GET STARTED and step through the wizard:
    • App name:           Gmail AI Manager (Local)
    • User support email: <your email>
    • Audience:           External
    • Developer email:    <your email>
    • Agree to the Google user data policy, click CREATE.

  Then in the LEFT SIDEBAR (under "Google Auth Platform") click the
  "Audience" tab. Scroll to the "Test users" section and click its
  "+ Add users" button — paste the Gmail address you want the app to
  manage. Only accounts listed here can sign in while the app is in
  testing mode.
EOF
open_url "https://console.cloud.google.com/auth/branding"
pause

# ── Step 4: create Desktop OAuth client ─────────────────────────────────
printf "\n${BOLD}Step 4 — Create a Desktop-app OAuth client${RESET}\n"
cat <<'EOF'

  Opening:  https://console.cloud.google.com/auth/clients

  Click + CREATE CLIENT.
    • Application type:  Desktop app
    • Name:              Gmail AI Manager CLI
  Click CREATE.
  A dialog shows "Client ID" and "Client secret" — copy both.
EOF
open_url "https://console.cloud.google.com/auth/clients"
pause

# ── Step 5: paste credentials ────────────────────────────────────────────
printf "\n${BOLD}Step 5 — Paste the credentials below${RESET}\n\n"

if [ -n "$EXISTING_CLIENT_ID" ]; then
  printf "  current GOOGLE_CLIENT_ID:     %s\n" "$(mask "$EXISTING_CLIENT_ID")"
fi
CLIENT_ID="$(prompt "Client ID" "$EXISTING_CLIENT_ID")"

if [ -n "$EXISTING_CLIENT_SECRET" ]; then
  printf "  current GOOGLE_CLIENT_SECRET: %s\n" "$(mask "$EXISTING_CLIENT_SECRET")"
fi
CLIENT_SECRET="$(prompt "Client secret" "$EXISTING_CLIENT_SECRET")"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  printf "\n${YELLOW}Client ID and secret are both required. Aborting.${RESET}\n"
  exit 1
fi

# Generate or reuse other secrets.
gen_hex() {
  # $1 = byte count
  node -e "console.log(require('crypto').randomBytes($1).toString('hex'))" 2>/dev/null || \
    openssl rand -hex "$1"
}

SESSION_SECRET="${EXISTING_SESSION_SECRET:-$(gen_hex 32)}"
TOKEN_ENC_KEY="${EXISTING_TOKEN_ENC_KEY:-$(gen_hex 32)}"

# Default DB path sits next to .env if not already set.
DEFAULT_DB="file:$(cd "$ENV_DIR" && cd .. && pwd)/data.db"
DATABASE_URL="${EXISTING_DB_URL:-$DEFAULT_DB}"

# ── Write the .env atomically ────────────────────────────────────────────
TMP="$(mktemp "$ENV_DIR/.env.XXXXXX")"
cat > "$TMP" <<ENV
# Generated by scripts/setup-google-oauth.sh
# Safe to re-run the wizard; existing values will be preserved.

NODE_ENV=production
PORT=3001
PUBLIC_API_URL=http://localhost:3001
PUBLIC_WEB_URL=http://localhost:3001

DATABASE_URL=$DATABASE_URL

SESSION_SECRET=$SESSION_SECRET
TOKEN_ENC_KEY=$TOKEN_ENC_KEY

GOOGLE_CLIENT_ID=$CLIENT_ID
GOOGLE_CLIENT_SECRET=$CLIENT_SECRET
GOOGLE_OAUTH_REDIRECT=http://127.0.0.1:3001/auth/google/callback

CLAUDE_BIN=claude
CLAUDE_MODEL=
ENV
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"

printf "\n${GREEN}✓ Wrote %s${RESET}\n" "$ENV_FILE"
printf "${DIM}  (chmod 600 — only your user can read it)${RESET}\n"

cat <<EOF

${BOLD}Next:${RESET}
  Launch the app from your menu bar. On first sign-in Google will warn
  that the app is unverified — that's expected for testing-mode clients.
  Click ${CYAN}Advanced → Go to Gmail AI Manager (unsafe)${RESET} to proceed.

  To re-run this wizard later:
    scripts/setup-google-oauth.sh "$ENV_DIR"

EOF
