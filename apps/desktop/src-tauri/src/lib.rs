use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent,
};
use tauri_plugin_opener::OpenerExt;

/// Tray icon baked into the binary at compile time.
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray.png");

/// Holds the Node sidecar process so we can kill it cleanly on quit.
struct Sidecar(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            // Behave like a menu-bar accessory: no dock icon, no initial window.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Spawn the Node sidecar in dev mode. In a bundled build the
            // Tauri sidecar mechanism should package a node binary; for now
            // we shell out to the system node, matching the pnpm dev flow.
            if let Some(child) = spawn_sidecar(app.handle()) {
                app.state::<Sidecar>().0.lock().unwrap().replace(child);
            }

            // Build the tray menu.
            let open_item = MenuItem::with_id(app, "open", "Open Gmail AI Filters", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            let tray_icon = Image::from_bytes(TRAY_ICON_BYTES)?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(false)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        let _ = app.opener().open_url("http://localhost:3001", None::<&str>);
                    }
                    "quit" => {
                        kill_sidecar(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_sidecar(app);
            }
        });
}

fn spawn_sidecar(_app: &tauri::AppHandle) -> Option<Child> {
    // Preferred install location: ~/Library/Application Support/gmail-ai-filters/api
    // (written by apps/desktop/scripts/install.sh). Falls back to walking up
    // from the binary to find apps/api/dist/server.js — that path is only hit
    // during dev when we launch from inside the repo.
    let api_entry = installed_api_entry()
        .filter(|p| p.exists())
        .or_else(|| {
            let exe = std::env::current_exe().ok()?;
            let mut cursor: Option<&std::path::Path> = exe.parent();
            loop {
                match cursor {
                    Some(dir) => {
                        let candidate =
                            dir.join("apps").join("api").join("dist").join("server.js");
                        if candidate.exists() {
                            return Some(candidate);
                        }
                        cursor = dir.parent();
                    }
                    None => return None,
                }
            }
        });

    let Some(api_entry) = api_entry else {
        eprintln!(
            "[gaf-desktop] api sidecar not found — run apps/desktop/scripts/install.sh or `pnpm --filter @gaf/api build`"
        );
        return None;
    };

    // Pass apps/api/.env alongside the server entry. `--env-file` works on
    // Node ≥ 20 and mirrors the `pnpm dev` flow.
    let env_file = api_entry
        .parent()
        .and_then(|p| p.parent())
        .map(|api_dir| api_dir.join(".env"));

    eprintln!("[gaf-desktop] spawning api sidecar: node {}", api_entry.display());
    let mut cmd = Command::new("node");
    if let Some(env_file) = env_file.as_ref() {
        if env_file.exists() {
            cmd.arg(format!("--env-file={}", env_file.display()));
        } else {
            eprintln!("[gaf-desktop] warning: no .env at {}", env_file.display());
        }
    }

    // When launched from Finder / `open`, the app's stdio goes to /dev/null.
    // Redirect the sidecar's stdout + stderr to ~/Library/Logs/gmail-ai-filters/
    // so errors are inspectable via `tail`.
    let log_target: Stdio = match std::env::var_os("HOME") {
        Some(home) => {
            let log_dir = std::path::PathBuf::from(&home)
                .join("Library")
                .join("Logs")
                .join("gmail-ai-filters");
            let _ = std::fs::create_dir_all(&log_dir);
            match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join("server.log"))
            {
                Ok(f) => Stdio::from(f),
                Err(_) => Stdio::inherit(),
            }
        }
        None => Stdio::inherit(),
    };
    let log_target_err: Stdio = match std::env::var_os("HOME") {
        Some(home) => {
            let log_path = std::path::PathBuf::from(&home)
                .join("Library")
                .join("Logs")
                .join("gmail-ai-filters")
                .join("server.log");
            match std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
                Ok(f) => Stdio::from(f),
                Err(_) => Stdio::inherit(),
            }
        }
        None => Stdio::inherit(),
    };

    cmd.arg(&api_entry)
        .stdout(log_target)
        .stderr(log_target_err)
        .env("NODE_ENV", "production");
    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(err) => {
            eprintln!("[gaf-desktop] failed to spawn node sidecar: {err}");
            None
        }
    }
}

/// Default install location for the Node API sidecar. Kept alongside other
/// per-user app state under Application Support so macOS doesn't prompt for
/// iCloud / Documents access when launching from /Applications.
fn installed_api_entry() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("gmail-ai-filters")
            .join("api")
            .join("dist")
            .join("server.js"),
    )
}

fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Sidecar>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}
