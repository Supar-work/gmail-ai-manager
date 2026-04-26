#!/usr/bin/env bash
#
# Gmail AI Manager — one-liner installer.
#
#   curl -fsSL https://gmailaimanager.supar.work/install.sh | bash
#
# Or, for the GitHub Pages canonical URL (works before DNS is set up):
#   curl -fsSL https://supar-work.github.io/gmail-ai-manager/install.sh | bash
#
# This clones the source to ~/src/gmail-ai-manager, runs a prerequisite
# check, walks you through Google OAuth setup, builds the Tauri app from
# source, and installs it to ~/Applications.
#
# Environment overrides:
#   GAM_SRC_DIR   – where to clone  (default: ~/src/gmail-ai-manager)
#   GAM_REPO_URL  – git remote      (default: https://github.com/Supar-work/gmail-ai-manager.git)
#   GAM_REF       – branch or tag   (default: main)

set -euo pipefail

SRC_DIR="${GAM_SRC_DIR:-$HOME/src/gmail-ai-manager}"
REPO_URL="${GAM_REPO_URL:-https://github.com/Supar-work/gmail-ai-manager.git}"
REF="${GAM_REF:-main}"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

banner() {
  cat <<'EOF'

   ┌─────────────────────────────────────────────┐
   │      Gmail AI Manager — local installer     │
   │   natural-language filters, runs on-device  │
   └─────────────────────────────────────────────┘

EOF
}

die() {
  printf "${RED}error:${RESET} %s\n" "$*" >&2
  exit 1
}

banner

# ── 1. Sanity: macOS Apple Silicon ───────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  die "This release supports macOS on Apple Silicon only (got $OS / $ARCH).
    Intel Macs, Linux, and Windows are not yet packaged.
    Track progress at https://github.com/Supar-work/gmail-ai-manager/issues."
fi

# ── 2. Xcode Command Line Tools ──────────────────────────────────────────
# macOS ships a /usr/bin/git stub that forwards to the Command Line Tools;
# without them, git (and many Homebrew builds) fails. `command -v git`
# always succeeds because the stub exists — we need to verify the tools are
# actually installed via `xcode-select -p`.
ensure_xcode_clt() {
  if xcode-select -p >/dev/null 2>&1; then
    return 0
  fi
  printf "\n${BOLD}▸ Xcode Command Line Tools are required but not installed.${RESET}\n"
  printf "${DIM}  They provide git, clang, make, etc. (~500 MB download).${RESET}\n\n"

  # IMPORTANT: when this script is invoked via `curl … | bash`, stdin is the
  # pipe carrying the rest of the script source. Do NOT `exec < /dev/tty` —
  # that replaces the pipe and bash loses the unread portion of itself,
  # falling into an interactive prompt. Read directly from /dev/tty instead.
  local reply=""
  if [ -r /dev/tty ]; then
    printf "  Install them now? [Y/n] "
    read -r reply < /dev/tty
  fi
  case "$reply" in
    [nN]*)
      die "Xcode CLT required. Re-run after:  xcode-select --install"
      ;;
  esac

  printf "${BOLD}▸ Triggering installer${RESET} ${DIM}(a system dialog will appear)${RESET}\n"
  xcode-select --install >/dev/null 2>&1 || true

  printf "  Waiting for install to complete"
  while ! xcode-select -p >/dev/null 2>&1; do
    printf "."
    sleep 5
  done
  printf " ${GREEN}done${RESET}\n"
}

# ── 3. Clone or update ───────────────────────────────────────────────────
if [ ! -d "$SRC_DIR/.git" ]; then
  ensure_xcode_clt
  printf "${BOLD}▸ Cloning into %s${RESET}\n" "$SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --branch "$REF" --depth 1 "$REPO_URL" "$SRC_DIR"
else
  printf "${BOLD}▸ Updating existing checkout at %s${RESET}\n" "$SRC_DIR"
  git -C "$SRC_DIR" fetch origin "$REF"
  git -C "$SRC_DIR" checkout "$REF"
  git -C "$SRC_DIR" pull --ff-only
fi

# ── 3. Hand off to scripts/install-from-source.sh ────────────────────────
if [ ! -x "$SRC_DIR/scripts/install-from-source.sh" ]; then
  die "checkout at $SRC_DIR is missing scripts/install-from-source.sh — repo may be corrupted."
fi

printf "\n${DIM}Next: prerequisite check, OAuth wizard, then build + install.${RESET}\n"
printf "${DIM}Source lives at ${CYAN}%s${RESET}${DIM} — safe to delete after install,${RESET}\n" "$SRC_DIR"
printf "${DIM}but keep it if you want easy updates via scripts/update.sh.${RESET}\n"

exec "$SRC_DIR/scripts/install-from-source.sh" "$@"
