//! Cursor dashboard usage: session token, per-request events, and plan limits.
//!
//! A direct port of `apps/api/src/cursor.ts`. Failures become warnings so a
//! missing Cursor install cannot take down an Oh My Pi import.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};

use crate::model::{LimitWindow, ProviderLimits};

const TIMEOUT_MS: u64 = 15_000;
const PAGE_SIZE: u64 = 200;
const MAX_PAGES: u64 = 250;
const DEFAULT_API_BASE: &str = "https://api2.cursor.sh";
const AUTH_FAILURE: &str =
    "Cursor is not signed in, or the stored session has expired. Sign in to Cursor and fetch again, or set CURSOR_API_KEY.";

#[derive(Debug, Clone)]
pub struct CursorEvent {
    pub timestamp: i64,
    pub model: String,
    pub kind: String,
    pub conversation_id: Option<String>,
    pub is_headless: bool,
    pub requests_costs: f64,
    pub charged_cents: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

#[derive(Debug, Clone)]
pub struct CursorConversation {
    pub folder: String,
    pub path: Option<String>,
    pub user_text: Option<String>,
}

struct CursorAuth {
    access_token: String,
    api_key: Option<String>,
    email: Option<String>,
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn now_millis() -> i64 {
    chrono::Local::now().timestamp_millis()
}

fn as_record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

fn as_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty()).then(|| text.to_string())
}

fn as_finite_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|value| value.is_finite()),
        Some(Value::String(text)) if !text.is_empty() => text.parse::<f64>().ok().filter(|value| value.is_finite()),
        _ => None,
    }
}

fn as_count(value: Option<&Value>) -> i64 {
    as_finite_number(value)
        .map(|value| value.round().max(0.0) as i64)
        .unwrap_or(0)
}

pub fn parse_cursor_time(value: Option<&Value>) -> Option<i64> {
    if let Some(number) = as_finite_number(value) {
        return Some(number.round() as i64);
    }
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|instant| instant.timestamp_millis())
}

fn api_base() -> String {
    std::env::var("CURSOR_API_BASE")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_API_BASE.to_string())
}

pub fn cursor_state_database_path() -> PathBuf {
    if let Ok(value) = std::env::var("CURSOR_STATE_DB") {
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }
    let home = home_dir();
    if cfg!(target_os = "macos") {
        return home
            .join("Library")
            .join("Application Support")
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb");
    }
    if cfg!(target_os = "windows") {
        let app_data = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return app_data
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb");
    }
    home.join(".config")
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb")
}

fn cursor_auth_json_path() -> PathBuf {
    match std::env::var("CURSOR_AUTH_JSON") {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => home_dir().join(".cursor").join("auth.json"),
    }
}

fn cursor_projects_root() -> PathBuf {
    match std::env::var("CURSOR_PROJECTS_DIR") {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => home_dir().join(".cursor").join("projects"),
    }
}

fn cursor_workspace_storage_root() -> PathBuf {
    match std::env::var("CURSOR_WORKSPACE_STORAGE") {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => cursor_state_database_path()
            .parent()
            .and_then(Path::parent)
            .map(|path| path.join("workspaceStorage"))
            .unwrap_or_else(|| home_dir().join("workspaceStorage")),
    }
}

fn cursor_looks_installed() -> bool {
    std::env::var("CURSOR_API_KEY")
        .ok()
        .filter(|value| !value.is_empty())
        .is_some()
        || std::env::var("CURSOR_ACCESS_TOKEN")
            .ok()
            .filter(|value| !value.is_empty())
            .is_some()
        || cursor_state_database_path().exists()
        || cursor_auth_json_path().exists()
}

