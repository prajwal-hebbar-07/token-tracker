//! Oh My Pi command execution and provider quota limits.
//!
//! A direct port of `apps/api/src/omp-cli.ts`. Nothing here throws: every
//! failure becomes a warning so one unavailable command cannot take down the
//! rest of an import. A stale import beats no import.

use std::io::{ErrorKind, Read};
use std::process::{Command, Stdio};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use wait_timeout::ChildExt;

use crate::db::{home_dir, now_millis};
use crate::model::{LimitWindow, LimitsSnapshot, ProviderLimits};

// Hang guard only. Session sync is incremental and usage reports are cached by
// Oh My Pi, so both calls normally return in about a second.
const TIMEOUT_MS: u64 = 600_000;
const OLLAMA_USAGE_URL: &str = "https://ollama.com/api/usage";
const OLLAMA_TIMEOUT_MS: u64 = 10_000;

struct OmpRun {
    stdout: String,
    warning: Option<String>,
}

fn last_line(text: &str) -> Option<String> {
    for line in text.split('\n').rev() {
        let line = line.trim();
        if !line.is_empty() {
            return Some(if line.chars().count() > 300 {
                let truncated: String = line.chars().take(300).collect();
                format!("{truncated}…")
            } else {
                line.to_string()
            });
        }
    }
    None
}

fn omp_binary() -> String {
    match std::env::var("OMP_BIN") {
        Ok(value) if !value.is_empty() => value,
        _ => "omp".to_string(),
    }
}

/// Runs an Oh My Pi subcommand.
///
/// `capture` is off for commands whose stdout is not needed, because a large but
/// successful run would otherwise be buffered for nothing.
fn run_omp(args: &[&str], capture: bool) -> OmpRun {
    let binary = omp_binary();
    let command = format!("{} {}", binary, args.join(" "));

    let mut child = match Command::new(&binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(if capture {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let reason = if error.kind() == ErrorKind::NotFound {
                format!("`{binary}` was not found. Set OMP_BIN to the Oh My Pi binary path.")
            } else {
                format!("`{command}` failed to start: {error}")
            };
            return OmpRun {
                stdout: String::new(),
                warning: Some(reason),
            };
        }
    };

    // Drain both pipes on their own threads. A child that fills a pipe buffer
    // would otherwise block forever while we waited for it to exit.
    let stdout_reader = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });
    let stderr_reader = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });

    let status = match child.wait_timeout(Duration::from_millis(TIMEOUT_MS)) {
        Ok(Some(status)) => status,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            return OmpRun {
                stdout: String::new(),
                warning: Some(format!(
                    "`{command}` did not finish within {}s.",
                    TIMEOUT_MS / 1_000
                )),
            };
        }
        Err(error) => {
            return OmpRun {
                stdout: String::new(),
                warning: Some(format!("`{command}` failed to start: {error}")),
            };
        }
    };

    let stdout = stdout_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let stderr = stderr_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();

    if !status.success() {
        let exit = match status.code() {
            Some(code) => format!("exit code {code}"),
            None => signal_description(&status),
        };
        let detail = last_line(&stderr)
            .map(|detail| format!(": {detail}"))
            .unwrap_or_default();
        return OmpRun {
            stdout,
            warning: Some(format!("`{command}` exited with {exit}{detail}")),
        };
    }

    OmpRun {
        stdout,
        warning: None,
    }
}

#[cfg(unix)]
fn signal_description(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match status.signal() {
        Some(signal) => format!("signal {signal}"),
        None => "an unknown status".to_string(),
    }
}

#[cfg(not(unix))]
fn signal_description(_status: &std::process::ExitStatus) -> String {
    "an unknown status".to_string()
}

/// Runs Oh My Pi's own session-to-stats sync so the import reads current data.
///
/// `~/.omp/stats.db` is not written by running Oh My Pi sessions. It only
/// advances when `omp stats` tails `~/.omp/agent/sessions/` into it, so
/// importing without this step re-reads whatever snapshot the last manual
/// `omp stats` left behind.
pub fn sync_omp_sessions() -> Option<String> {
    let warning = run_omp(&["stats", "--json"], false).warning?;
    Some(format!(
        "{warning}. Imported the existing snapshot, which may be stale."
    ))
}

fn as_record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

fn as_number(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    number.is_finite().then_some(number)
}

fn as_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty()).then(|| text.to_string())
}

fn as_notes(value: Option<&Value>) -> Vec<String> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| as_string(Some(entry)))
        .collect()
}

fn parse_window(value: &Value) -> Option<LimitWindow> {
    let limit = value.as_object()?;
    let amount = as_record(limit.get("amount"));
    let window = as_record(limit.get("window"));
    let id = as_string(limit.get("id"))?;

    Some(LimitWindow {
        label: as_string(limit.get("label"))
            .or_else(|| as_string(window.and_then(|window| window.get("label"))))
            .unwrap_or_else(|| id.clone()),
        unit: as_string(amount.and_then(|amount| amount.get("unit")))
            .unwrap_or_else(|| "count".to_string()),
        status: as_string(limit.get("status")).unwrap_or_else(|| "unknown".to_string()),
        used: as_number(amount.and_then(|amount| amount.get("used"))),
        limit: as_number(amount.and_then(|amount| amount.get("limit"))),
        remaining: as_number(amount.and_then(|amount| amount.get("remaining"))),
        used_fraction: as_number(amount.and_then(|amount| amount.get("usedFraction"))),
        resets_at: as_number(window.and_then(|window| window.get("resetsAt"))),
        id,
    })
}

