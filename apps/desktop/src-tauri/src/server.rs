//! The app's own loopback HTTP server.
//!
//! One origin serves both the dashboard bundle and `/api`, which is why the web
//! app needs no changes: its relative `fetch("/api/...")` calls resolve straight
//! back here. The bundle is compiled into the binary, so there is no resource
//! directory to locate and nothing to go missing after install.

use std::path::{Path, PathBuf};

use include_dir::{include_dir, Dir};
use serde::Serialize;
use serde_json::json;
use tiny_http::{Header, Method, Request, Response, Server};

use crate::db::{now_millis, omp_stats_path, Store};
use crate::model::Period;
use crate::omp::{read_provider_limits, sync_omp_sessions};

/// The exported dashboard, embedded at compile time from `apps/web/out`.
static RENDERER: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../web/out");

/// A database that could not be opened must not stop the window from appearing.
/// The bundle still loads and the dashboard reports the reason through its own
/// error banner, which beats an app that silently fails to launch.
enum Backend {
    Ready(Store),
    Failed(String),
}

struct Reply {
    status: u16,
    body: Vec<u8>,
    content_type: &'static str,
    cache_control: &'static str,
}

impl Reply {
    fn json(status: u16, value: &impl Serialize) -> Self {
        let body = serde_json::to_vec(value)
            .unwrap_or_else(|_| br#"{"error":"Could not encode the response"}"#.to_vec());
        Self {
            status,
            body,
            content_type: "application/json; charset=utf-8",
            cache_control: "no-store",
        }
    }

    fn error(status: u16, message: impl AsRef<str>) -> Self {
        Self::json(status, &json!({ "error": message.as_ref() }))
    }
}

fn content_type_for(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/vnd.microsoft.icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("txt") => "text/plain; charset=utf-8",
        Some("map") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Resolves a request path against the embedded export.
///
/// Next writes both `projects.html` and `projects/index.html` depending on the
/// route, so both shapes are tried. A path that names no file and no extension
/// is a client-side route, which the shell page answers.
fn static_reply(path: &str) -> Reply {
    let trimmed = path.trim_start_matches('/');
    // Embedded lookups cannot escape the bundle, but a traversal attempt is
    // still never a legitimate asset request.
    if trimmed.split('/').any(|part| part == "..") {
        return Reply::error(404, "Not found");
    }

    let candidates: Vec<String> = if trimmed.is_empty() {
        vec!["index.html".to_string()]
    } else {
        vec![
            trimmed.to_string(),
            format!("{trimmed}.html"),
            format!("{trimmed}/index.html"),
        ]
    };

    for candidate in &candidates {
        if let Some(file) = RENDERER.get_file(candidate) {
            let immutable = candidate.starts_with("_next/static/");
            return Reply {
                status: 200,
                body: file.contents().to_vec(),
                content_type: content_type_for(candidate),
                cache_control: if immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-store"
                },
            };
        }
    }

    let looks_like_asset = trimmed.starts_with("_next/")
        || trimmed
            .rsplit_once('/')
            .map_or(trimmed, |(_, name)| name)
            .contains('.');
    if !looks_like_asset {
        if let Some(file) = RENDERER.get_file("index.html") {
            return Reply {
                status: 200,
                body: file.contents().to_vec(),
                content_type: "text/html; charset=utf-8",
                cache_control: "no-store",
            };
        }
    }

    if let Some(file) = RENDERER.get_file("404.html") {
        return Reply {
            status: 404,
            body: file.contents().to_vec(),
            content_type: "text/html; charset=utf-8",
            cache_control: "no-store",
        };
    }
    Reply::error(404, "Not found")
}

fn period_from(query: Option<&str>) -> Option<Period> {
    let value = query.and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == "period").then_some(value)
        })
    });
    Period::parse(value)
}

