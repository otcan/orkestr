use super::*;

/// Trusted supervisor input, not a browser DTO. No owner/native/prompt fields.
pub struct WorkerAdmissionInput {
    pub worker_binding_id: SessionId,
    pub expected_binding_generation: u64,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub request_key: String,
    pub lifetime_ms: u32,
}
/// Opaque admission locator; never inference or effect authority.
pub struct WorkerDelegation {
    pub(super) _id: Uuid,
    pub(super) _locator: String,
}
impl WorkerDelegation {
    /// Metadata locator only; conveys no inference or effect authority.
    pub(in crate::production_runtime) fn id(&self) -> Uuid {
        self._id
    }
}
pub enum WorkerDelegationResult {
    Fresh(WorkerDelegation),
    Existing(WorkerDelegationReceipt),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDelegationReceipt {
    pub delegation_id: Uuid,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub parent_run_id: RunId,
    pub worker_session_id: SessionId,
    pub admitted_run_id: Option<RunId>,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub lease_deadline_ms: i64,
    pub state: WorkerDelegationState,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerDelegationState {
    Delegated,
    Admitted,
    Blocked,
}
