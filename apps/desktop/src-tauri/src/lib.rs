//! Token Tracker desktop application.
//!
//! The app owns its own backend: it binds a loopback HTTP server, serves the
//! dashboard bundle compiled into this binary, answers `/api` from the same
//! origin, and then opens a window on that address. Nothing else has to be
//! started, and no port has to be free in advance.

pub mod db;
pub mod model;
pub mod omp;
pub mod server;
pub mod session;

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use wait_timeout::ChildExt;

/// How long the login shell gets to report its `PATH` before we fall back to the
/// well-known locations. A slow shell profile must not delay the window.
const SHELL_PATH_TIMEOUT: Duration = Duration::from_millis(3_000);

/// Reads `PATH` the way the user's terminal would see it.
///
/// An app launched from Finder or the Dock inherits launchd's minimal `PATH`,
/// which excludes Homebrew, `~/.local/bin`, and every version-manager shim.
/// Oh My Pi is looked up by bare name, so without this the import would always
/// report that `omp` is missing on an otherwise working machine.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    if shell.is_empty() {
        return None;
    }

    let mut child = Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let reader = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    })?;

    match child.wait_timeout(SHELL_PATH_TIMEOUT) {
        Ok(Some(status)) if status.success() => {}
        Ok(Some(_)) => return None,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        Err(_) => return None,
    }

    let path = reader.join().ok()?;
    // An interactive profile can print banners, so only the last line is PATH.
    let path = path.lines().last().unwrap_or_default().trim().to_string();
    (!path.is_empty()).then_some(path)
}

fn repair_path() {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = login_shell_path() {
        candidates.extend(std::env::split_paths(&path));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path));
    }
    // Backstop for a shell that reported nothing useful.
    let home = db::home_dir();
    candidates.push(PathBuf::from("/opt/homebrew/bin"));
    candidates.push(PathBuf::from("/usr/local/bin"));
    for suffix in [".local/bin", ".bun/bin", ".cargo/bin", "go/bin"] {
        candidates.push(home.join(suffix));
    }

    let mut seen: HashSet<PathBuf> = HashSet::new();
    let entries: Vec<PathBuf> = candidates
        .into_iter()
        .filter(|entry| !entry.as_os_str().is_empty())
        .filter(|entry| seen.insert(entry.clone()))
        .collect();

    if let Ok(joined) = std::env::join_paths(entries) {
        std::env::set_var("PATH", joined);
    }
}

/// `0` lets the OS pick an unused port, which is the default so two copies of
/// the app never contend for one number.
fn requested_port() -> u16 {
    std::env::var("TOKEN_TRACKER_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or(0)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            repair_path();

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let tracker_path = server::tracker_database_path(&data_dir);

            let port = server::start(&tracker_path, requested_port())
                .map_err(|message| -> Box<dyn std::error::Error> { message.into() })?;
            let url: tauri::Url = format!("http://127.0.0.1:{port}/").parse()?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Token Tracker")
                .inner_size(1440.0, 960.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Token Tracker failed to start");
}
