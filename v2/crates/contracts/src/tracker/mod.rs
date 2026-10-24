//! Structured per-conversation tracker (job-tracking recipe): event and status
//! vocabulary, stable dedupe keys and the wire shapes of rows and events.
//! Pure and web-safe: the server, the mail reader and the UI share it.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ConversationId;

mod vocabulary;
pub use vocabulary::*;

/// Header carrying a conversation tracker grant (machine requests only).
pub const TRACKER_GRANT_HEADER: &str = "x-orkestr-tracker-grant";
pub const TRACKER_TEXT_MAX: usize = 200;
pub const TRACKER_NOTES_MAX: usize = 4000;
pub const TRACKER_EVENTS_PER_REQUEST: usize = 100;
pub const TRACKER_ROWS_MAX: usize = 5000;

fn bounded(value: &str, max: usize) -> bool {
    value.chars().count() <= max && !value.chars().any(|c| c.is_control() && c != '\n')
}
fn bounded_line(value: &str, max: usize) -> bool {
    value.chars().count() <= max && !value.chars().any(char::is_control)
}

/// One event as a producer (the mail reader, the assistant, the UI) reports it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerEventInput {
    pub kind: TrackerEventKind,
    pub company: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    /// `linkedin`, `ats:greenhouse`, `recruiter`, `direct`, `manual`, ...
    pub source: String,
    #[serde(default)]
    pub link: Option<String>,
    pub occurred_ms: i64,
    /// Hashed RFC 822 Message-ID (24 hex); the dedupe ledger key for mail.
    #[serde(default)]
    pub message_ref: Option<String>,
    #[serde(default)]
    pub sender_domain: Option<String>,
    /// Transient classification evidence; persistence keeps only its SHA-256 hash.
    #[serde(default)]
    pub evidence: Option<String>,
    /// `rule:<id>`, `llm:<model>`, `assistant` or `manual`.
    pub classifier: String,
    /// 0..=100.
    pub confidence: u8,
    #[serde(default)]
    pub next_step: Option<String>,
    /// Hashed references (In-Reply-To / References) of the mail this event
    /// came from: a reply in the thread of a known application or lead
    /// attaches to that row before any company or role matching.
    #[serde(default)]
    pub thread_refs: Vec<String>,
    /// Record only as part of a known thread (keyword evidence from an
    /// untrusted sender never creates or moves a row by itself).
    #[serde(default)]
    pub requires_thread: bool,
}

pub const TRACKER_THREAD_REFS_MAX: usize = 20;
fn hashed_ref(v: &str) -> bool {
    v.len() == 24 && v.bytes().all(|b| b.is_ascii_hexdigit())
}

