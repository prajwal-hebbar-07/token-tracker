//! Tracker database: schema, import from Oh My Pi, and the dashboard queries.
//!
//! This is a direct port of `apps/api/src/db.ts`. The SQL is carried over
//! verbatim so aggregates cannot drift, and the pricing constants and the
//! period boundaries keep the original semantics, including local-time day and
//! month edges and the null-rather-than-zero blended price.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Days, Local, LocalResult, Months, NaiveDate, TimeZone};
use regex::Regex;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags};

use crate::model::{
    CategorySpend, Dashboard, ImportResult, LastSync, LimitsSnapshot, ModelSpend, Period,
    Preferences, Project, ProjectModel, ProjectModelTotal, ProjectTotals, ProjectsReport, Summary,
};
use crate::session::{classify_entry, read_session_file, SessionFile, DEFAULT_CATEGORY};

/// Published pay-as-you-go rates for models a provider hands out for free, so a
/// zero-cost row still shows what it would have cost. Ollama Cloud reports no
/// cache hits, so every prompt token is billed at the cache-miss rate.
struct EstimatedPrice {
    input_per_million: f64,
    output_per_million: f64,
    cache_read_per_million: f64,
    /// MiniMax doubles every rate once a prompt crosses this many tokens.
    /// Moonshot publishes one flat rate for Kimi, so there is no tier to cross.
    tier_limit: Option<i64>,
}

// MiniMax M3 rates published 2026-08-15:
// https://platform.minimax.io/docs/guides/pricing-paygo
// Kimi K2.6 rates published 2026-08-19:
// https://platform.kimi.ai/docs/pricing/chat-k26
const ESTIMATED_PRICES: &[(&str, EstimatedPrice)] = &[
    (
        "minimax-m3",
        EstimatedPrice {
            input_per_million: 0.3,
            output_per_million: 1.2,
            cache_read_per_million: 0.06,
            tier_limit: Some(512_000),
        },
    ),
    (
        "kimi-k2.6",
        EstimatedPrice {
            input_per_million: 0.95,
            output_per_million: 4.0,
            cache_read_per_million: 0.16,
            tier_limit: None,
        },
    ),
];

fn estimated_price(model: &str) -> Option<&'static EstimatedPrice> {
    let model = model.to_lowercase();
    ESTIMATED_PRICES
        .iter()
        .find(|(name, _)| *name == model)
        .map(|(_, price)| price)
}

const USAGE_COLUMNS: &str = "
  session_file, entry_id, folder, model, provider, api, timestamp, duration,
  ttft, stop_reason, error_message, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
  cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
  agent_type, cost_no_cache_input
";

/// Preference row holding the quota keys the panel is hiding.
const HIDDEN_LIMITS_KEY: &str = "hiddenLimits";

// The macOS per-user temp root, matched by shape. std::env::temp_dir() only
// reports the value of TMPDIR in this process, so an app launched without it
// would otherwise stop recognising /var/folders/<x>/<y>/T as scratch space.
static MACOS_TEMP_ROOT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/(?:private/)?var/folders/[^/]+/[^/]+/T(?:/|$)").unwrap());

#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Oh My Pi's own stats database. `OMP_STATS_DB` still overrides it so the
/// desktop app can be pointed at a copy.
pub fn omp_stats_path() -> PathBuf {
    match std::env::var_os("OMP_STATS_DB") {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => home_dir().join(".omp").join("stats.db"),
    }
}

// ---------------------------------------------------------------------------
// Loose value reading
//
// The source database is written by another tool and SQLite does not enforce
// column affinity, so a token count can arrive as REAL and a cost as INTEGER.
// The original ran through JavaScript's Number(), which accepted both. These
// helpers keep that tolerance instead of failing the whole import on one row.
// ---------------------------------------------------------------------------