fn read_item_table_value(database: &Connection, key: &str) -> Option<String> {
    let value: String = database
        .query_row("SELECT value FROM ItemTable WHERE key = ?", [key], |row| {
            row.get(0)
        })
        .ok()?;
    let value = value.trim();
    if value.starts_with('"') && value.ends_with('"') {
        if let Ok(Value::String(parsed)) = serde_json::from_str::<Value>(value) {
            return (!parsed.is_empty()).then_some(parsed);
        }
    }
    (!value.is_empty()).then(|| value.to_string())
}

fn open_state_database(path: &Path) -> Option<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()
    .or_else(|| {
        let copy = std::env::temp_dir().join(format!(
            "token-tracker-cursor-state-{}.vscdb",
            std::process::id()
        ));
        fs::copy(path, &copy).ok()?;
        let _ = fs::copy(
            format!("{}-wal", path.display()),
            format!("{}-wal", copy.display()),
        );
        let _ = fs::copy(
            format!("{}-shm", path.display()),
            format!("{}-shm", copy.display()),
        );
        Connection::open_with_flags(
            &copy,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .ok()
    })
}

fn read_state_auth(path: &Path) -> (Option<String>, Option<String>) {
    if !path.exists() {
        return (None, None);
    }
    let Some(database) = open_state_database(path) else {
        return (None, None);
    };
    let access_token = read_item_table_value(&database, "cursorAuth/accessToken")
        .or_else(|| read_item_table_value(&database, "cursorAuth/token"));
    let email = read_item_table_value(&database, "cursorAuth/cachedEmail");
    (access_token, email)
}

fn read_auth_json(path: &Path) -> (Option<String>, Option<String>) {
    if !path.exists() {
        return (None, None);
    }
    let Ok(contents) = fs::read_to_string(path) else {
        return (None, None);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&contents) else {
        return (None, None);
    };
    (
        as_string(parsed.get("accessToken")),
        as_string(parsed.get("apiKey")),
    )
}

