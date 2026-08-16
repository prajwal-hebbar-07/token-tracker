//! End-to-end checks against the app's own loopback server.
//!
//! This exercises the exact path the window uses — same origin for the embedded
//! dashboard and for `/api` — without opening a window, which is the part that
//! cannot be verified headlessly.
//!
//! `POST /api/import` is deliberately not exercised here: it shells out to `omp`
//! and reads the real `~/.omp/stats.db`. The import logic is covered against the
//! TypeScript original in `parity.rs`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use token_tracker_desktop::server;

struct Client {
    agent: ureq::Agent,
    base: String,
}

impl Client {
    fn get(&self, path: &str) -> (u16, String, String) {
        let mut response = self
            .agent
            .get(format!("{}{path}", self.base))
            .call()
            .unwrap_or_else(|error| panic!("GET {path} failed: {error}"));
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let body = response
            .body_mut()
            .read_to_string()
            .unwrap_or_else(|error| panic!("GET {path} body failed: {error}"));
        (status, content_type, body)
    }

    fn json(&self, path: &str) -> (u16, Value) {
        let (status, content_type, body) = self.get(path);
        assert!(
            content_type.starts_with("application/json"),
            "GET {path} answered {content_type} instead of JSON"
        );
        let value = serde_json::from_str(&body)
            .unwrap_or_else(|error| panic!("GET {path} was not JSON: {error}: {body}"));
        (status, value)
    }
}

#[test]
fn serves_the_dashboard_and_the_api_from_one_origin() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the epoch")
        .as_millis();
    let directory = std::env::temp_dir().join(format!("token-tracker-server-{stamp}"));
    std::fs::create_dir_all(&directory).expect("could not create the database directory");
    let tracker_path = directory.join("tracker.sqlite");

    let port = server::start(&tracker_path, 0).expect("the local server did not start");
    assert_ne!(port, 0, "port 0 should have been replaced by a real port");

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .into();
    let client = Client {
        agent,
        base: format!("http://127.0.0.1:{port}"),
    };

    // The dashboard bundle is compiled into the binary, so this proves the
    // embedded export is present and reachable, not merely that a route exists.
    let (status, content_type, body) = client.get("/");
    assert_eq!(status, 200, "the dashboard shell did not load");
    assert!(
        content_type.starts_with("text/html"),
        "the shell answered {content_type}"
    );
    assert!(
        body.contains("<!DOCTYPE html") || body.contains("<!doctype html"),
        "the shell was not an HTML document"
    );
    assert!(
        body.contains("/_next/static/"),
        "the shell did not reference the exported assets"
    );

    // Next writes `projects.html`, so the second page must resolve without the
    // client router having booted yet.
    let (status, content_type, _) = client.get("/projects");
    assert_eq!(status, 200, "the projects page did not load");
    assert!(
        content_type.starts_with("text/html"),
        "the projects page answered {content_type}"
    );

    let (status, health) = client.json("/health");
    assert_eq!(status, 200);
    assert_eq!(health, serde_json::json!({ "ok": true }));

    // An empty database still has to answer with the full shape the UI reads.
    let (status, dashboard) = client.json("/api/dashboard");
    assert_eq!(status, 200, "the dashboard route failed: {dashboard}");
    assert_eq!(dashboard["summary"]["messageCount"], Value::from(0));
    assert_eq!(dashboard["summary"]["cost"], Value::from(0.0));
    assert_eq!(dashboard["models"], Value::Array(Vec::new()));
    assert_eq!(dashboard["lastSync"], Value::Null);
    assert_eq!(dashboard["limits"], Value::Null);

    for period in ["today", "month", "all"] {
        let (status, report) = client.json(&format!("/api/projects?period={period}"));
        assert_eq!(status, 200, "the projects route failed for {period}");
        assert_eq!(report["period"], Value::from(period));
        assert_eq!(report["totals"]["projectCount"], Value::from(0));
    }

    let (status, rejected) = client.json("/api/dashboard?period=quarter");
    assert_eq!(status, 400, "an unknown period should be rejected");
    assert_eq!(
        rejected["error"],
        Value::from("period must be today, month, or all")
    );

    // Unknown API paths must stay JSON: the client parses every response body
    // before it looks at the status.
    let (status, missing) = client.json("/api/nope");
    assert_eq!(status, 404);
    assert_eq!(missing["error"], Value::from("Not found"));

    let (status, _, _) = client.get("/_next/static/does-not-exist.js");
    assert_eq!(
        status, 404,
        "a missing asset must not fall back to the shell"
    );

    std::fs::remove_dir_all(&directory).ok();
}
