#!/usr/bin/env bash
#
# Rotate Gmail AI Manager logs once a day via the sibling LaunchAgent
# `work.supar.gam.logrotate`. Cap each file at 10 MB; keep 5 generations
# (.1 newest, .5 oldest), then truncate the live file. Without this the
# pino + launchd stdout streams grow unbounded.
#
# Idempotent: safe to run multiple times.

set -euo pipefail

LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/gmail-ai-manager}"
MAX_BYTES="${MAX_BYTES:-10485760}"      # 10 MB
KEEP="${KEEP:-5}"

[ -d "$LOG_DIR" ] || exit 0

stat_size() {
  # macOS BSD stat first, GNU stat fallback for Linux dev environments.
  stat -f %z "$1" 2>/dev/null || stat -c %s "$1"
}

rotate_one() {
  local f="$1"
  [ -f "$f" ] || return 0
  local sz
  sz="$(stat_size "$f")"
  [ "$sz" -lt "$MAX_BYTES" ] && return 0

  # Drop the oldest, shift the rest down. Operate on .gz where present.
  local i
  rm -f "$f.$KEEP" "$f.$KEEP.gz" 2>/dev/null || true
  i=$((KEEP - 1))
  while [ "$i" -ge 1 ]; do
    [ -f "$f.$i" ]    && mv "$f.$i"    "$f.$((i + 1))"
    [ -f "$f.$i.gz" ] && mv "$f.$i.gz" "$f.$((i + 1)).gz"
    i=$((i - 1))
  done

  # Roll the live file into .1. Truncate-in-place so we don't break any
  # process that has the inode open via append-mode (the API + launchd
  # both stream into the same file).
  cp "$f" "$f.1"
  : > "$f"
  gzip -f "$f.1" || true
}

for f in "$LOG_DIR"/*.log; do
  rotate_one "$f"
done