fn resolve_cursor_auth() -> Option<CursorAuth> {
    let env_api_key = std::env::var("CURSOR_API_KEY")
        .ok()
        .filter(|value| !value.is_empty());
    let env_token = std::env::var("CURSOR_ACCESS_TOKEN")
        .ok()
        .filter(|value| !value.is_empty());
    let (state_token, email) = read_state_auth(&cursor_state_database_path());
    let (file_token, file_key) = read_auth_json(&cursor_auth_json_path());
    let api_key = env_api_key.or(file_key);
    let access_token = env_token.or(state_token).or(file_token);
    if access_token.is_none() && api_key.is_none() {
        return None;
    }
    Some(CursorAuth {
        access_token: access_token.or_else(|| api_key.clone()).unwrap_or_default(),
        api_key,
        email,
    })
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(TIMEOUT_MS)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn dashboard_post(access_token: &str, path: &str, body: &Value) -> Result<(u16, Value), String> {
    let mut response = http_agent()
        .post(format!("{}{path}", api_base()))
        .header("Accept", "application/json")
        .header("Authorization", &format!("Bearer {access_token}"))
        .header("Connect-Protocol-Version", "1")
        .header("Content-Type", "application/json")
        .send(body.to_string())
        .map_err(|error| format!("Could not read Cursor usage: {error}."))?;
    let status = response.status().as_u16();
    let payload = response
        .body_mut()
        .read_to_string()
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .unwrap_or(Value::Null);
    Ok((status, payload))
}

fn exchange_api_key(api_key: &str) -> Option<String> {
    let (status, payload) = dashboard_post(api_key, "/auth/exchange_user_api_key", &json!({})).ok()?;
    if !(200..300).contains(&status) {
        return None;
    }
    as_string(payload.get("accessToken"))
}

fn with_cursor_token<T>(
    auth: &CursorAuth,
    mut run: impl FnMut(&str) -> Result<(u16, Option<T>), String>,
) -> Result<(Option<T>, Option<String>), String> {
    let mut access_token = auth.access_token.clone();
    if access_token.starts_with("crsr_") {
        access_token = exchange_api_key(&access_token).ok_or_else(|| AUTH_FAILURE.to_string())?;
    }

    let (status, value) = run(&access_token)?;
    if status != 401 && status != 403 {
        return if (200..300).contains(&status) {
            Ok((value, None))
        } else {
            Ok((None, Some(format!("Cursor usage returned HTTP {status}."))))
        };
    }
    let Some(api_key) = &auth.api_key else {
        return Ok((None, Some(AUTH_FAILURE.to_string())));
    };
    let Some(exchanged) = exchange_api_key(api_key) else {
        return Ok((None, Some(AUTH_FAILURE.to_string())));
    };
    let (status, value) = run(&exchanged)?;
    if status == 401 || status == 403 {
        return Ok((None, Some(AUTH_FAILURE.to_string())));
    }
    if (200..300).contains(&status) {
        Ok((value, None))
    } else {
        Ok((None, Some(format!("Cursor usage returned HTTP {status}."))))
    }
}

pub fn parse_cursor_usage_event(value: &Value) -> Option<CursorEvent> {
    let event = value.as_object()?;
    let timestamp = parse_cursor_time(event.get("timestamp"))?;
    let model = as_string(event.get("model"))?;
    let usage = as_record(event.get("tokenUsage"));
    let charged = as_finite_number(event.get("chargedCents"))
        .or_else(|| as_finite_number(usage.and_then(|usage| usage.get("totalCents"))))
        .unwrap_or(0.0);
    Some(CursorEvent {
        timestamp,
        model,
        kind: as_string(event.get("kind")).unwrap_or_else(|| "stop".to_string()),
        conversation_id: as_string(event.get("conversationId")),
        is_headless: event.get("isHeadless").and_then(Value::as_bool) == Some(true),
        requests_costs: as_finite_number(event.get("requestsCosts")).unwrap_or(0.0),
        charged_cents: charged,
        input_tokens: as_count(usage.and_then(|usage| usage.get("inputTokens"))),
        output_tokens: as_count(usage.and_then(|usage| usage.get("outputTokens"))),
        cache_read_tokens: as_count(usage.and_then(|usage| usage.get("cacheReadTokens"))),
        cache_write_tokens: as_count(usage.and_then(|usage| usage.get("cacheWriteTokens"))),
    })
}

fn as_percent(value: Option<f64>) -> Option<f64> {
    value.map(|value| if value <= 1.0 { value * 100.0 } else { value })
}

fn cents_to_usd(value: Option<f64>) -> Option<f64> {
    value.map(|value| value / 100.0)
}

pub fn parse_cursor_limits(
    period_payload: &Value,
    plan_payload: &Value,
    email: Option<String>,
    captured_at: i64,
) -> Option<ProviderLimits> {
    let period = period_payload.as_object()?;
    let plan_usage = as_record(period.get("planUsage"));
    let plan_info = as_record(plan_payload.get("planInfo"));
    let spend_limit = as_record(period.get("spendLimitUsage"));

    let total_spend = cents_to_usd(as_finite_number(
        plan_usage.and_then(|usage| usage.get("totalSpend")),
    ));
    let included_limit = cents_to_usd(as_finite_number(
        plan_usage.and_then(|usage| usage.get("limit")),
    ))
    .or_else(|| {
        cents_to_usd(as_finite_number(
            plan_info.and_then(|info| info.get("includedAmountCents")),
        ))
    });
    let remaining = cents_to_usd(as_finite_number(
        plan_usage.and_then(|usage| usage.get("remaining")),
    ));
    let resets_at = parse_cursor_time(period.get("billingCycleEnd")).or_else(|| {
        parse_cursor_time(plan_info.and_then(|info| info.get("billingCycleEnd")))
    });
    let total_percent = as_percent(as_finite_number(
        plan_usage.and_then(|usage| usage.get("totalPercentUsed")),
    ));

    let mut windows: Vec<LimitWindow> = Vec::new();
    if total_spend.is_some() || included_limit.is_some() {
        let used = total_spend.unwrap_or(0.0);
        let used_fraction = match included_limit {
            Some(limit) if limit > 0.0 => Some(used / limit),
            _ => total_percent.map(|value| value / 100.0),
        };
        windows.push(LimitWindow {
            id: "cursor:included".to_string(),
            label: "Included usage".to_string(),
            unit: "usd".to_string(),
            status: "ok".to_string(),
            used: Some(used),
            limit: included_limit,
            remaining: remaining.or_else(|| included_limit.map(|limit| (limit - used).max(0.0))),
            used_fraction,
            resets_at: resets_at.map(|value| value as f64),
        });
    }

    let pooled_limit = cents_to_usd(as_finite_number(
        spend_limit.and_then(|limit| limit.get("pooledLimit")),
    ));
    let pooled_used = cents_to_usd(as_finite_number(
        spend_limit.and_then(|limit| limit.get("pooledUsed")),
    ));
    if let Some(limit) = pooled_limit.filter(|limit| *limit > 0.0) {
        let used = pooled_used.unwrap_or(0.0);
        windows.push(LimitWindow {
            id: "cursor:spend-limit".to_string(),
            label: "Spend limit".to_string(),
            unit: "usd".to_string(),
            status: "ok".to_string(),
            used: Some(used),
            limit: Some(limit),
            remaining: cents_to_usd(as_finite_number(
                spend_limit.and_then(|limit| limit.get("pooledRemaining")),
            ))
            .or(Some((limit - used).max(0.0))),
            used_fraction: Some(used / limit),
            resets_at: resets_at.map(|value| value as f64),
        });
    }

    if windows.is_empty() {
        return None;
    }

    let mut notes: Vec<String> = Vec::new();
    if let Some(display) = as_string(period.get("displayMessage")) {
        notes.push(display);
    }
    notes.push("Cursor usage is billed on Cursor's cycle, not calendar months.".to_string());

    Some(ProviderLimits {
        provider: "cursor".to_string(),
        account: email,
        plan: as_string(plan_info.and_then(|info| info.get("planName"))),
        fetched_at: Some(captured_at as f64),
        windows,
        notes,
    })
}

pub fn cursor_event_id(event: &CursorEvent) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        event.conversation_id.as_deref().unwrap_or("none"),
        event.timestamp,
        event.model,
        event.input_tokens,
        event.output_tokens,
        event.cache_read_tokens,
        event.cache_write_tokens
    )
}

