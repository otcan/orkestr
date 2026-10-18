//! Canonical internal runtime contracts. Native identity/authority records deliberately
//! do not implement serialization; they must never be returned by HTTP handlers.
use crate::{ConversationId, EventId, MessageId, OwnerId, PayloadId, RunId, SessionId};
use serde::{Deserialize, Serialize};

pub const RUNTIME_PORT_VERSION: u32 = 3;
pub const MAX_SOURCE_EVENT_KEY_BYTES: usize = 128;
pub const MAX_RECOVERY_PAGE_SIZE: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Fast,
    Deep,
    Worker,
}
pub use Role as SessionRole;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Starting,
    Ready,
    Busy,
    Blocked,
    Lost,
    Retired,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Starting,
    Running,
    CancelRequested,
    Cancelled,
    Blocked,
    Failed,
    AwaitingAcceptance,
    Succeeded,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Unconfigured,
    Codex,
    Claude,
    ExplicitFixture,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub session_id: SessionId,
    pub role: Role,
    pub provider_kind: ProviderKind,
    pub native_session_id: Option<String>,
    pub parent_session_id: Option<SessionId>,
    pub generation: u64,
    pub state: SessionState,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleBindings {
    pub fast: Binding,
    pub deep: Binding,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxClaim {
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub message_id: MessageId,
    pub event_id: EventId,
    pub consumer_session_id: SessionId,
    pub scope_sequence: i64,
    pub claim_generation: u64,
    /// Authoritative store-assigned Unix milliseconds, never a caller extension.
    pub lease_deadline_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionPurpose {
    Execution,
    /// New fenced token permits stop acknowledgement, never another provider start.
    CancellationAcknowledgement,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunAdmission {
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub role: Role,
    pub native_session_id: Option<String>,
    pub lease_generation: u64,
    pub dispatch_fence: u64,
    pub attempt: u32,
    pub lease_deadline_ms: i64,
    pub purpose: AdmissionPurpose,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ObservationKind {
    Started,
    ProgressRef { payload_id: PayloadId },
    ApprovalRequested,
    CompletedProposal { synthetic: bool },
    Failed,
    Stopped,
    Lost,
}
pub use ObservationKind as ProviderObservationKind;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderObservation {
    pub source_event_key: String,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub lease_generation: u64,
    pub dispatch_fence: u64,
    pub kind: ObservationKind,
}
impl ProviderObservation {
    /// Adapters must also validate association, generation, expiry and fence atomically.
    pub fn payload_is_bounded(&self) -> bool {
        let key = self.source_event_key.as_bytes();
        !key.is_empty()
            && key.len() <= MAX_SOURCE_EVENT_KEY_BYTES
            && key
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(b))
            && self.lease_generation > 0
            && self.dispatch_fence > 0
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationReceipt {
    pub event_id: EventId,
    pub scope_sequence: i64,
    pub state: RunState,
    pub duplicate: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InflightStatus {
    NotDispatched,
    Pending,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelReceipt {
    pub new_fenced_admission: RunAdmission,
    pub state: RunState,
    pub inflight_status: InflightStatus,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryRecord {
    pub binding: Binding,
    pub admission: Option<RunAdmission>,
    pub state: Option<RunState>,
    pub inflight_status: InflightStatus,
    pub requires_reconciliation: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryPage {
    pub records: Vec<RecoveryRecord>,
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observation_requires_bounded_keys_and_explicit_authority() {
        let mut observation = ProviderObservation {
            source_event_key: "provider:1".into(),
            run_id: RunId(uuid::Uuid::nil()),
            session_id: SessionId(uuid::Uuid::nil()),
            lease_generation: 1,
            dispatch_fence: 1,
            kind: ObservationKind::ProgressRef {
                payload_id: PayloadId(uuid::Uuid::nil()),
            },
        };
        assert!(observation.payload_is_bounded());
        observation.dispatch_fence = 0;
        assert!(!observation.payload_is_bounded());
        observation.dispatch_fence = 1;
        observation.kind = ObservationKind::Started;
        observation.source_event_key = "provider event with whitespace".into();
        assert!(!observation.payload_is_bounded());
    }
}