impl TrackerEventInput {
    pub fn is_valid(&self) -> bool {
        let token = |v: &str, max: usize| {
            !v.is_empty()
                && v.len() <= max
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:@".contains(&b))
        };
        let optional =
            |v: &Option<String>, max: usize| v.as_deref().is_none_or(|v| bounded_line(v, max));
        !self.company.trim().is_empty()
            && bounded_line(&self.company, 120)
            && optional(&self.role, 160)
            && optional(&self.location, 120)
            && token(&self.source, 40)
            && self
                .link
                .as_deref()
                .is_none_or(|v| tracker_canonical_url(v).is_some())
            && self.occurred_ms > 0
            && self.message_ref.as_deref().is_none_or(hashed_ref)
            && self.thread_refs.len() <= TRACKER_THREAD_REFS_MAX
            && self.thread_refs.iter().all(|v| hashed_ref(v))
            && self.sender_domain.as_deref().is_none_or(|v| token(v, 253))
            && self
                .evidence
                .as_deref()
                .is_none_or(|v| bounded(v, TRACKER_TEXT_MAX))
            && token(&self.classifier, 80)
            && self.confidence <= 100
            && optional(&self.next_step, TRACKER_TEXT_MAX)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerEventsRequest {
    /// Idempotency key of this batch (replay returns the same changes).
    pub request_key: String,
    pub events: Vec<TrackerEventInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerRow {
    pub id: Uuid,
    pub company: String,
    pub company_key: String,
    pub role: String,
    pub role_key: String,
    pub source: String,
    pub status: TrackerStatus,
    pub status_changed_ms: i64,
    pub applied_ms: Option<i64>,
    pub last_contact_ms: i64,
    pub next_step: Option<String>,
    pub link: Option<String>,
    pub location: Option<String>,
    pub notes: String,
    pub confidence: u8,
    pub needs_review: bool,
    pub archived: bool,
    pub events_count: u32,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerEvent {
    pub id: Uuid,
    pub row_id: Uuid,
    pub kind: TrackerEventKind,
    pub occurred_ms: i64,
    pub source: String,
    pub message_ref: Option<String>,
    pub sender_domain: Option<String>,
    pub evidence: Option<String>,
    pub classifier: String,
    pub confidence: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackerChangeKind {
    Created,
    StatusChanged,
    /// Recorded on an existing row without changing its status.
    Event,
    /// The event matched ambiguously or contradicts a terminal status.
    NeedsReview,
    /// Same message already in the ledger: nothing recorded.
    Duplicate,
    /// Needed a known thread and had none: nothing recorded.
    Unmatched,
    /// Intake advanced with durable overflow evidence; owner attention needed.
    BacklogFull,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerChange {
    pub kind: TrackerChangeKind,
    pub row_id: Option<Uuid>,
    pub company: String,
    pub role: String,
    pub event: TrackerEventKind,
    pub from: Option<TrackerStatus>,
    pub to: Option<TrackerStatus>,
    /// The recipe asks to tell the user right away (interview, offer, ...).
    pub notify: bool,
}

impl TrackerChange {
    /// Whether this change is news (silent-unless-changed counts these).
    pub fn is_news(&self) -> bool {
        match self.kind {
            // A lead from a job alert is recorded quietly.
            TrackerChangeKind::Created => self.to != Some(TrackerStatus::Saved),
            TrackerChangeKind::StatusChanged
            | TrackerChangeKind::NeedsReview
            | TrackerChangeKind::BacklogFull => true,
            TrackerChangeKind::Event
            | TrackerChangeKind::Duplicate
            | TrackerChangeKind::Unmatched => false,
        }
    }
    /// One plain line for a digest or a chat reply.
    pub fn line(&self) -> String {
        let role = if self.role.is_empty() {
            "?"
        } else {
            &self.role
        };
        match (self.kind, self.from, self.to) {
            (TrackerChangeKind::Created, _, Some(to)) => {
                format!("New: {} - {} ({})", self.company, role, to.label())
            }
            (TrackerChangeKind::StatusChanged, Some(from), Some(to)) => format!(
                "{} - {}: {} -> {}",
                self.company,
                role,
                from.label(),
                to.label()
            ),
            (TrackerChangeKind::BacklogFull, _, _) => {
                "Tracker backlog full; review intake audit".into()
            }
            (TrackerChangeKind::NeedsReview, _, _) => format!(
                "Check: {} - {} ({} needs review)",
                self.company,
                role,
                self.event.as_str()
            ),
            _ => format!("{} - {}: {}", self.company, role, self.event.as_str()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerChangeset {
    pub changes: Vec<TrackerChange>,
}

impl TrackerChangeset {
    pub fn has_news(&self) -> bool {
        self.changes.iter().any(TrackerChange::is_news)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerBacklog {
    pub pending: u32,
    pub expired: u64,
    pub evicted: u64,
    pub overflow: u64,
    pub full: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerPage {
    pub conversation_id: ConversationId,
    /// The recipe that set the tracker up (`job-tracker`) or `manual`.
    pub recipe: String,
    pub grant_issued: bool,
    /// When the mail source was last scanned, if it has one.
    pub last_scan_ms: Option<i64>,
    pub rows: Vec<TrackerRow>,
    pub backlog: TrackerBacklog,
}

/// Turn a conversation's tracker on (idempotent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerEnable {
    pub recipe: String,
    /// Event kinds that are flagged `notify` (tell the user right away).
    #[serde(default = "default_notify_on")]
    pub notify_on: Vec<TrackerEventKind>,
}
pub fn default_notify_on() -> Vec<TrackerEventKind> {
    vec![
        TrackerEventKind::InterviewInvite,
        TrackerEventKind::InterviewScheduled,
        TrackerEventKind::Assessment,
        TrackerEventKind::Offer,
    ]
}
impl TrackerEnable {
    pub fn is_valid(&self) -> bool {
        !self.recipe.is_empty()
            && self.recipe.len() <= 80
            && self
                .recipe
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && self.notify_on.len() <= TrackerEventKind::ALL.len()
    }
}

/// Fold `absorb` into `keep` in the active table, retaining original history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerMerge {
    pub keep: Uuid,
    pub absorb: Uuid,
}

/// A conversation tracker grant, shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerGrantIssued {
    pub conversation_id: ConversationId,
    pub grant: String,
}

/// Manual edit of one row (the table view). Absent fields stay unchanged;
/// a status edit is recorded as a `manual` event and always wins.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerRowEdit {
    pub expected_revision: i64,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub status: Option<TrackerStatus>,
    /// `Some("")` clears it.
    #[serde(default)]
    pub next_step: Option<String>,
    /// `Some("")` clears it.
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub needs_review: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
}

impl TrackerRowEdit {
    pub fn is_valid(&self) -> bool {
        self.expected_revision > 0
            && self
                .company
                .as_deref()
                .is_none_or(|v| !v.trim().is_empty() && bounded_line(v, 120))
            && self.role.as_deref().is_none_or(|v| bounded_line(v, 160))
            && self
                .next_step
                .as_deref()
                .is_none_or(|v| bounded_line(v, TRACKER_TEXT_MAX))
            && self
                .link
                .as_deref()
                .is_none_or(|v| v.is_empty() || tracker_canonical_url(v).is_some())
            && self
                .notes
                .as_deref()
                .is_none_or(|v| bounded(v, TRACKER_NOTES_MAX))
    }
}

mod csv;
pub use csv::{tracker_csv, tracker_iso_utc};
mod keys;
pub use keys::{
    tracker_canonical_url, tracker_company_key, tracker_linkedin_job_id, tracker_role_key,
};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
