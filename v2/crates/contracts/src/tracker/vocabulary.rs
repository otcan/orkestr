//! Event vocabulary and monotonic application status transitions.
use serde::{Deserialize, Serialize};

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
    /// Explicit owner status edit; distinct from a free-text note.
    NoResponse,
    /// Owner changed structured row fields.
    Edited,
}

impl TrackerEventKind {
    pub const ALL: [TrackerEventKind; 16] = [
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
        Self::NoResponse,
        Self::Edited,
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
            Self::NoResponse => "no_response",
            Self::Edited => "edited",
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
            Self::NoResponse => TrackerStatus::NoResponse,
            Self::Note | Self::Edited => return None,
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
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
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
pub fn tracker_transition(
    current: TrackerStatus,
    event: TrackerEventKind,
) -> (TrackerStatus, bool) {
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