pub fn cursor_session_file(event: &CursorEvent) -> String {
    match &event.conversation_id {
        Some(conversation_id) => format!("cursor://{conversation_id}"),
        None => "cursor://unattributed".to_string(),
    }
}

fn path_to_cursor_slug(path: &str) -> String {
    path.trim_start_matches(['/', '\\'])
        .replace(['/', '\\'], "-")
}

fn file_url_to_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    Some(rest.replace("%20", " "))
}

fn read_workspace_paths(root: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(entries) = fs::read_dir(root) else {
        return map;
    };
    for entry in entries.flatten() {
        let file = entry.path().join("workspace.json");
        let Ok(contents) = fs::read_to_string(&file) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&contents) else {
            continue;
        };
        let Some(folder) = as_string(parsed.get("folder")) else {
            continue;
        };
        let Some(path) = file_url_to_path(&folder) else {
            continue;
        };
        if !path.is_empty() {
            map.insert(path_to_cursor_slug(&path), path);
        }
    }
    map
}

fn extract_cursor_user_text(value: &Value) -> Option<String> {
    let entry = value.as_object()?;
    if as_string(entry.get("role")).as_deref() != Some("user") {
        return None;
    }
    let message = entry.get("message").unwrap_or(value);
    let record = message.as_object()?;
    match record.get("content") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(items)) => {
            let mut text: Vec<String> = Vec::new();
            for item in items {
                let Some(block) = item.as_object() else {
                    continue;
                };
                if as_string(block.get("type")).as_deref() != Some("text") {
                    continue;
                }
                if let Some(value) = as_string(block.get("text")) {
                    text.push(value);
                }
            }
            if text.is_empty() {
                None
            } else {
                Some(text.join("\n"))
            }
        }
        _ => None,
    }
}

