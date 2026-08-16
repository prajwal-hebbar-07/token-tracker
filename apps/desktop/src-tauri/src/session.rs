//! Session transcript parsing and work categorisation.
//!
//! Oh My Pi writes one JSONL record per entry. A usage row only names the entry
//! that produced it, so the category comes from walking up the parent chain to
//! the nearest user message and matching it against the rules below. The rule
//! order is significant: the first match wins, so narrower intents are listed
//! before "Development", which would otherwise absorb almost everything.

use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

pub const DEFAULT_CATEGORY: &str = "Logic & planning";

#[derive(Debug, Clone)]
pub struct SessionNode {
    pub parent_id: Option<String>,
    pub user_text: Option<String>,
}

#[derive(Debug, Default)]
pub struct SessionFile {
    pub cwd: Option<String>,
    pub nodes: HashMap<String, SessionNode>,
}

static CATEGORY_RULES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    vec![
            (
                "Design",
                Regex::new(r"(?i)\b(design|ui|ux|layout|styling|stylesheet|css|tailwind|figma|paper|visual|typography|responsive)\b").unwrap(),
            ),
            (
                "Debugging",
                Regex::new(r"(?i)\b(bug|debug|error|crash|broken|failing|failure|not working|regression|fix)\b").unwrap(),
            ),
            (
                "Review & security",
                Regex::new(r"(?i)\b(review|audit|security|vulnerab|code quality|performance|over-engineer|refactor|simplif)\w*").unwrap(),
            ),
            (
                "DevOps",
                Regex::new(r"(?i)\b(deploy|deployment|docker|ci|pipeline|release|commit|push|git|infrastructure|monorepo|turborepo)\b").unwrap(),
            ),
            (
                "Data & analytics",
                Regex::new(r"(?i)\b(database|sqlite|sql|schema|migration|analytics|token|cost|pricing|dashboard)\w*").unwrap(),
            ),
            (
                "Documentation",
                Regex::new(r"(?i)\b(documentation|docs|readme|copywriting|guide|changelog)\b").unwrap(),
            ),
            (
                "Research",
                Regex::new(r"(?i)\b(research|investigate|compare|website|find out|explain|how does|what is)\b").unwrap(),
            ),
            (
                "Development",
                Regex::new(r"(?i)\b(add|build|implement|create|update|change|feature|code|api|backend|frontend|component|command)\w*").unwrap(),
            ),
    ]
});

/// Pulls the user's own words out of a transcript message. Assistant and tool
/// records carry no intent, and a content array mixes text with tool blocks.
fn extract_user_text(message: &Value) -> Option<String> {
    let object = message.as_object()?;
    if object.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = object.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let items = content.as_array()?;

    let mut text: Vec<&str> = Vec::new();
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        if item.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let Some(value) = item.get("text").and_then(Value::as_str) {
            text.push(value);
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(text.join("\n"))
    }
}

pub fn read_session_file(session_file: &str) -> SessionFile {
    let mut file = SessionFile::default();
    let Ok(contents) = fs::read_to_string(Path::new(session_file)) else {
        // A transcript named by an old usage row can be gone by now. An empty
        // node map simply yields the default category.
        return file;
    };

    for line in contents.split('\n') {
        if line.is_empty() {
            continue;
        }
        // An active session can end with a partially written JSONL record.
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(entry) = entry.as_object() else {
            continue;
        };

        // The session header carries the real working directory. The folder
        // column only holds a slug where "/" and "-" both became "-", so the
        // directory boundaries cannot be recovered from it.
        if file.cwd.is_none() {
            if let Some(cwd) = entry.get("cwd").and_then(Value::as_str) {
                if !cwd.is_empty() {
                    file.cwd = Some(cwd.to_string());
                }
            }
        }
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };

        let parent_id = entry
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let user_text = entry.get("message").and_then(extract_user_text);
        file.nodes.insert(
            id.to_string(),
            SessionNode {
                parent_id,
                user_text,
            },
        );
    }
    file
}

/// Walks from an entry towards the root until a user message is found. The depth
/// bound is the node count, so a transcript whose parent links form a cycle ends
/// on the default rather than spinning.
pub fn classify_entry(entry_id: &str, nodes: &HashMap<String, SessionNode>) -> String {
    let mut current = nodes.get(entry_id);
    let mut depth = 0usize;

    while let Some(node) = current {
        if depth > nodes.len() {
            break;
        }
        // An empty string is not intent: keep climbing, matching the original's
        // truthiness check rather than merely testing for presence.
        if let Some(text) = node.user_text.as_deref().filter(|text| !text.is_empty()) {
            for (category, pattern) in CATEGORY_RULES.iter() {
                if pattern.is_match(text) {
                    return (*category).to_string();
                }
            }
            return DEFAULT_CATEGORY.to_string();
        }
        current = node
            .parent_id
            .as_deref()
            .and_then(|parent| nodes.get(parent));
        depth += 1;
    }
    DEFAULT_CATEGORY.to_string()
}
