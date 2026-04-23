#!/usr/bin/env bash
#
# Verify that the host machine can build and run Gmail AI Manager.
#
# Exits 0 if every hard requirement is satisfied. Exits 1 and prints
# copy-paste install hints for any missing pieces.
#
# Usage:  scripts/check-requirements.sh              – human output
#         scripts/check-requirements.sh --quiet      – suppress ok lines
#
# Kept as pure POSIX shell so it runs before pnpm / node are installed.

set -u

QUIET=0
for arg in "$@"; do
  case "$arg" in
    --quiet|-q) QUIET=1 ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

FAIL=0
ISSUES=()

ok() {
  [ "$QUIET" = "1" ] || printf "  ${GREEN}✓${RESET} %s\n" "$1"
}
fail() {
  printf "  ${RED}✗${RESET} %s\n" "$1"
  ISSUES+=("$2")
  FAIL=1
}
warn() {
  printf "  ${YELLOW}!${RESET} %s\n" "$1"
}

printf "${BOLD}Gmail AI Manager — environment check${RESET}\n"

# ── 1. macOS Apple Silicon ─────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  ok "macOS on Apple Silicon ($ARCH)"
else
  fail "unsupported platform: $OS / $ARCH" \
       "This release only supports macOS on Apple Silicon (M1/M2/M3/M4). Intel + Linux + Windows are not yet packaged."
fi

# ── 2. Xcode command line tools (required for Rust + native node modules) ──
if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode command line tools installed ($(xcode-select -p))"
else
  fail "Xcode command line tools missing" \
       "Install with:  xcode-select --install   (accept the GUI prompt, takes ~5 min)"
fi

# ── 3. git ────────────────────────────────────────────────────────────────
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  fail "git not found" \
       "git ships with Xcode command line tools. Re-run: xcode-select --install"
fi

# ── 4. Node ≥ 20 ──────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node --version | sed 's/^v//')"
  NODE_MAJOR="${NODE_VER%%.*}"
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "node v$NODE_VER"
  else
    fail "node v$NODE_VER is too old (need ≥ 20)" \
         "Upgrade with:  brew install node   (or use nvm: https://github.com/nvm-sh/nvm)"
  fi
else
  fail "node not found" \
       "Install with:  brew install node   (Homebrew) or download https://nodejs.org"
fi

# ── 5. pnpm ≥ 9 ──────────────────────────────────────────────────────────
if command -v pnpm >/dev/null 2>&1; then
  PNPM_VER="$(pnpm --version)"
  PNPM_MAJOR="${PNPM_VER%%.*}"
  if [ "$PNPM_MAJOR" -ge 9 ] 2>/dev/null; then
    ok "pnpm v$PNPM_VER"
  else
    warn "pnpm v$PNPM_VER — v9+ recommended (continuing)"
  fi
else
  fail "pnpm not found" \
       "Install with:  corepack enable && corepack prepare pnpm@latest --activate   (preferred, ships with node ≥ 20)
                  or  npm install -g pnpm
                  or  brew install pnpm"
fi

# ── 6. Rust toolchain (cargo) ─────────────────────────────────────────────
if command -v cargo >/dev/null 2>&1; then
  RUST_VER="$(rustc --version | awk '{print $2}')"
  ok "rust $RUST_VER"
else
  fail "cargo / rustc not found" \
       "Install with:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
                       Then run:  source \"\$HOME/.cargo/env\""
fi

# ── 7. Claude Code CLI ────────────────────────────────────────────────────
if command -v claude >/dev/null 2>&1; then
  CLAUDE_VER="$(claude --version 2>/dev/null | head -n1 || echo 'unknown')"
  ok "claude CLI present ($CLAUDE_VER)"
  # Probe auth: runClaudeJson will explode later if unauthenticated.
  # We don't actually invoke claude here (slow, costs tokens); we just warn.
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "$HOME/Library/Application Support/Claude Code/config.json" ] \
       && [ ! -f "$HOME/.claude/config.json" ]; then
    warn "claude auth config not detected — run  claude login  before first use"
  fi
else
  fail "claude CLI not found" \
       "Gmail AI Manager uses Claude Code to classify emails.
    Install it from:  https://docs.claude.com/en/docs/claude-code/setup
    Then sign in:     claude login"
fi

# ── 8. curl (used by installer + for open url) ────────────────────────────
if command -v curl >/dev/null 2>&1; then
  ok "curl present"
else
  fail "curl not found" \
       "curl ships with macOS. If missing, repair with: xcode-select --install"
fi

# ── summary ───────────────────────────────────────────────────────────────
echo
if [ "$FAIL" = "0" ]; then
  printf "${GREEN}All checks passed.${RESET}\n"
  exit 0
else
  printf "${RED}${BOLD}Missing prerequisites.${RESET} Fix the items above, then re-run.\n\n"
  i=1
  for issue in "${ISSUES[@]}"; do
    printf "${BOLD}[%d]${RESET} %s\n\n" "$i" "$issue"
    i=$((i+1))
  done
  exit 1
fi
