#!/usr/bin/env bash
#
# Install a macOS LaunchAgent that auto-starts Gmail AI Manager on login
# and keeps it running after logout/reboot. Uses launchd's native exec
# path which sidesteps the LaunchServices-spawn bug that hangs the
# sidecar's @prisma/client dlopen.
#
# Idempotent — re-running replaces the existing plist and bounces the job.
#
# Usage:
#   scripts/install-launch-agent.sh
#
# Uninstall with scripts/uninstall-launch-agent.sh.

set -euo pipefail

LABEL="work.supar.gam"
LOGROTATE_LABEL="work.supar.gam.logrotate"
APP_BIN="$HOME/Applications/Gmail AI Manager.app/Contents/MacOS/gam-desktop"
LOG_DIR="$HOME/Library/Logs/gmail-ai-manager"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
LOGROTATE_PLIST="$AGENT_DIR/$LOGROTATE_LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROTATE_SCRIPT="$SCRIPT_DIR/rotate-logs.sh"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[2m'
RESET='\033[0m'

if [ ! -x "$APP_BIN" ]; then
  echo "error: $APP_BIN not found. Run scripts/install-from-source.sh first." >&2
  exit 1
fi

mkdir -p "$AGENT_DIR" "$LOG_DIR"

UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

# Unload prior instance (if any) before rewriting the file. Silent failure
# is fine — launchctl returns non-zero if the label isn't loaded.
# bootout is the modern command; launchctl unload is the legacy one.
# We try both for cross-version compatibility with older macOS.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true

printf "${BOLD}▸ Writing LaunchAgent plist${RESET} ${DIM}%s${RESET}\n" "$PLIST"

# PlistBuddy handles XML escaping of the embedded path (which contains
# spaces — "Gmail AI Manager.app"). Hand-rolled heredoc would need every
# special char escaped manually.
rm -f "$PLIST"
/usr/libexec/PlistBuddy -c "Clear dict" "$PLIST" 2>/dev/null || true
cat > "$PLIST" <<PLIST_HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
PLIST_HEAD

# Detect where `claude` actually lives so the LaunchAgent's PATH
# includes it — `spawn claude` from the sidecar fails with ENOENT
# otherwise. launchd doesn't inherit the user's shell PATH.
CLAUDE_PATH=""
for cand in "$HOME/.local/bin" "$HOME/.claude/local" "/opt/homebrew/bin" "/usr/local/bin"; do
  if [ -x "$cand/claude" ]; then
    CLAUDE_PATH="$cand"
    break
  fi
done

# Fall back to a standard set even if `claude` wasn't found — the user
# may install it after this script runs.
PLIST_PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.claude/local:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -n "$CLAUDE_PATH" ]; then
  printf "  ${DIM}detected claude at %s/claude${RESET}\n" "$CLAUDE_PATH"
fi

/usr/libexec/PlistBuddy \
  -c "Add :Label string $LABEL" \
  -c "Add :ProgramArguments array" \
  -c "Add :ProgramArguments:0 string $APP_BIN" \
  -c "Add :RunAtLoad bool true" \
  -c "Add :ProcessType string Interactive" \
  -c "Add :StandardOutPath string $LOG_DIR/launchd.out.log" \
  -c "Add :StandardErrorPath string $LOG_DIR/launchd.err.log" \
  -c "Add :WorkingDirectory string $HOME" \
  -c "Add :EnvironmentVariables dict" \
  -c "Add :EnvironmentVariables:PATH string $PLIST_PATH" \
  -c "Add :EnvironmentVariables:HOME string $HOME" \
  -c "Add :KeepAlive dict" \
  -c "Add :KeepAlive:SuccessfulExit bool false" \
  -c "Add :ThrottleInterval integer 30" \
  "$PLIST"

# ThrottleInterval bounds the relaunch loop when the binary fails fast
# (bad .env, port already taken, schema mismatch). Default is 10s; with
# our crash-loop scenario that fills launchd.err.log within minutes.
# 30s keeps the user-visible recovery time short while not bleeding the
# disk dry overnight.

# ── Security: plist must be owned by the user + 0644. ──────────────────
chown "$UID_NUM" "$PLIST"
chmod 0644 "$PLIST"

# ── Load the agent into the user's gui session. ─────────────────────────
# `bootstrap` is the macOS 10.10+ replacement for `launchctl load`. If the
# modern command fails (older macOS), fall back. Then kickstart to run
# immediately (RunAtLoad only fires once per plist load).
if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
  :
else
  launchctl load -w "$PLIST"
fi

# Kick any already-started tray app so the fresh one takes :3001.
pkill -f "gam-desktop" 2>/dev/null || true
pkill -f "gmail-ai-manager/api/dist/server.js" 2>/dev/null || true
sleep 1

launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true

# ── Sibling LaunchAgent: daily log rotation. ──────────────────────────
# Without rotation the pino + launchd stdout streams climb to several
# hundred MB/week on an active install. Run rotate-logs.sh once a day
# at 03:30 local time; it caps each file at 10 MB and keeps 5 .gz
# archives.
if [ -x "$ROTATE_SCRIPT" ]; then
  launchctl bootout "$DOMAIN/$LOGROTATE_LABEL" 2>/dev/null || true
  launchctl unload  "$LOGROTATE_PLIST"          2>/dev/null || true
  rm -f "$LOGROTATE_PLIST"

  /usr/libexec/PlistBuddy \
    -c "Add :Label string $LOGROTATE_LABEL" \
    -c "Add :ProgramArguments array" \
    -c "Add :ProgramArguments:0 string /bin/bash" \
    -c "Add :ProgramArguments:1 string $ROTATE_SCRIPT" \
    -c "Add :StartCalendarInterval dict" \
    -c "Add :StartCalendarInterval:Hour integer 3" \
    -c "Add :StartCalendarInterval:Minute integer 30" \
    -c "Add :EnvironmentVariables dict" \
    -c "Add :EnvironmentVariables:HOME string $HOME" \
    -c "Add :EnvironmentVariables:LOG_DIR string $LOG_DIR" \
    -c "Add :StandardOutPath string $LOG_DIR/logrotate.out.log" \
    -c "Add :StandardErrorPath string $LOG_DIR/logrotate.err.log" \
    "$LOGROTATE_PLIST"
  chown "$UID_NUM" "$LOGROTATE_PLIST"
  chmod 0644 "$LOGROTATE_PLIST"
  if launchctl bootstrap "$DOMAIN" "$LOGROTATE_PLIST" 2>/dev/null; then
    :
  else
    launchctl load -w "$LOGROTATE_PLIST"
  fi
  printf "${GREEN}✓ Installed log rotation${RESET} ${DIM}(daily 03:30, 10MB cap, 5 .gz)${RESET}\n"
else
  printf "${YELLOW}!${RESET} %s not executable — skipping log-rotation install\n" "$ROTATE_SCRIPT"
fi

printf "${GREEN}✓ Installed and started${RESET} ${DIM}(label: $LABEL)${RESET}\n"
echo
echo "  The tray app will now auto-start on every login."
echo "  Logs:  $LOG_DIR/launchd.{out,err}.log"
echo "  Plist: $PLIST"
echo
echo "  Manually stop:   launchctl kill TERM $DOMAIN/$LABEL"
echo "  Manually start:  launchctl kickstart $DOMAIN/$LABEL"
echo "  Uninstall:       scripts/uninstall-launch-agent.sh"
