App and tray icons go here.

Required files (Tauri v2 bundler will fail without them):

- `tray.png` — 22×22 monochrome PNG used as the macOS menu-bar icon
- `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` — app/bundle icons

Generate a set from a single 1024×1024 source image with:

    pnpm tauri icon path/to/source.png

from `apps/desktop/`.

For macOS menu-bar look-and-feel, `tray.png` should be template-style
(black-on-transparent); `tauri.conf.json` has `iconAsTemplate: true` set.
