//! Recipe gallery and install wire shapes, and the mail-scan report.
use crate::{ConversationId, TrackerChange, TrackerPage};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeTimerSummary {
    pub label: String,
    /// The schedule in plain words (in the installer's zone).
    pub schedule: String,
    pub silent_unless_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeSummary {
    pub id: String,
    pub version: String,
    pub title: String,
    pub summary: String,
    pub conversation_name: String,
    pub timers: Vec<RecipeTimerSummary>,
    /// `thunderbird` when the recipe reads a local mail store.
    pub mail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeCatalog {
    pub recipes: Vec<RecipeSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecipeInstall {
    /// Idempotency key: the same key installs once and replays the receipt.
    pub request_key: String,
    /// IANA zone for the recipe's calendar timers (the browser's zone).
    pub timezone: String,
    /// Optional absolute path of the Thunderbird profile to read; detected
    /// when absent.
    #[serde(default)]
    pub mail_profile: Option<String>,
}

impl RecipeInstall {
    pub fn is_valid(&self) -> bool {
        let key = &self.request_key;
        !key.is_empty()
            && key.len() <= 64
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
            && !self.timezone.is_empty()
            && self.timezone.len() <= 64
            && self
                .mail_profile
                .as_deref()
                .is_none_or(valid_profile_path)
    }
}

/// Absolute, no `..`, no control characters, bounded.
pub fn valid_profile_path(path: &str) -> bool {
    let absolute = path.starts_with('/')
        || (path.len() > 2 && path.as_bytes()[1] == b':' && path.as_bytes()[0].is_ascii_alphabetic());
    absolute
        && path.len() <= 1024
        && !path.chars().any(char::is_control)
        && !path.split(['/', '\\']).any(|c| c == "..")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeInstalled {
    pub recipe: String,
    pub conversation_id: ConversationId,
    pub conversation_name: String,
    /// Calendar timers of the conversation (namespaces).
    pub timers: Vec<Uuid>,
    /// The conversation tracker grant for the assistant, shown on the first
    /// install only (`null` on a replay).
    pub tracker_grant: Option<String>,
    pub tracker: TrackerPage,
    /// Whether a Thunderbird profile with an inbox was found.
    pub mail: TrackerMailStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerMailStatus {
    /// `ready`, `no_profile`, `no_inbox` or `not_configured`.
    pub status: String,
    pub profile: Option<String>,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerScanStats {
    pub folders: usize,
    pub new_messages: usize,
    pub labelled: usize,
    pub dropped: usize,
    pub duplicates: usize,
    pub skipped: usize,
    /// More mail remains; the next scan continues.
    pub truncated: bool,
}

/// `POST .../tracker/mail-scan`: what one scan found and changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerScanReport {
    pub mail: TrackerMailStatus,
    /// At least one change is news (silent-unless-changed uses this).
    pub news: bool,
    /// One plain line per news change, most important first.
    pub summary: Vec<String>,
    pub changes: Vec<TrackerChange>,
    pub stats: TrackerScanStats,
}
