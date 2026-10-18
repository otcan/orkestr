//! Proposed runtime-facing port. No SQLite adapter implements this port yet.
//!
//! Store time, authenticated ownership and compare-and-swap generations are authoritative.
//! Provider calls must occur only after the transaction returns.
use orkestr_v2_contracts::{runtime::*, *};
use std::future::Future;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStoreError {
    InvalidInput,
    NotFound,
    Conflict,
    StaleVersion,
    StaleLease,
    Fenced,
    Unsupported,
    Unavailable,
}
pub type Result<T> = std::result::Result<T, RuntimeStoreError>;

#[derive(Debug, Clone)]
pub struct SessionBinding {
    pub session_id: SessionId,
    pub conversation_id: ConversationId,
    pub role: SessionRole,
    pub state: SessionState,
    pub version: i64,
}
#[derive(Debug, Clone)]
pub struct RoleBindings {
    pub fast: SessionBinding,
    pub deep: SessionBinding,
}
#[derive(Debug, Clone)]
pub struct Lease {
    pub owner_id: OwnerId,
    pub session_id: SessionId,
    pub generation: i64,
    /// Store-assigned Unix milliseconds; caller timestamps never extend authority.
    pub expires_at_ms: i64,
}
#[derive(Debug, Clone)]
pub struct InboxClaim {
    pub conversation_id: ConversationId,
    pub message_id: MessageId,
    pub event_id: EventId,
    pub sequence: i64,
    pub text: String,
    pub lease: Lease,
}
/// Server-side supervisor receipt. Native references must not be serialized to clients.
#[derive(Debug, Clone)]
pub struct SupervisorAdmission {
    pub session_id: SessionId,
    pub provider_kind: ProviderKind,
    pub native_session_ref: String,
    pub protocol_version: String,
    pub supervisor_receipt_ref: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Codex,
    Claude,
    ExplicitFixture,
}
#[derive(Debug, Clone)]
pub struct RunAdmission {
    /// Stable idempotency key; duplicate bodies return the same run, changed bodies conflict.
    pub request_key: String,
    pub task_id: TaskId,
    pub claim: InboxClaim,
    /// Worker leases are separate from the deep inbox claim lease.
    pub execution_lease: Lease,
    pub supervisor: SupervisorAdmission,
}
#[derive(Debug, Clone)]
pub struct RunRecord {
    pub run_id: RunId,
    pub task_id: TaskId,
    pub conversation_id: ConversationId,
    pub session_id: SessionId,
    pub state: RunState,
    pub version: i64,
    pub lease_generation: i64,
    pub fence_generation: i64,
}
#[derive(Debug, Clone)]
pub struct CancelReceipt {
    pub run: RunRecord,
    /// Already-dispatched effects may remain in flight. No rollback is implied.
    pub in_flight_effects_unknown: bool,
}
#[derive(Debug, Clone)]
pub struct RecoveryRecord {
    pub session: SessionBinding,
    pub run: Option<RunRecord>,
    /// Lost sessions require explicit reconciliation, never automatic recreation.
    pub requires_reconciliation: bool,
}

pub trait RuntimeStore: Send + Sync {
    /// Idempotent canonical fast/deep pair; different IDs, initially Starting.
    fn ensure_role_bindings(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<RoleBindings>> + Send;
    /// Mark Ready only after a supported provider or explicitly selected fixture receipt.
    fn confirm_session(
        &self,
        owner: &OwnerId,
        expected_version: i64,
        admission: &SupervisorAdmission,
    ) -> impl Future<Output = Result<SessionBinding>> + Send;
    /// Allocate separate worker lifecycle; never replace the fast/deep canonical pair.
    fn allocate_worker(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        request_key: &str,
    ) -> impl Future<Output = Result<SessionBinding>> + Send;
    /// One live turn per session. Expired claims require recovery, not blind takeover.
    fn lease_session(
        &self,
        owner: &OwnerId,
        session: &SessionId,
        expected_version: i64,
        lease_seconds: u32,
    ) -> impl Future<Output = Result<Lease>> + Send;
    /// Deep reasoning only: earliest unconsumed sequence; no skipping a live earlier claim.
    /// Fast presentation is independent; it must not consume the deep reasoning inbox.
    fn claim_inbox(
        &self,
        lease: &Lease,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<Option<InboxClaim>>> + Send;
    /// Task must already be queued and owned by the same scope. Admission and journal are atomic.
    fn admit_run(
        &self,
        owner: &OwnerId,
        admission: &RunAdmission,
    ) -> impl Future<Output = Result<RunRecord>> + Send;
    fn renew_lease(
        &self,
        lease: &Lease,
        lease_seconds: u32,
    ) -> impl Future<Output = Result<Lease>> + Send;
    /// Commits CancelRequested, scope fence increment and durable control outbox before return.
    fn request_cancel(
        &self,
        owner: &OwnerId,
        run: &RunId,
        expected_version: i64,
    ) -> impl Future<Output = Result<CancelReceipt>> + Send;
    /// Scheduling guard only. This is NOT permission to dispatch any effect.
    /// Effect dispatch must atomically recheck these generations in its own ledger transaction.
    fn check_run_fence(
        &self,
        owner: &OwnerId,
        run: &RunId,
        lease_generation: i64,
        fence_generation: i64,
    ) -> impl Future<Output = Result<RunRecord>> + Send;
    /// Bounded idempotent boot reconciliation. Never calls providers or retries effects.
    fn recover_expired(
        &self,
        owner: &OwnerId,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<RecoveryRecord>>> + Send;
}
