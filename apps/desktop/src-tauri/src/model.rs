//! Wire types for the local API.
//!
//! Every struct serialises to the exact JSON the dashboard already consumes, so
//! the web bundle is reused byte for byte. Field names stay camelCase because
//! the interface types in `apps/web/app/page.tsx` and
//! `apps/web/app/projects/page.tsx` are the contract.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Today,
    Month,
    All,
    /// One local calendar day, named by the date itself.
    Day(NaiveDate),
}

impl Period {
    /// Mirrors the API's query parsing: an absent value means the whole history,
    /// and anything else is a client error rather than a silent fallback.
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match value.unwrap_or("all") {
            "today" => Some(Self::Today),
            "month" => Some(Self::Month),
            "all" => Some(Self::All),
            date => parse_day(date).map(Self::Day),
        }
    }
}

/// `YYYY-MM-DD` and nothing else, matching the API's regex rather than chrono's
/// tolerance for unpadded numbers and signed years, so both implementations
/// accept exactly the same dates.
fn parse_day(value: &str) -> Option<NaiveDate> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

// The reports echo the period back as the string the request asked for, so a day
// serialises as its date and never as a tagged enum variant.
impl Serialize for Period {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Today => serializer.serialize_str("today"),
            Self::Month => serializer.serialize_str("month"),
            Self::All => serializer.serialize_str("all"),
            Self::Day(date) => serializer.collect_str(&date.format("%Y-%m-%d")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub id: String,
    pub label: String,
    pub unit: String,
    pub status: String,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    pub used_fraction: Option<f64>,
    pub resets_at: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimits {
    pub provider: String,
    pub account: Option<String>,
    pub plan: Option<String>,
    pub fetched_at: Option<f64>,
    pub windows: Vec<LimitWindow>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsSnapshot {
    pub captured_at: f64,
    pub generated_at: Option<f64>,
    pub providers: Vec<ProviderLimits>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub source_path: String,
    pub source_records: i64,
    pub new_records: i64,
    pub total_records: i64,
    pub completed_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSync {
    pub completed_at: i64,
    pub source_records: i64,
    pub new_records: i64,
    pub total_records: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub message_count: i64,
    pub session_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub cost: f64,
    pub first_message_at: Option<i64>,
    pub last_message_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpend {
    pub model: String,
    pub provider: String,
    pub cost: f64,
    pub effective_price_per_million: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySpend {
    pub category: String,
    pub message_count: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub generated_at: i64,
    pub last_sync: Option<LastSync>,
    pub summary: Summary,
    pub models: Vec<ModelSpend>,
    pub categories: Vec<CategorySpend>,
    pub limits: Option<LimitsSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTotals {
    pub cost: f64,
    pub total_tokens: i64,
    pub message_count: i64,
    pub session_count: i64,
    pub project_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModel {
    pub model: String,
    pub provider: String,
    pub cost: f64,
    pub total_tokens: i64,
    pub message_count: i64,
}

/// The projects legend carries no message count, unlike the per-project split.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModelTotal {
    pub model: String,
    pub provider: String,
    pub cost: f64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub folder: String,
    pub path: Option<String>,
    pub name: String,
    pub cost: f64,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub message_count: i64,
    pub session_count: i64,
    pub first_message_at: Option<i64>,
    pub last_message_at: Option<i64>,
    pub effective_price_per_million: Option<f64>,
    pub models: Vec<ProjectModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsReport {
    pub generated_at: i64,
    pub period: Period,
    pub totals: ProjectTotals,
    pub models: Vec<ProjectModelTotal>,
    pub projects: Vec<Project>,
}

/// Interface choices the dashboard stores server-side. The window's own
/// `localStorage` cannot hold them: the loopback port is ephemeral, so each
/// launch is a new origin with an empty storage bucket.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// Quota keys the Account limits panel is hiding, as `provider/account/window`.
    #[serde(default)]
    pub hidden_limits: Vec<String>,
}