fn read_transcript_user_text(path: &Path) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    for line in contents.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(text) = extract_cursor_user_text(&parsed) {
            return Some(text);
        }
    }
    None
}

pub fn index_cursor_conversations() -> HashMap<String, CursorConversation> {
    index_cursor_conversations_at(&cursor_projects_root(), &cursor_workspace_storage_root())
}

pub fn index_cursor_conversations_at(
    projects_root: &Path,
    workspace_storage_root: &Path,
) -> HashMap<String, CursorConversation> {
    let mut conversations = HashMap::new();
    let paths = read_workspace_paths(workspace_storage_root);
    let Ok(projects) = fs::read_dir(projects_root) else {
        return conversations;
    };
    for project in projects.flatten() {
        let folder = project.file_name().to_string_lossy().into_owned();
        let transcripts_root = project.path().join("agent-transcripts");
        let Ok(transcripts) = fs::read_dir(&transcripts_root) else {
            continue;
        };
        let path = paths.get(&folder).cloned();
        for transcript in transcripts.flatten() {
            let conversation_id = transcript.file_name().to_string_lossy().into_owned();
            let directory = transcript.path();
            let preferred = directory.join(format!("{conversation_id}.jsonl"));
            let mut user_text = read_transcript_user_text(&preferred);
            if user_text.is_none() {
                if let Ok(files) = fs::read_dir(&directory) {
                    for file in files.flatten() {
                        if file
                            .path()
                            .extension()
                            .and_then(|value| value.to_str())
                            != Some("jsonl")
                        {
                            continue;
                        }
                        user_text = read_transcript_user_text(&file.path());
                        if user_text.is_some() {
                            break;
                        }
                    }
                }
            }
            conversations.insert(
                conversation_id,
                CursorConversation {
                    folder: folder.clone(),
                    path: path.clone(),
                    user_text,
                },
            );
        }
    }
    conversations
}

pub fn fetch_cursor_usage_events(since_timestamp: Option<i64>) -> (Vec<CursorEvent>, Option<String>) {
    if !cursor_looks_installed() {
        return (Vec::new(), None);
    }
    let Some(auth) = resolve_cursor_auth() else {
        return (Vec::new(), Some(AUTH_FAILURE.to_string()));
    };

    let fetched = with_cursor_token(&auth, |access_token| {
        let mut events: Vec<CursorEvent> = Vec::new();
        let mut truncated = false;
        for page in 1..=MAX_PAGES {
            let mut body = json!({ "page": page, "pageSize": PAGE_SIZE });
            if let Some(start) = since_timestamp {
                body["startDate"] = json!(start.to_string());
            }
            let (status, payload) = dashboard_post(
                access_token,
                "/aiserver.v1.DashboardService/GetFilteredUsageEvents",
                &body,
            )?;
            if !(200..300).contains(&status) {
                return Ok((status, None));
            }
            let rows = payload
                .get("usageEventsDisplay")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let row_count = rows.len();
            for row in &rows {
                if let Some(event) = parse_cursor_usage_event(row) {
                    events.push(event);
                }
            }
            if (row_count as u64) < PAGE_SIZE {
                return Ok((200, Some((events, false))));
            }
            let total = as_count(payload.get("totalUsageEventsCount"));
            if total > 0 && events.len() as i64 >= total {
                return Ok((200, Some((events, false))));
            }
            if page == MAX_PAGES {
                truncated = true;
            }
        }
        Ok((200, Some((events, truncated))))
    });

    match fetched {
        Ok((Some((events, truncated)), warning)) => {
            let warning = if truncated {
                Some("Imported the most recent Cursor events; older history was skipped.".to_string())
            } else {
                warning
            };
            (events, warning)
        }
        Ok((None, warning)) => (Vec::new(), warning),
        Err(error) => (Vec::new(), Some(error)),
    }
}

