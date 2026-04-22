# @gaf/desktop

Tauri menu-bar shell. Spawns the Node API sidecar, shows a tray icon, and
opens the web UI in the user's default browser.

## Requirements

- Rust toolchain: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node ≥ 20 (for the API sidecar)
- macOS build deps already shipped with Xcode Command Line Tools

## First-time setup

```bash
# from repo root
pnpm install

# Generate icons (one time)
cd apps/desktop
pnpm tauri icon /path/to/1024x1024.png
```

## Dev

```bash
# from repo root
pnpm --filter @gaf/api build   # compile TS → dist/server.js
pnpm --filter @gaf/desktop dev # launches tray + sidecar
```

`pnpm --filter @gaf/desktop dev` starts `tauri dev`, which in turn launches
`pnpm --filter @gaf/api run dev` (watched TS) as defined in `tauri.conf.json`.
In dev mode the sidecar spawn in `lib.rs` will no-op if `apps/api/dist` is
missing — that's fine, the `beforeDevCommand` tsx-watch is running the API
directly.

## Release build

```bash
pnpm --filter @gaf/desktop build
```

Produces `apps/desktop/src-tauri/target/release/bundle/{macos,dmg}/`.