fn parse_report(value: &Value) -> Option<ProviderLimits> {
    let report = value.as_object()?;
    let provider = as_string(report.get("provider"))?;
    let metadata = as_record(report.get("metadata"));

    let windows = report
        .get("limits")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(parse_window).collect())
        .unwrap_or_default();

    Some(ProviderLimits {
        provider,
        account: as_string(metadata.and_then(|metadata| metadata.get("email")))
            .or_else(|| as_string(metadata.and_then(|metadata| metadata.get("accountId")))),
        plan: as_string(metadata.and_then(|metadata| metadata.get("planType"))),
        fetched_at: as_number(report.get("fetchedAt")),
        windows,
        notes: as_notes(report.get("notes")),
    })
}

fn ollama_api_key() -> Option<String> {
    if let Some(key) = std::env::var("OLLAMA_API_KEY")
        .ok()
        .filter(|key| !key.is_empty())
    {
        return Some(key);
    }

    let database_path = match std::env::var_os("OMP_AGENT_DB") {
        Some(value) if !value.is_empty() => std::path::PathBuf::from(value),
        _ => home_dir().join(".omp").join("agent").join("agent.db"),
    };
    if !database_path.exists() {
        return None;
    }

    // Any failure here means "no key": the credential store belongs to another
    // tool and its shape is not ours to depend on.
    let database = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    let data: String = database
        .query_row(
            r#"
      SELECT data
      FROM auth_credentials
      WHERE provider = 'ollama-cloud' AND disabled_cause IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
            "#,
            [],
            |row| row.get(0),
        )
        .ok()?;
    let credential: Value = serde_json::from_str(&data).ok()?;
    as_string(credential.get("key"))
}

fn parse_ollama_window(id: &str, label: &str, value: Option<&Value>) -> Option<LimitWindow> {
    let usage = as_number(as_record(value)?.get("usage"))?;
    if usage < 0.0 {
        return None;
    }
    let used = usage * 100.0;
    Some(LimitWindow {
        id: format!("ollama-cloud:{id}"),
        label: label.to_string(),
        unit: "percent".to_string(),
        status: "ok".to_string(),
        used: Some(used),
        limit: Some(100.0),
        remaining: Some((100.0 - used).max(0.0)),
        used_fraction: Some(usage),
        resets_at: None,
    })
}

fn parse_ollama_usage(value: &Value) -> Option<ProviderLimits> {
    let limits = as_record(value.as_object()?.get("limits"))?;
    let windows: Vec<LimitWindow> = [
        parse_ollama_window("session", "Session", limits.get("session")),
        parse_ollama_window("weekly", "Weekly", limits.get("weekly")),
    ]
    .into_iter()
    .flatten()
    .collect();
    if windows.is_empty() {
        return None;
    }

    Some(ProviderLimits {
        provider: "ollama-cloud".to_string(),
        account: None,
        plan: None,
        fetched_at: Some(now_millis() as f64),
        windows,
        notes: vec!["Ollama's usage endpoint does not expose reset times.".to_string()],
    })
}

fn read_ollama_cloud_limits() -> (Option<ProviderLimits>, Option<String>) {
    let Some(api_key) = ollama_api_key() else {
        return (None, None);
    };

    // A non-2xx reply is a reportable status, not a transport failure, so the
    // status is kept out of the error channel.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(OLLAMA_TIMEOUT_MS)))
        .http_status_as_error(false)
        .build()
        .into();

    let mut response = match agent
        .get(OLLAMA_USAGE_URL)
        .header("Accept", "application/json")
        .header("Authorization", &api_key)
        .call()
    {
        Ok(response) => response,
        Err(error) => {
            return (
                None,
                Some(format!("Could not read Ollama Cloud usage: {error}.")),
            );
        }
    };

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return (
            None,
            Some(format!("Ollama Cloud usage returned HTTP {status}.")),
        );
    }

    let Ok(body) = response.body_mut().read_to_string() else {
        return (
            None,
            Some("Ollama Cloud usage did not return JSON.".to_string()),
        );
    };
    let Ok(payload) = serde_json::from_str::<Value>(&body) else {
        return (
            None,
            Some("Ollama Cloud usage did not return JSON.".to_string()),
        );
    };

    match parse_ollama_usage(&payload) {
        Some(report) => (Some(report), None),
        None => (
            None,
            Some("Ollama Cloud usage returned an unexpected shape.".to_string()),
        ),
    }
}

/// Reads provider quota limits via Oh My Pi, then fills Ollama Cloud's missing
/// report from Ollama's account usage endpoint.
pub fn read_provider_limits() -> (Option<LimitsSnapshot>, Option<String>) {
    let run = run_omp(&["usage", "--json"], true);
    if let Some(warning) = run.warning {
        return (None, Some(format!("{warning}. Kept the previous limits.")));
    }

    let Ok(payload) = serde_json::from_str::<Value>(&run.stdout) else {
        return (
            None,
            Some("`omp usage --json` did not return JSON. Kept the previous limits.".to_string()),
        );
    };

    let reports = payload
        .as_object()
        .and_then(|root| root.get("reports"))
        .and_then(Value::as_array);
    let Some(reports) = reports else {
        return (
            None,
            Some(
                "`omp usage --json` returned an unexpected shape. Kept the previous limits."
                    .to_string(),
            ),
        );
    };

    let mut providers: Vec<ProviderLimits> = reports.iter().filter_map(parse_report).collect();
    let (ollama_report, warning) = read_ollama_cloud_limits();
    if let Some(report) = ollama_report {
        match providers
            .iter()
            .position(|provider| provider.provider == "ollama-cloud")
        {
            Some(index) => providers[index] = report,
            None => providers.push(report),
        }
    }

    (
        Some(LimitsSnapshot {
            captured_at: now_millis() as f64,
            generated_at: as_number(payload.get("generatedAt")),
            providers,
        }),
        warning,
    )
}
