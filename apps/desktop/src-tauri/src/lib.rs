use std::os::unix::process::CommandExt;
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

            // Build the tray menu. Pause/Resume + Stop run match the
            // README's promise; they POST to /api/control/* over loopback.
            let open_item = MenuItem::with_id(app, "open", "Open Gmail AI Manager", true, None::<&str>)?;
            let pause_item = MenuItem::with_id(app, "pause", "Pause polling", true, None::<&str>)?;
            let resume_item = MenuItem::with_id(app, "resume", "Resume polling", true, None::<&str>)?;
            let stop_runs_item = MenuItem::with_id(app, "stop_runs", "Stop current run", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &pause_item,
                    &resume_item,
                    &stop_runs_item,
                    &quit_item,
                ],
            )?;

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
                    "pause" => {
                        post_loopback("/api/control/pause");
                    }
                    "resume" => {
                        post_loopback("/api/control/resume");
                    }
                    "stop_runs" => {
                        post_loopback("/api/control/stop-runs");
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
    // Preferred install location: ~/Library/Application Support/gmail-ai-manager/api
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
            "[gam-desktop] api sidecar not found — run apps/desktop/scripts/install.sh or `pnpm --filter @gam/api build`"
        );
        return None;
    };

    // Pass apps/api/.env alongside the server entry. `--env-file` works on
    // Node ≥ 20 and mirrors the `pnpm dev` flow.
    let env_file = api_entry
        .parent()
        .and_then(|p| p.parent())
        .map(|api_dir| api_dir.join(".env"));

    eprintln!("[gam-desktop] spawning api sidecar: node {}", api_entry.display());
    let mut cmd = Command::new("node");
    // Read .env ourselves and pass values via cmd.env() instead of
    // `node --env-file=<path>`. Node's --env-file implementation uses a
    // synthetic ESM module internally; under macOS LaunchServices (i.e.
    // `open Gmail\ AI\ Manager.app`) its evaluation deadlocks before
    // reaching `app.listen()`. Doing the parse in Rust side-steps that
    // whole code path.
    if let Some(env_file) = env_file.as_ref() {
        if env_file.exists() {
            if let Ok(contents) = std::fs::read_to_string(env_file) {
                for line in contents.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    if let Some((k, v)) = trimmed.split_once('=') {
                        // Strip surrounding single / double quotes that some
                        // .env files use for values with spaces.
                        let v = v.trim();
                        let v = v
                            .strip_prefix('"').and_then(|s| s.strip_suffix('"'))
                            .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                            .unwrap_or(v);
                        cmd.env(k.trim(), v);
                    }
                }
            } else {
                eprintln!("[gam-desktop] warning: failed reading {}", env_file.display());
            }
        } else {
            eprintln!("[gam-desktop] warning: no .env at {}", env_file.display());
        }
    }

    // When launched from Finder / `open`, the app's stdio goes to /dev/null.
    // Redirect the sidecar's stdout + stderr to ~/Library/Logs/gmail-ai-manager/
    // so errors are inspectable via `tail`.
    let log_target: Stdio = match std::env::var_os("HOME") {
        Some(home) => {
            let log_dir = std::path::PathBuf::from(&home)
                .join("Library")
                .join("Logs")
                .join("gmail-ai-manager");
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
                .join("gmail-ai-manager")
                .join("server.log");
            match std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
                Ok(f) => Stdio::from(f),
                Err(_) => Stdio::inherit(),
            }
        }
        None => Stdio::inherit(),
    };

    cmd.arg(&api_entry)
        .stdin(Stdio::null())
        .stdout(log_target)
        .stderr(log_target_err)
        .env("NODE_ENV", "production");

    // Detach the child into its own session. When Tauri is launched via
    // macOS LaunchServices (`open Gmail\ AI\ Manager.app`), the node
    // sidecar otherwise inherits LaunchServices' XPC-managed session, in
    // which some dylib loads (notably @prisma/client's libquery_engine)
    // block indefinitely before reaching `app.listen()`. `setsid` moves
    // the child to a new session so those loads behave the same as when
    // launched from a terminal.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                // setsid can fail if the caller is already a session leader;
                // in that case fall back to leaving the session as-is.
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::EPERM) {
                    return Err(err);
                }
            }
            Ok(())
        });
    }

    // Claude Code leaks session state through env vars when a child process is
    // spawned from an agent-running shell. If these propagate into our sidecar,
    // every `claude -p` we spawn will pick up the agent's short-lived OAuth
    // token and 401 the user's CLI auth. Strip them so the CLI always falls
    // back to the user's Keychain OAuth regardless of launch context.
    for key in [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_SDK_VERSION",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_CODE_SSE_PORT",
    ] {
        cmd.env_remove(key);
    }
    // Blanket-scrub any remaining CLAUDE_CODE_* env var (CLAUDE_MODEL /
    // CLAUDE_BIN are user settings and not prefixed this way).
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(k);
        }
    }

    // Strip macOS LaunchServices / XPC attribution env vars. When the .app
    // is launched via `open`, launchd injects these to tie the process to
    // an XPC-managed session. Passing them to the child appears to make
    // Prisma's dlopen of libquery_engine block under that session.
    // Removing them makes the node sidecar look like a plain terminal
    // process to dyld.
    for key in [
        "__CFBundleIdentifier",
        "XPC_SERVICE_NAME",
        "XPC_FLAGS",
        "__OSINSTALL_ENVIRONMENT",
    ] {
        cmd.env_remove(key);
    }

    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(err) => {
            eprintln!("[gam-desktop] failed to spawn node sidecar: {err}");
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
            .join("gmail-ai-manager")
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

/// Fire a loopback POST against the local API for tray-driven controls
/// (pause / resume / stop). We shell out to `curl` rather than pulling
/// in an HTTP crate — curl is always present on macOS, the call is
/// best-effort, and a missing API just means the user toggled before
/// the sidecar finished booting (or after it crashed).
fn post_loopback(path: &str) {
    let url = format!("http://127.0.0.1:3001{}", path);
    let _ = Command::new("curl")
        .arg("-fsS")
        .arg("--max-time")
        .arg("3")
        .arg("-X")
        .arg("POST")
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
