# gmail-ai-filters

Natural-language rules for Gmail, evaluated locally by Claude Code.

Ships as a macOS menu-bar app: the tray icon spawns a Node API sidecar and
opens the web UI in the user's default browser. SQLite stores rules and
scheduled actions; the Gmail inbox is polled on a timer, and rules are
classified by shelling out to `claude -p`.

## Stack

- **Shell** — Tauri 2 (Rust, menu-bar only, no dock icon) — `apps/desktop`
- **API** — Node + Express + TypeScript + Prisma — `apps/api`
- **Web** — React + Vite + TypeScript — `apps/web`
- **DB** — SQLite (file under `~/Library/Application Support/gmail-ai-filters/` in prod)
- **AI** — `claude -p` subprocess
- **Auth** — Google OAuth (loopback redirect, `http://127.0.0.1:3001`)

## Prerequisites

- Node ≥ 20
- Claude Code CLI on `$PATH` (`claude --version` works)
- GCP project with a Google OAuth client (Desktop or Web type — either accepts localhost)
- Rust toolchain (only for `apps/desktop`): `rustup-init`

## Local dev

```bash
pnpm install
cp apps/api/.env.example apps/api/.env  # fill in Google creds + secrets
pnpm db:migrate                         # create dev.db
pnpm dev                                # api:3001 + web:5173
```

To use the tray shell during dev:

```bash
pnpm --filter @gaf/api build      # once; the rust binary spawns dist/server.js
pnpm --filter @gaf/desktop dev
```

Open the web UI at `http://localhost:5173` (dev) or click the tray icon →
"Open Gmail AI Filters" (which opens `http://127.0.0.1:3001`).

## OAuth client setup (GCP)

1. Create a GCP project.
2. Enable the Gmail API.
3. Create an OAuth client of type **Desktop** (or **Web** with
   `http://127.0.0.1:3001/auth/google/callback` as the authorized redirect).
4. Put the client id + secret in `apps/api/.env`.

## First-run flow

Landing page has three buttons:

1. **Clean up my inbox** (coming soon)
2. **Set up / manage my AI filters** — on first run this backs up your
   Gmail filters, translates them to natural-language rules via `claude -p`,
   creates Rule rows, and deletes the original filters from Gmail. On
   subsequent runs it skips straight to the rules page.
3. **Open Gmail** — opens `mail.google.com` in a new tab.
