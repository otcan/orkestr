//! Application-only native identities and store authority; never HTTP DTOs.
use super::{Role, RunState, SessionState};
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, OwnerId, RunId, SessionId};

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