/// Runs the import exactly as the API did: a failed session sync still imports
/// the existing snapshot, and a failed limits read keeps the stored one.
fn import_reply(store: &Store) -> Reply {
    let mut warnings: Vec<String> = Vec::new();
    let sync_warning = sync_omp_sessions();
    if let Some(warning) = &sync_warning {
        warnings.push(warning.clone());
    }

    let result = match store.import_from_omp(&omp_stats_path()) {
        Ok(result) => result,
        Err(error) => {
            return match &sync_warning {
                None => Reply::error(500, error.to_string()),
                Some(warning) => Reply::error(
                    500,
                    format!("{error} (session sync also failed: {warning})"),
                ),
            };
        }
    };

    let (snapshot, warning) = read_provider_limits();
    if let Some(warning) = warning {
        warnings.push(warning);
    }
    if let Some(snapshot) = &snapshot {
        if let Err(error) = store.save_limits_snapshot(snapshot) {
            return Reply::error(500, error.to_string());
        }
    }

    match store.dashboard(Period::All, now_millis()) {
        Ok(dashboard) => Reply::json(
            200,
            &json!({ "result": result, "warnings": warnings, "dashboard": dashboard }),
        ),
        Err(error) => Reply::error(500, error.to_string()),
    }
}

fn api_reply(backend: &Backend, method: &Method, path: &str, query: Option<&str>) -> Reply {
    const BAD_PERIOD: &str = "period must be today, month, or all";

    let store = match backend {
        Backend::Ready(store) => store,
        Backend::Failed(reason) => return Reply::error(500, reason),
    };

    match (method, path) {
        (Method::Get, "/health") => Reply::json(200, &json!({ "ok": true })),
        (Method::Get, "/api/dashboard") => match period_from(query) {
            None => Reply::error(400, BAD_PERIOD),
            Some(period) => match store.dashboard(period, now_millis()) {
                Ok(dashboard) => Reply::json(200, &dashboard),
                Err(error) => Reply::error(500, error.to_string()),
            },
        },
        (Method::Get, "/api/projects") => match period_from(query) {
            None => Reply::error(400, BAD_PERIOD),
            Some(period) => match store.projects(period, now_millis()) {
                Ok(projects) => Reply::json(200, &projects),
                Err(error) => Reply::error(500, error.to_string()),
            },
        },
        (Method::Post, "/api/import") => import_reply(store),
        _ => Reply::error(404, "Not found"),
    }
}

fn reply_for(backend: &Backend, request: &Request) -> Reply {
    let url = request.url().to_string();
    let (path, query) = match url.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (url.as_str(), None),
    };

    if path == "/health" || path.starts_with("/api/") {
        return api_reply(backend, request.method(), path, query);
    }
    if request.method() != &Method::Get && request.method() != &Method::Head {
        return Reply::error(404, "Not found");
    }
    static_reply(path)
}

fn respond(request: Request, reply: Reply) {
    let headers = [
        Header::from_bytes("Content-Type", reply.content_type),
        Header::from_bytes("Cache-Control", reply.cache_control),
    ];
    let mut response = Response::from_data(reply.body).with_status_code(reply.status);
    for header in headers.into_iter().flatten() {
        response = response.with_header(header);
    }
    // A dropped connection is the browser's business, not an app failure.
    let _ = request.respond(response);
}

/// Binds the loopback server and starts serving on a background thread.
///
/// Returns the bound port, which is what the window is pointed at. Port 0 lets
/// the OS pick, so two copies of the app never fight over one number.
pub fn start(tracker_path: &Path, requested_port: u16) -> Result<u16, String> {
    let backend = match Store::open(tracker_path) {
        Ok(store) => Backend::Ready(store),
        Err(error) => Backend::Failed(format!(
            "Could not open the Token Tracker database at {}: {error}",
            tracker_path.display()
        )),
    };

    let server = Server::http(("127.0.0.1", requested_port))
        .map_err(|error| format!("Could not start the local server: {error}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "The local server did not bind a TCP port".to_string())?
        .port();

    std::thread::Builder::new()
        .name("token-tracker-api".to_string())
        .spawn(move || {
            for request in server.incoming_requests() {
                let reply = reply_for(&backend, &request);
                respond(request, reply);
            }
        })
        .map_err(|error| format!("Could not start the local server thread: {error}"))?;

    Ok(port)
}

/// Where the desktop app keeps its own database. `DATA_DIR` still overrides it.
pub fn tracker_database_path(app_data_dir: &Path) -> PathBuf {
    match std::env::var_os("DATA_DIR") {
        Some(value) if !value.is_empty() => PathBuf::from(value).join("token-tracker.sqlite"),
        _ => app_data_dir.join("token-tracker.sqlite"),
    }
}