fn loose_f64(value: ValueRef<'_>) -> f64 {
    match value {
        ValueRef::Integer(number) => number as f64,
        ValueRef::Real(number) => number,
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .ok()
            .and_then(|text| text.trim().parse::<f64>().ok())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

fn loose_i64(value: ValueRef<'_>) -> i64 {
    match value {
        ValueRef::Integer(number) => number,
        other => loose_f64(other) as i64,
    }
}

fn loose_opt_f64(value: ValueRef<'_>) -> Option<f64> {
    match value {
        ValueRef::Null => None,
        other => Some(loose_f64(other)),
    }
}

fn loose_opt_i64(value: ValueRef<'_>) -> Option<i64> {
    match value {
        ValueRef::Null => None,
        other => Some(loose_i64(other)),
    }
}

fn loose_text(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Integer(number) => number.to_string(),
        ValueRef::Real(number) => number.to_string(),
        _ => String::new(),
    }
}

fn loose_opt_text(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Null => None,
        other => Some(loose_text(other)),
    }
}

/// Blended rate actually paid. Zero tokens has no rate, and reporting 0 there
/// would read as free rather than unknown.
fn price_per_million(cost: f64, tokens: i64) -> Option<f64> {
    if tokens == 0 {
        None
    } else {
        Some((cost / tokens as f64) * 1_000_000.0)
    }
}

fn local_midnight(date: NaiveDate) -> i64 {
    // A spring-forward transition can delete local midnight. The original
    // relied on Date#setHours, which lands on the next existing instant.
    for hour in 0..=3 {
        let Some(naive) = date.and_hms_opt(hour, 0, 0) else {
            continue;
        };
        match Local.from_local_datetime(&naive) {
            LocalResult::Single(instant) => return instant.timestamp_millis(),
            LocalResult::Ambiguous(earliest, _) => return earliest.timestamp_millis(),
            LocalResult::None => continue,
        }
    }
    0
}

/// Half-open period bounds in local time, matching the original's use of
/// Date#setHours and Date#setMonth rather than UTC arithmetic.
fn usage_range(period: Period, now: i64) -> (&'static str, Vec<i64>) {
    if period == Period::All {
        return ("", Vec::new());
    }

    let Some(instant) = DateTime::from_timestamp_millis(now) else {
        return ("", Vec::new());
    };
    let today = instant.with_timezone(&Local).date_naive();

    let (start_date, end_date) = match period {
        Period::Today => (today, today.checked_add_days(Days::new(1))),
        Period::Month => {
            let first = today.with_day(1).unwrap_or(today);
            (first, first.checked_add_months(Months::new(1)))
        }
        Period::All => unreachable!("handled above"),
    };
    let Some(end_date) = end_date else {
        return ("", Vec::new());
    };

    (
        "WHERE timestamp >= ? AND timestamp < ?",
        vec![local_midnight(start_date), local_midnight(end_date)],
    )
}

// Oh My Pi records the working directory twice: as a slug where both "/" and
// "-" became "-", and verbatim in the session header. Prefer the real path,
// trimmed to the part below the home directory, because the slug alone cannot
// say where one directory ended and the next began.
fn project_name(folder: &str, path: Option<&str>) -> String {
    if let Some(path) = path {
        let home = home_dir();
        let home = home.to_string_lossy();
        let relative = if path == home {
            String::new()
        } else if let Some(rest) = path.strip_prefix(&format!("{home}/")) {
            rest.to_string()
        } else {
            path.trim_start_matches('/').to_string()
        };
        if !relative.is_empty() {
            return relative;
        }
    }

    let trimmed = folder
        .trim_start_matches(['-', '/'])
        .trim_end_matches('/')
        .to_string();
    if trimmed.is_empty() {
        "(no workspace)".to_string()
    } else {
        trimmed
    }
}