pub fn fetch_cursor_limits() -> (Option<ProviderLimits>, Option<String>) {
    if !cursor_looks_installed() {
        return (None, None);
    }
    let Some(auth) = resolve_cursor_auth() else {
        return (None, Some(AUTH_FAILURE.to_string()));
    };

    let fetched = with_cursor_token(&auth, |access_token| {
        let (status, period) = dashboard_post(
            access_token,
            "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
            &json!({}),
        )?;
        if !(200..300).contains(&status) {
            return Ok((status, None));
        }
        let (plan_status, plan) = dashboard_post(
            access_token,
            "/aiserver.v1.DashboardService/GetPlanInfo",
            &json!({}),
        )?;
        let plan = if (200..300).contains(&plan_status) {
            plan
        } else {
            json!({})
        };
        Ok((
            200,
            parse_cursor_limits(&period, &plan, auth.email.clone(), now_millis()),
        ))
    });

    match fetched {
        Ok((value, warning)) => {
            let warning = warning.or_else(|| {
                value
                    .is_none()
                    .then(|| "Cursor usage returned an unexpected shape.".to_string())
            });
            (value, warning)
        }
        Err(error) => (None, Some(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_from_numbers_or_strings() {
        let event = parse_cursor_usage_event(&json!({
            "timestamp": "1700000000000",
            "model": "composer-2.5",
            "kind": "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
            "conversationId": "abc-123",
            "isHeadless": false,
            "requestsCosts": 0.9,
            "chargedCents": 12.5,
            "tokenUsage": {
                "inputTokens": "10",
                "outputTokens": 20,
                "cacheReadTokens": "100",
                "cacheWriteTokens": 0,
                "totalCents": 12.5
            }
        }))
        .expect("event");
        assert_eq!(event.timestamp, 1_700_000_000_000);
        assert_eq!(event.model, "composer-2.5");
        assert_eq!(event.input_tokens, 10);
        assert_eq!(event.output_tokens, 20);
        assert_eq!(event.cache_read_tokens, 100);
        assert_eq!(cursor_session_file(&event), "cursor://abc-123");
        assert_eq!(
            cursor_event_id(&event),
            "abc-123:1700000000000:composer-2.5:10:20:100:0"
        );
    }

    #[test]
    fn parses_plan_usage_into_limits() {
        let report = parse_cursor_limits(
            &json!({
                "billingCycleEnd": "1700310000000",
                "displayMessage": "You've used 40% of your included usage",
                "planUsage": { "totalSpend": 2800, "limit": 7000, "remaining": 4200, "totalPercentUsed": 40 },
                "spendLimitUsage": { "pooledLimit": 5000, "pooledUsed": 1000, "pooledRemaining": 4000 }
            }),
            &json!({ "planInfo": { "planName": "Pro+", "includedAmountCents": 7000 } }),
            Some("dev@example.com".to_string()),
            1_700_300_300_000,
        )
        .expect("report");
        assert_eq!(report.provider, "cursor");
        assert_eq!(report.windows[0].used, Some(28.0));
        assert_eq!(report.windows[0].limit, Some(70.0));
        assert_eq!(report.windows[1].id, "cursor:spend-limit");
    }

    #[test]
    fn treats_percent_used_at_or_below_one_as_a_fraction() {
        let report = parse_cursor_limits(
            &json!({ "planUsage": { "totalSpend": 100, "limit": 200, "totalPercentUsed": 0.5 } }),
            &json!({}),
            None,
            1,
        )
        .expect("report");
        assert_eq!(report.windows[0].used_fraction, Some(0.5));
    }
}
