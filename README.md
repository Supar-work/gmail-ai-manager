# Gmail AI Manager

> Natural-language filters for Gmail, running on your Mac.

Replace Gmail's rigid filter language with rules you can actually write —
`archive Substack unless a friend wrote it`, `file Stripe receipts under
Finance and skip the inbox`. Rules are evaluated locally by the
[Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview);
your email never leaves your machine.

Docs + install: **[gmailaimanager.supar.work](https://gmailaimanager.supar.work)**
(or [supar-work.github.io/gmail-ai-manager](https://supar-work.github.io/gmail-ai-manager)
before DNS is live).

## Install

```bash
curl -fsSL https://gmailaimanager.supar.work/install.sh | bash
```

The installer:

1. Verifies prerequisites (macOS Apple Silicon, Xcode CLI, Node ≥ 20, pnpm,
   Rust, `claude`).
2. Clones to `~/src/gmail-ai-manager`.
3. Walks you through creating a **personal Google Cloud OAuth client**
   (bring-your-own; takes ~5 minutes) — Gmail's filter/label scopes are
   restricted, so we don't ship a shared one.
4. Builds the Tauri bundle from source.
5. Deploys to `~/Applications/Gmail AI Manager.app` and data to
   `~/Library/Application Support/gmail-ai-manager/`.
6. Registers a LaunchAgent so the tray app auto-starts on every login
   (`~/Library/LaunchAgents/work.supar.gam.plist`, `RunAtLoad=true`,
   restart-on-crash via `KeepAlive.SuccessfulExit=false`).

Updating later: `~/src/gmail-ai-manager/scripts/update.sh`.

Backups: `scripts/backup.sh` writes a timestamped directory with a full
SQLite snapshot + JSON exports of your rules and Gmail filters. The
installer/updater call it automatically before making changes. Restore
with `scripts/restore.sh --full <dir>` (wholesale) or `--merge <dir>`
(upsert rules + filters only).

Full walkthrough, screenshots, and troubleshooting:
[gmailaimanager.supar.work](https://gmailaimanager.supar.work).

## What it does

- **Natural-language rules.** Rules compile to a JSON action list
  (label / archive / reply / snooze / …). `trash` is never emitted —
  archive is the strongest allowed action.
- **Gmail filter import.** Per-filter wizard translates your existing
  native filters to AI rules. Pre-fetches translations + label
  recommendations in the background so pages load instantly.
- **Canonical label suggestions.** Claude samples 8 recent matching
  emails and suggests a two-level label (e.g. `Family/Basis`). Accepting
  creates the label and migrates existing messages via Gmail
  `batchModify`.
- **Local-first scheduler.** SQLite on disk, in-process poller.
  Pause / resume / stop any run from the tray.

## Stack

| Layer | Tech |
| --- | --- |
| Shell | Tauri 2 (Rust, menu-bar, no dock icon) — `apps/desktop` |
| API   | Node + Express + TypeScript + Prisma — `apps/api`     |
| Web   | React + Vite + TypeScript — `apps/web`                |
| DB    | SQLite (`~/Library/Application Support/gmail-ai-manager/data.db`) |
| AI    | `claude -p` subprocess                                |
| Auth  | Google OAuth loopback (`http://127.0.0.1:3001/auth/google/callback`) |

## Repo layout

```
apps/
  api/           Express + Prisma sidecar (starts as Node child of Tauri)
  web/           Vite React UI served by the API in prod
  desktop/       Tauri 2 menu-bar shell
packages/shared/ zod schemas + action types shared across api + web
scripts/
  check-requirements.sh
  setup-google-oauth.sh
  install-from-source.sh
  install-launch-agent.sh  # auto-start on login
  uninstall-launch-agent.sh
  update.sh
  backup.sh
  restore.sh
  launch.sh                # manual launch bypassing LaunchServices
docs/            GitHub Pages site (index.html + install.sh)
```

## Development

Requires everything the installer checks for. Once you have a local `.env`
(run `scripts/setup-google-oauth.sh` or copy the installed one):

```bash
pnpm install
pnpm --filter @gam/api run db:migrate
pnpm dev                           # api:3001 + web:5173
```

Tray shell during dev:

```bash
pnpm --filter @gam/api build       # compile sidecar once
pnpm --filter @gam/desktop dev     # launches tauri dev
```

Lint / typecheck / test:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## Contributing

Issues + PRs welcome at
[github.com/Supar-work/gmail-ai-manager](https://github.com/Supar-work/gmail-ai-manager).
The app is deliberately narrow in scope (Gmail, macOS, local-only). Please
open an issue before sending large patches — especially for new actions or
cross-platform ports.

## License

[MIT](./LICENSE). Copyright © 2026 Or Zuk / Supar Work.