// Smoke tests and probes run in the system temp directory, and a session
// started from the home directory never entered a workspace at all. Neither is
// a project, so they stay out of the rollup instead of padding it with noise.
fn is_project(folder: &str, path: Option<&str>) -> bool {
    let Some(path) = path else {
        let trimmed = folder.trim_start_matches(['-', '/']).trim_end_matches('/');
        return !trimmed.is_empty() && trimmed != "tmp" && !trimmed.starts_with("tmp-");
    };

    if Path::new(path) == home_dir() || MACOS_TEMP_ROOT.is_match(path) {
        return false;
    }
    let temp_dir = std::env::temp_dir();
    let roots = [
        temp_dir.to_string_lossy().into_owned(),
        "/tmp".to_string(),
        "/private/tmp".to_string(),
        "/var/tmp".to_string(),
    ];
    !roots
        .iter()
        .any(|root| path == root.as_str() || path.starts_with(&format!("{root}/")))
}

struct SourceRow {
    session_file: String,
    entry_id: String,
    folder: String,
    model: String,
    provider: String,
    api: String,
    timestamp: i64,
    duration: Option<f64>,
    ttft: Option<f64>,
    stop_reason: String,
    error_message: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    total_tokens: i64,
    premium_requests: f64,
    cost_input: f64,
    cost_output: f64,
    cost_cache_read: f64,
    cost_cache_write: f64,
    cost_total: f64,
    agent_type: String,
    cost_no_cache_input: Option<f64>,
    category: String,
    project_path: Option<String>,
}

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(file_path: &Path) -> Result<Self> {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(file_path)?;
        connection.execute_batch(
            r#"
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS usage_messages (
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      api TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration REAL,
      ttft REAL,
      stop_reason TEXT NOT NULL,
      error_message TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      premium_requests REAL NOT NULL,
      cost_input REAL NOT NULL,
      cost_output REAL NOT NULL,
      cost_cache_read REAL NOT NULL,
      cost_cache_write REAL NOT NULL,
      cost_total REAL NOT NULL,
      agent_type TEXT NOT NULL,
      cost_no_cache_input REAL,
      category TEXT NOT NULL,
      project_path TEXT,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (session_file, entry_id)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS usage_timestamp_idx ON usage_messages(timestamp);
    CREATE INDEX IF NOT EXISTS usage_model_idx ON usage_messages(model, provider);
    CREATE INDEX IF NOT EXISTS usage_folder_idx ON usage_messages(folder);
    CREATE INDEX IF NOT EXISTS usage_agent_idx ON usage_messages(agent_type);

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      source_records INTEGER NOT NULL,
      new_records INTEGER NOT NULL,
      total_records INTEGER NOT NULL
    );

    -- Provider quota limits are a single point-in-time reading, so the newest
    -- one replaces the previous row instead of accumulating history.
    CREATE TABLE IF NOT EXISTS limit_snapshots (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      captured_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );

    -- Interface choices that must outlive the window. The loopback port is
    -- ephemeral, so the webview origin changes on every launch and its own
    -- localStorage is a different bucket each time; only this file survives.
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
            "#,
        )?;

        let mut columns: Vec<String> = Vec::new();
        {
            let mut statement = connection.prepare("PRAGMA table_info(usage_messages)")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                columns.push(loose_text(row.get_ref(1)?));
            }
        }
        if !columns.iter().any(|column| column == "category") {
            connection.execute_batch(
                "ALTER TABLE usage_messages ADD COLUMN category TEXT NOT NULL DEFAULT 'Logic & planning'",
            )?;
        }
        if !columns.iter().any(|column| column == "project_path") {
            connection.execute_batch("ALTER TABLE usage_messages ADD COLUMN project_path TEXT")?;
        }
        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS usage_category_idx ON usage_messages(category)",
        )?;

        Ok(Self { connection })
    }

    fn count_usage_messages(&self) -> Result<i64> {
        let mut statement = self
            .connection
            .prepare("SELECT COUNT(*) AS count FROM usage_messages")?;
        let mut rows = statement.query([])?;
        let Some(row) = rows.next()? else {
            return Err(Error::new("Could not count saved usage records"));
        };
        Ok(loose_i64(row.get_ref(0)?))
    }

    fn read_source_rows(&self, source_path: &Path) -> Result<Vec<SourceRow>> {
        let source = Connection::open_with_flags(
            source_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;
        let mut statement =
            source.prepare(&format!("SELECT {USAGE_COLUMNS} FROM messages ORDER BY id"))?;
        let mut rows = statement.query([])?;

        let mut source_rows: Vec<SourceRow> = Vec::new();
        while let Some(row) = rows.next()? {
            source_rows.push(SourceRow {
                session_file: loose_text(row.get_ref(0)?),
                entry_id: loose_text(row.get_ref(1)?),
                folder: loose_text(row.get_ref(2)?),
                model: loose_text(row.get_ref(3)?),
                provider: loose_text(row.get_ref(4)?),
                api: loose_text(row.get_ref(5)?),
                timestamp: loose_i64(row.get_ref(6)?),
                duration: loose_opt_f64(row.get_ref(7)?),
                ttft: loose_opt_f64(row.get_ref(8)?),
                stop_reason: loose_text(row.get_ref(9)?),
                error_message: loose_opt_text(row.get_ref(10)?),
                input_tokens: loose_i64(row.get_ref(11)?),
                output_tokens: loose_i64(row.get_ref(12)?),
                cache_read_tokens: loose_i64(row.get_ref(13)?),
                cache_write_tokens: loose_i64(row.get_ref(14)?),
                total_tokens: loose_i64(row.get_ref(15)?),
                premium_requests: loose_f64(row.get_ref(16)?),
                cost_input: loose_f64(row.get_ref(17)?),
                cost_output: loose_f64(row.get_ref(18)?),
                cost_cache_read: loose_f64(row.get_ref(19)?),
                cost_cache_write: loose_f64(row.get_ref(20)?),
                cost_total: loose_f64(row.get_ref(21)?),
                agent_type: loose_text(row.get_ref(22)?),
                cost_no_cache_input: loose_opt_f64(row.get_ref(23)?),
                category: DEFAULT_CATEGORY.to_string(),
                project_path: None,
            });
        }
        Ok(source_rows)
    }

    pub fn import_from_omp(&self, source_path: &Path) -> Result<ImportResult> {
        if !source_path.exists() {
            return Err(Error::new(format!(
                "Oh My Pi stats database was not found at {}",
                source_path.display()
            )));
        }

        let started_at = now_millis();
        let mut rows = self.read_source_rows(source_path)?;

        let mut session_files: HashMap<String, SessionFile> = HashMap::new();
        // Subagent transcripts carry no session header, so the working directory
        // is resolved per folder: any session that recorded one speaks for the
        // slug.
        let mut path_by_folder: HashMap<String, String> = HashMap::new();
        for row in &mut rows {
            let session = session_files
                .entry(row.session_file.clone())
                .or_insert_with(|| read_session_file(&row.session_file));
            row.category = classify_entry(&row.entry_id, &session.nodes);
            if let Some(cwd) = &session.cwd {
                path_by_folder
                    .entry(row.folder.clone())
                    .or_insert_with(|| cwd.clone());
            }
        }
        for row in &mut rows {
            row.project_path = path_by_folder.get(&row.folder).cloned();
        }

        let before = self.count_usage_messages()?;

        self.connection.execute_batch("BEGIN IMMEDIATE")?;
        match self.write_rows(&rows, started_at, source_path, before) {
            Ok(result) => {
                self.connection.execute_batch("COMMIT")?;
                Ok(result)
            }
            Err(error) => {
                self.connection.execute_batch("ROLLBACK")?;
                Err(error)
            }
        }
    }

    fn write_rows(
        &self,
        rows: &[SourceRow],
        started_at: i64,
        source_path: &Path,
        before: i64,
    ) -> Result<ImportResult> {
        {
            let mut upsert = self.connection.prepare(&format!(
                r#"
      INSERT INTO usage_messages (
        {USAGE_COLUMNS}, category, project_path, imported_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(session_file, entry_id) DO UPDATE SET
        folder = excluded.folder,
        model = excluded.model,
        provider = excluded.provider,
        api = excluded.api,
        timestamp = excluded.timestamp,
        duration = excluded.duration,
        ttft = excluded.ttft,
        stop_reason = excluded.stop_reason,
        error_message = excluded.error_message,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        total_tokens = excluded.total_tokens,
        premium_requests = excluded.premium_requests,
        cost_input = excluded.cost_input,
        cost_output = excluded.cost_output,
        cost_cache_read = excluded.cost_cache_read,
        cost_cache_write = excluded.cost_cache_write,
        cost_total = excluded.cost_total,
        agent_type = excluded.agent_type,
        cost_no_cache_input = excluded.cost_no_cache_input,
        category = excluded.category,
        project_path = excluded.project_path,
        imported_at = excluded.imported_at
            "#
            ))?;

            for row in rows {
                let mut cost_input = row.cost_input;
                let mut cost_output = row.cost_output;
                let mut cost_cache_read = row.cost_cache_read;
                let mut cost_cache_write = row.cost_cache_write;
                let mut cost_total = row.cost_total;
                let mut cost_no_cache_input = row.cost_no_cache_input;

                if let Some(estimate) = estimated_price(&row.model) {
                    let prompt_tokens =
                        row.input_tokens + row.cache_read_tokens + row.cache_write_tokens;
                    let tier_multiplier = match estimate.tier_limit {
                        Some(limit) if prompt_tokens > limit => 2.0,
                        _ => 1.0,
                    };
                    let input_rate = estimate.input_per_million * tier_multiplier;
                    cost_input = (row.input_tokens as f64 * input_rate) / 1_000_000.0;
                    cost_output = (row.output_tokens as f64
                        * estimate.output_per_million
                        * tier_multiplier)
                        / 1_000_000.0;
                    cost_cache_read = (row.cache_read_tokens as f64
                        * estimate.cache_read_per_million
                        * tier_multiplier)
                        / 1_000_000.0;
                    cost_cache_write = 0.0;
                    cost_total = cost_input + cost_output + cost_cache_read;
                    cost_no_cache_input = Some((prompt_tokens as f64 * input_rate) / 1_000_000.0);
                }

                upsert.execute(params![
                    row.session_file,
                    row.entry_id,
                    row.folder,
                    row.model,
                    row.provider,
                    row.api,
                    row.timestamp,
                    row.duration,
                    row.ttft,
                    row.stop_reason,
                    row.error_message,
                    row.input_tokens,
                    row.output_tokens,
                    row.cache_read_tokens,
                    row.cache_write_tokens,
                    row.total_tokens,
                    row.premium_requests,
                    cost_input,
                    cost_output,
                    cost_cache_read,
                    cost_cache_write,
                    cost_total,
                    row.agent_type,
                    cost_no_cache_input,
                    row.category,
                    row.project_path,
                    started_at,
                ])?;
            }
        }

        let total_records = self.count_usage_messages()?;
        let completed_at = now_millis();
        let new_records = total_records - before;
        self.connection.execute(
            r#"
        INSERT INTO sync_runs (
          started_at, completed_at, source_path, source_records, new_records, total_records
        ) VALUES (?, ?, ?, ?, ?, ?)
            "#,
            params![
                started_at,
                completed_at,
                source_path.to_string_lossy(),
                rows.len() as i64,
                new_records,
                total_records,
            ],
        )?;

        Ok(ImportResult {
            source_path: source_path.to_string_lossy().into_owned(),
            source_records: rows.len() as i64,
            new_records,
            total_records,
            completed_at,
        })
    }

    pub fn save_limits_snapshot(&self, snapshot: &LimitsSnapshot) -> Result<()> {
        self.connection.execute(
            r#"
    INSERT INTO limit_snapshots (id, captured_at, payload) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET captured_at = excluded.captured_at, payload = excluded.payload
            "#,
            params![snapshot.captured_at, serde_json::to_string(snapshot)?],
        )?;
        Ok(())
    }

    fn read_limits_snapshot(&self) -> Result<Option<LimitsSnapshot>> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM limit_snapshots WHERE id = 1")?;
        let mut rows = statement.query([])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let Some(payload) = loose_opt_text(row.get_ref(0)?) else {
            return Ok(None);
        };
        // A snapshot written by an older build can disagree with the current
        // shape, so a parse failure means "no snapshot" rather than an error.
        Ok(serde_json::from_str::<LimitsSnapshot>(&payload).ok())
    }

    /// Every interface choice is one JSON document under its own key, so adding
    /// a second preference later needs no schema change.
    pub fn read_preferences(&self) -> Result<Preferences> {
        let mut statement = self
            .connection
            .prepare("SELECT value FROM preferences WHERE key = ?")?;
        let mut rows = statement.query(params![HIDDEN_LIMITS_KEY])?;
        let stored = match rows.next()? {
            None => None,
            Some(row) => loose_opt_text(row.get_ref(0)?),
        };
        // A document written by an older build can disagree with the current
        // shape, so a parse failure reads as "nothing hidden" instead of
        // failing the request and blanking the panel.
        let hidden_limits = stored
            .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
            .unwrap_or_default();
        Ok(Preferences { hidden_limits })
    }

    pub fn save_preferences(&self, preferences: &Preferences) -> Result<()> {
        self.connection.execute(
            r#"
    INSERT INTO preferences (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
            "#,
            params![
                HIDDEN_LIMITS_KEY,
                serde_json::to_string(&preferences.hidden_limits)?
            ],
        )?;
        Ok(())
    }

    pub fn dashboard(&self, period: Period, now: i64) -> Result<Dashboard> {
        let (where_clause, parameters) = usage_range(period, now);
        let bound: Vec<&dyn rusqlite::ToSql> = parameters
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql)
            .collect();

        let summary = {
            let mut statement = self.connection.prepare(&format!(
                r#"
    SELECT
      COUNT(*) AS messageCount,
      COUNT(DISTINCT session_file) AS sessionCount,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_write_tokens) AS cacheWriteTokens,
      SUM(total_tokens) AS totalTokens,
      SUM(cost_total) AS cost,
      MIN(timestamp) AS firstMessageAt,
      MAX(timestamp) AS lastMessageAt
    FROM usage_messages
    {where_clause}
            "#
            ))?;
            let mut rows = statement.query(bound.as_slice())?;
            let Some(row) = rows.next()? else {
                return Err(Error::new("Could not read the usage summary"));
            };
            Summary {
                message_count: loose_i64(row.get_ref(0)?),
                session_count: loose_i64(row.get_ref(1)?),
                input_tokens: loose_i64(row.get_ref(2)?),
                output_tokens: loose_i64(row.get_ref(3)?),
                cache_read_tokens: loose_i64(row.get_ref(4)?),
                cache_write_tokens: loose_i64(row.get_ref(5)?),
                total_tokens: loose_i64(row.get_ref(6)?),
                cost: loose_f64(row.get_ref(7)?),
                first_message_at: loose_opt_i64(row.get_ref(8)?),
                last_message_at: loose_opt_i64(row.get_ref(9)?),
            }
        };

        let models = {
            let mut statement = self.connection.prepare(&format!(
                r#"
    SELECT
      model,
      provider,
      SUM(cost_total) AS cost,
      SUM(total_tokens) AS totalTokens
    FROM usage_messages
    {where_clause}
    GROUP BY model, provider
    ORDER BY cost DESC, totalTokens DESC
            "#
            ))?;
            let mut rows = statement.query(bound.as_slice())?;
            let mut models: Vec<ModelSpend> = Vec::new();
            while let Some(row) = rows.next()? {
                let cost = loose_f64(row.get_ref(2)?);
                let total_tokens = loose_i64(row.get_ref(3)?);
                models.push(ModelSpend {
                    model: loose_text(row.get_ref(0)?),
                    provider: loose_text(row.get_ref(1)?),
                    cost,
                    effective_price_per_million: price_per_million(cost, total_tokens),
                });
            }
            models
        };

        let categories = {
            let mut statement = self.connection.prepare(&format!(
                r#"
    SELECT
      category,
      COUNT(*) AS messageCount,
      SUM(total_tokens) AS totalTokens
    FROM usage_messages
    {where_clause}
    GROUP BY category
    ORDER BY totalTokens DESC
            "#
            ))?;
            let mut rows = statement.query(bound.as_slice())?;
            let mut categories: Vec<CategorySpend> = Vec::new();
            while let Some(row) = rows.next()? {
                categories.push(CategorySpend {
                    category: loose_text(row.get_ref(0)?),
                    message_count: loose_i64(row.get_ref(1)?),
                    total_tokens: loose_i64(row.get_ref(2)?),
                });
            }
            categories
        };

        let last_sync = {
            let mut statement = self.connection.prepare(
                r#"
    SELECT
      completed_at AS completedAt,
      source_records AS sourceRecords,
      new_records AS newRecords,
      total_records AS totalRecords
    FROM sync_runs
    ORDER BY id DESC
    LIMIT 1
            "#,
            )?;
            let mut rows = statement.query([])?;
            match rows.next()? {
                Some(row) => Some(LastSync {
                    completed_at: loose_i64(row.get_ref(0)?),
                    source_records: loose_i64(row.get_ref(1)?),
                    new_records: loose_i64(row.get_ref(2)?),
                    total_records: loose_i64(row.get_ref(3)?),
                }),
                None => None,
            }
        };

        Ok(Dashboard {
            generated_at: now,
            last_sync,
            summary,
            models,
            categories,
            limits: self.read_limits_snapshot()?,
        })
    }

    pub fn projects(&self, period: Period, now: i64) -> Result<ProjectsReport> {
        let (where_clause, parameters) = usage_range(period, now);
        let bound: Vec<&dyn rusqlite::ToSql> = parameters
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql)
            .collect();

        struct FolderRow {
            folder: String,
            path: Option<String>,
            message_count: i64,
            session_count: i64,
            input_tokens: i64,
            output_tokens: i64,
            cache_read_tokens: i64,
            cache_write_tokens: i64,
            total_tokens: i64,
            cost: f64,
            first_message_at: Option<i64>,
            last_message_at: Option<i64>,
        }

        let folders = {
            let mut statement = self.connection.prepare(&format!(
                r#"
    SELECT
      folder,
      MAX(project_path) AS path,
      COUNT(*) AS messageCount,
      COUNT(DISTINCT session_file) AS sessionCount,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_write_tokens) AS cacheWriteTokens,
      SUM(total_tokens) AS totalTokens,
      SUM(cost_total) AS cost,
      MIN(timestamp) AS firstMessageAt,
      MAX(timestamp) AS lastMessageAt
    FROM usage_messages
    {where_clause}
    GROUP BY folder
    ORDER BY cost DESC, totalTokens DESC
            "#
            ))?;
            let mut rows = statement.query(bound.as_slice())?;
            let mut folders: Vec<FolderRow> = Vec::new();
            while let Some(row) = rows.next()? {
                folders.push(FolderRow {
                    folder: loose_text(row.get_ref(0)?),
                    path: loose_opt_text(row.get_ref(1)?),
                    message_count: loose_i64(row.get_ref(2)?),
                    session_count: loose_i64(row.get_ref(3)?),
                    input_tokens: loose_i64(row.get_ref(4)?),
                    output_tokens: loose_i64(row.get_ref(5)?),
                    cache_read_tokens: loose_i64(row.get_ref(6)?),
                    cache_write_tokens: loose_i64(row.get_ref(7)?),
                    total_tokens: loose_i64(row.get_ref(8)?),
                    cost: loose_f64(row.get_ref(9)?),
                    first_message_at: loose_opt_i64(row.get_ref(10)?),
                    last_message_at: loose_opt_i64(row.get_ref(11)?),
                });
            }
            folders
        };

        // One extra grouped pass keeps the per-model split on the same page
        // load, so the UI never has to fetch a second time to explain a
        // project's spend.
        let mut per_project_models: HashMap<String, Vec<ProjectModel>> = HashMap::new();
        {
            let mut statement = self.connection.prepare(&format!(
                r#"
    SELECT
      folder,
      model,
      provider,
      COUNT(*) AS messageCount,
      SUM(total_tokens) AS totalTokens,
      SUM(cost_total) AS cost
    FROM usage_messages
    {where_clause}
    GROUP BY folder, model, provider
    ORDER BY cost DESC, totalTokens DESC
            "#
            ))?;
            let mut rows = statement.query(bound.as_slice())?;
            while let Some(row) = rows.next()? {
                let folder = loose_text(row.get_ref(0)?);
                per_project_models
                    .entry(folder)
                    .or_default()
                    .push(ProjectModel {
                        model: loose_text(row.get_ref(1)?),
                        provider: loose_text(row.get_ref(2)?),
                        message_count: loose_i64(row.get_ref(3)?),
                        total_tokens: loose_i64(row.get_ref(4)?),
                        cost: loose_f64(row.get_ref(5)?),
                    });
            }
        }

        let projects: Vec<Project> = folders
            .into_iter()
            .filter(|row| is_project(&row.folder, row.path.as_deref()))
            .map(|row| {
                let models = per_project_models.remove(&row.folder).unwrap_or_default();
                Project {
                    name: project_name(&row.folder, row.path.as_deref()),
                    effective_price_per_million: price_per_million(row.cost, row.total_tokens),
                    folder: row.folder,
                    path: row.path,
                    cost: row.cost,
                    total_tokens: row.total_tokens,
                    input_tokens: row.input_tokens,
                    output_tokens: row.output_tokens,
                    cache_read_tokens: row.cache_read_tokens,
                    cache_write_tokens: row.cache_write_tokens,
                    message_count: row.message_count,
                    session_count: row.session_count,
                    first_message_at: row.first_message_at,
                    last_message_at: row.last_message_at,
                    models,
                }
            })
            .collect();

        // The legend is folded up from the projects that survived the filter, so
        // a model can never appear in it without a card behind it.
        let mut order: Vec<String> = Vec::new();
        let mut model_totals: HashMap<String, ProjectModelTotal> = HashMap::new();
        for project in &projects {
            for entry in &project.models {
                let key = format!("{}/{}", entry.provider, entry.model);
                match model_totals.get_mut(&key) {
                    Some(running) => {
                        running.cost += entry.cost;
                        running.total_tokens += entry.total_tokens;
                    }
                    None => {
                        order.push(key.clone());
                        model_totals.insert(
                            key,
                            ProjectModelTotal {
                                model: entry.model.clone(),
                                provider: entry.provider.clone(),
                                cost: entry.cost,
                                total_tokens: entry.total_tokens,
                            },
                        );
                    }
                }
            }
        }
        let mut models: Vec<ProjectModelTotal> = order
            .into_iter()
            .filter_map(|key| model_totals.remove(&key))
            .collect();
        models.sort_by(|left, right| {
            right
                .cost
                .partial_cmp(&left.cost)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(right.total_tokens.cmp(&left.total_tokens))
        });

        Ok(ProjectsReport {
            generated_at: now,
            period,
            totals: ProjectTotals {
                cost: projects.iter().map(|project| project.cost).sum(),
                total_tokens: projects.iter().map(|project| project.total_tokens).sum(),
                message_count: projects.iter().map(|project| project.message_count).sum(),
                // Session files are unique per project, so the per-project
                // counts add up.
                session_count: projects.iter().map(|project| project.session_count).sum(),
                project_count: projects.len() as i64,
            },
            models,
            projects,
        })
    }
}

pub fn now_millis() -> i64 {
    Local::now().timestamp_millis()
}
