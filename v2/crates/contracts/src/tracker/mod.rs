//! Structured per-conversation tracker (job-tracking recipe): event and status
//! vocabulary, stable dedupe keys and the wire shapes of rows and events.
//! Pure and web-safe: the server, the mail reader and the UI share it.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ConversationId;

/// What one piece of evidence (an email, a manual entry) says happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackerEventKind {
    Saved,
    Applied,
    ApplicationReceived,
    Viewed,
    InReview,
    RecruiterContact,
    Assessment,
    InterviewInvite,
    InterviewScheduled,
    Offer,
    Rejection,
    Withdrawn,
    /// A job alert: a lead (`saved`), never moves an application forward.
    JobAlert,
    /// A free-text note or a manual edit; never changes the status by itself.
    Note,
}

impl TrackerEventKind {
    pub const ALL: [TrackerEventKind; 14] = [
        Self::Saved,
        Self::Applied,
        Self::ApplicationReceived,
        Self::Viewed,
        Self::InReview,
        Self::RecruiterContact,
        Self::Assessment,
        Self::InterviewInvite,
        Self::InterviewScheduled,
        Self::Offer,
        Self::Rejection,
        Self::Withdrawn,
        Self::JobAlert,
        Self::Note,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Saved => "saved",
            Self::Applied => "applied",
            Self::ApplicationReceived => "application_received",
            Self::Viewed => "viewed",
            Self::InReview => "in_review",
            Self::RecruiterContact => "recruiter_contact",
            Self::Assessment => "assessment",
            Self::InterviewInvite => "interview_invite",
            Self::InterviewScheduled => "interview_scheduled",
            Self::Offer => "offer",
            Self::Rejection => "rejection",
            Self::Withdrawn => "withdrawn",
            Self::JobAlert => "job_alert",
            Self::Note => "note",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
    /// The application status this event implies, if any.
    pub fn status(self) -> Option<TrackerStatus> {
        Some(match self {
            Self::Saved | Self::JobAlert => TrackerStatus::Saved,
            Self::Applied | Self::ApplicationReceived => TrackerStatus::Applied,
            Self::Viewed | Self::InReview | Self::RecruiterContact => TrackerStatus::InReview,
            Self::Assessment => TrackerStatus::Assessment,
            Self::InterviewInvite | Self::InterviewScheduled => TrackerStatus::Interview,
            Self::Offer => TrackerStatus::Offer,
            Self::Rejection => TrackerStatus::Rejected,
            Self::Withdrawn => TrackerStatus::Withdrawn,
            Self::Note => return None,
        })
    }
}

/// Current status of one application row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackerStatus {
    /// A lead (job alert or manually saved job), not applied yet.
    Saved,
    Applied,
    InReview,
    Assessment,
    Interview,
    Offer,
    Rejected,
    Withdrawn,
    NoResponse,
}

impl TrackerStatus {
    pub const ALL: [TrackerStatus; 9] = [
        Self::Saved,
        Self::Applied,
        Self::InReview,
        Self::Assessment,
        Self::Interview,
        Self::Offer,
        Self::Rejected,
        Self::Withdrawn,
        Self::NoResponse,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Saved => "saved",
            Self::Applied => "applied",
            Self::InReview => "in_review",
            Self::Assessment => "assessment",
            Self::Interview => "interview",
            Self::Offer => "offer",
            Self::Rejected => "rejected",
            Self::Withdrawn => "withdrawn",
            Self::NoResponse => "no_response",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Saved => "Saved",
            Self::Applied => "Applied",
            Self::InReview => "In review",
            Self::Assessment => "Assessment",
            Self::Interview => "Interview",
            Self::Offer => "Offer",
            Self::Rejected => "Rejected",
            Self::Withdrawn => "Withdrawn",
            Self::NoResponse => "No response",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|status| status.as_str() == value)
    }
    /// Progress rank; `None` for the terminal and synthetic states.
    pub fn rank(self) -> Option<u8> {
        match self {
            Self::Saved => Some(0),
            Self::Applied | Self::NoResponse => Some(1),
            Self::InReview => Some(2),
            Self::Assessment => Some(3),
            Self::Interview => Some(4),
            Self::Offer => Some(5),
            Self::Rejected | Self::Withdrawn => None,
        }
    }
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Rejected | Self::Withdrawn)
    }
    /// Deterministic default next step for a status.
    pub fn default_next_step(self) -> Option<&'static str> {
        match self {
            Self::Saved => Some("Decide whether to apply"),
            Self::Applied => Some("Follow up if no reply"),
            Self::InReview => Some("Wait for a reply"),
            Self::Assessment => Some("Complete the assessment"),
            Self::Interview => Some("Prepare for the interview"),
            Self::Offer => Some("Review the offer"),
            Self::NoResponse => Some("Follow up or archive"),
            Self::Rejected | Self::Withdrawn => None,
        }
    }
}

/// Status after an event: monotonic by rank, terminal states win from any
/// state, and a later positive event after a terminal state does not reopen
/// the row silently (it asks for review instead). Returns `(status, review)`.
pub fn tracker_transition(current: TrackerStatus, event: TrackerEventKind) -> (TrackerStatus, bool) {
    let Some(next) = event.status() else {
        return (current, false);
    };
    if next.is_terminal() {
        return (next, false);
    }
    if current.is_terminal() {
        return (current, next != TrackerStatus::Saved);
    }
    match (current.rank(), next.rank()) {
        (Some(have), Some(want)) if want > have => (next, false),
        // `no_response` is cleared by any later inbound event.
        _ if current == TrackerStatus::NoResponse => (next, false),
        _ => (current, false),
    }
}

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
    /// At most 200 characters that justified the label.
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
        let optional = |v: &Option<String>, max: usize| v.as_deref().is_none_or(|v| bounded_line(v, max));
        !self.company.trim().is_empty()
            && bounded_line(&self.company, 120)
            && optional(&self.role, 160)
            && optional(&self.location, 120)
            && token(&self.source, 40)
            && self.link.as_deref().is_none_or(|v| tracker_canonical_url(v).is_some())
            && self.occurred_ms > 0
            && self
                .message_ref
                .as_deref()
                .is_none_or(hashed_ref)
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
            TrackerChangeKind::StatusChanged | TrackerChangeKind::NeedsReview => true,
            TrackerChangeKind::Event | TrackerChangeKind::Duplicate | TrackerChangeKind::Unmatched => false,
        }
    }
    /// One plain line for a digest or a chat reply.
    pub fn line(&self) -> String {
        let role = if self.role.is_empty() { "?" } else { &self.role };
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
pub struct TrackerPage {
    pub conversation_id: ConversationId,
    /// The recipe that set the tracker up (`job-tracker`) or `manual`.
    pub recipe: String,
    pub grant_issued: bool,
    /// When the mail source was last scanned, if it has one.
    pub last_scan_ms: Option<i64>,
    pub rows: Vec<TrackerRow>,
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

/// Fold `absorb` into `keep` (events, links); `absorb` is removed.
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
pub use keys::{tracker_canonical_url, tracker_company_key, tracker_linkedin_job_id, tracker_role_key};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
