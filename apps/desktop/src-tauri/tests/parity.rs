//! Differential test: the Rust port against the TypeScript original.
//!
//! `apps/api/tests/parity-dump.ts` builds a fixture Oh My Pi database, imports it
//! with the original implementation, and prints the dashboard and projects
//! reports. This test imports the very same fixture with the port and compares
//! the two outputs field by field.
//!
//! Money and token arithmetic is what this project exists to report, so a silent
//! divergence is the worst failure available. Comparing whole reports catches it
//! without anyone having to keep expected numbers up to date by hand.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Local};
use serde_json::Value;
use token_tracker_desktop::db::Store;
use token_tracker_desktop::model::{LimitsSnapshot, Period};

/// Identical to the snapshot the reference generator stores, so the JSON round
/// trip and the camelCase field names are compared too.
const SNAPSHOT_JSON: &str = r#"{
  "capturedAt": 1700300300000,
  "generatedAt": 1700300299000,
  "providers": [
    {
      "provider": "ollama-cloud",
      "account": null,
      "plan": null,
      "fetchedAt": 1700300298000,
      "windows": [
        {
          "id": "ollama-cloud:session",
          "label": "Session",
          "unit": "percent",
          "status": "ok",
          "used": 42.5,
          "limit": 100,
          "remaining": 57.5,
          "usedFraction": 0.425,
          "resetsAt": null
        }
      ],
      "notes": ["Ollama's usage endpoint does not expose reset times."]
    },
    {
      "provider": "anthropic",
      "account": "dev@example.com",
      "plan": "max",
      "fetchedAt": 1700300297000,
      "windows": [
        {
          "id": "anthropic:five-hour",
          "label": "5 hour",
          "unit": "count",
          "status": "ok",
          "used": 120,
          "limit": 900,
          "remaining": 780,
          "usedFraction": 0.1333,
          "resetsAt": 1700310000000
        }
      ],
      "notes": []
    }
  ]
}"#;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("could not resolve the repository root")
}

fn compare(path: &str, expected: &Value, actual: &Value, diffs: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys: Vec<&String> = left.keys().chain(right.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                match (left.get(key), right.get(key)) {
                    (Some(left), Some(right)) => {
                        compare(&format!("{path}.{key}"), left, right, diffs);
                    }
                    (None, Some(value)) => {
                        diffs.push(format!("{path}.{key}: only the port produced it ({value})"));
                    }
                    (Some(value), None) => {
                        diffs.push(format!("{path}.{key}: the port is missing it ({value})"));
                    }
                    (None, None) => {}
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                diffs.push(format!(
                    "{path}: {} entries in the reference, {} in the port",
                    left.len(),
                    right.len()
                ));
                return;
            }
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                compare(&format!("{path}[{index}]"), left, right, diffs);
            }
        }
        (Value::Number(left), Value::Number(right)) => {
            let left = left.as_f64().unwrap_or(f64::NAN);
            let right = right.as_f64().unwrap_or(f64::NAN);
            // Both sides do the same f64 arithmetic, but they run against two
            // different SQLite builds, so an ulp of slack is fair.
            let tolerance = (left.abs() * 1e-9).max(1e-9);
            if (left - right).abs() > tolerance {
                diffs.push(format!("{path}: reference {left}, port {right}"));
            }
        }
        _ => {
            if expected != actual {
                diffs.push(format!("{path}: reference {expected}, port {actual}"));
            }
        }
    }
}

#[test]
fn port_matches_the_typescript_reference() {
    let root = repo_root();
    let tsx = root.join("apps/api/node_modules/.bin/tsx");
    assert!(
        tsx.exists(),
        "the reference generator needs apps/api dependencies installed; run pnpm install"
    );

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the epoch")
        .as_millis() as i64;
    let directory = std::env::temp_dir().join(format!("token-tracker-parity-{now}"));
    std::fs::create_dir_all(&directory).expect("could not create the fixture directory");

    let reference = Command::new(&tsx)
        .arg(root.join("apps/api/tests/parity-dump.ts"))
        .arg(&directory)
        .arg(now.to_string())
        .current_dir(root.join("apps/api"))
        .output()
        .expect("could not run the TypeScript reference generator");
    assert!(
        reference.status.success(),
        "the reference generator failed: {}",
        String::from_utf8_lossy(&reference.stderr)
    );
    let mut expected: Value = serde_json::from_slice(&reference.stdout)
        .expect("the reference generator did not print JSON");

    let store = Store::open(&directory.join("tracker-rs.sqlite"))
        .expect("could not open the port's tracker database");
    store
        .import_from_omp(&directory.join("omp.sqlite"))
        .expect("the port could not import the fixture");
    let snapshot: LimitsSnapshot =
        serde_json::from_str(SNAPSHOT_JSON).expect("the fixture snapshot is not valid");
    store
        .save_limits_snapshot(&snapshot)
        .expect("the port could not store the limits snapshot");

    // Both day periods are derived from the same clock the reference generator
    // was handed, so the two sides name identical local calendar dates.
    let local_day = |millis: i64| {
        Period::Day(
            DateTime::from_timestamp_millis(millis)
                .expect("the fixture clock is out of range")
                .with_timezone(&Local)
                .date_naive(),
        )
    };
    let periods = [
        ("today", Period::Today),
        ("month", Period::Month),
        ("all", Period::All),
        ("day", local_day(now)),
        ("pastDay", local_day(now - 40 * 86_400_000)),
    ];

    let mut actual = serde_json::json!({ "dashboard": {}, "models": {}, "projects": {} });
    for (name, period) in periods {
        actual["dashboard"][name] = serde_json::to_value(
            store
                .dashboard(period, now)
                .expect("the port could not build the dashboard"),
        )
        .expect("the dashboard did not serialise");
        actual["models"][name] = serde_json::to_value(
            store
                .models(period, now)
                .expect("the port could not build the models report"),
        )
        .expect("the models report did not serialise");
        actual["projects"][name] = serde_json::to_value(
            store
                .projects(period, now)
                .expect("the port could not build the projects report"),
        )
        .expect("the projects report did not serialise");
    }

    // Each side recorded its own import wall-clock time, so that one field is
    // expected to differ and is neutralised rather than compared.
    for (name, _) in periods {
        expected["dashboard"][name]["lastSync"]["completedAt"] = Value::from(0);
        actual["dashboard"][name]["lastSync"]["completedAt"] = Value::from(0);
    }

    let mut diffs: Vec<String> = Vec::new();
    compare("", &expected, &actual, &mut diffs);
    std::fs::remove_dir_all(&directory).ok();

    assert!(
        diffs.is_empty(),
        "the port diverged from the TypeScript reference in {} place(s):\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}
