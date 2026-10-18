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

/// Internal provider authority; native references must never enter client DTOs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAdmission {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub native_session_ref: String,
    pub lease_generation: i64,
    pub fence_generation: i64,
    pub role: SessionRole,
}

/// Provider evidence only; completion does not establish task acceptance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderEvent {
    Started,
    Progress(String),
    ApprovalRequested,
    Completed { synthetic: bool },
    Failed,
    Stopped,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEventInput {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub lease_generation: i64,
    pub fence_generation: i64,
    /// Contiguous from one per run; identical retries return the original receipt.
    pub provider_sequence: i64,
    pub event: ProviderEvent,
}

#[derive(Debug, Clone)]
pub struct ProviderEventReceipt {
    pub event_id: EventId,
    pub run: RunRecord,
}

/// Version of the internal runtime port shape, separate from HTTP/event versions.
pub const RUNTIME_PORT_VERSION: u32 = 0;
/// Storage and provider adapters must reject larger progress payloads.
pub const MAX_PROVIDER_PROGRESS_BYTES: usize = 8192;

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
    /// Authenticate the caller and validate owner/run/session association before dedup lookup.
    /// Never disclose an existing receipt to another principal or mismatched association.
    /// An identical already-committed semantic input returns its original receipt even
    /// after lease expiry or fence advancement, without any new transition or write.
    /// Changed content at an existing sequence conflicts; core computes the canonical digest.
    /// Unseen events require current owner/session/run, live lease, fence and lifecycle
    /// authority, checked atomically with contiguous sequence admission and journaling.
    /// Unavailable is retryable with identical input; StaleLease/Fenced explicitly refuse
    /// new authority. Preserve refused evidence for reconciliation, never fabricate Stopped.
    /// A newer cancellation fence is control-only, never execution start/poll authority.
    /// Progress is bounded by MAX_PROVIDER_PROGRESS_BYTES. Approval is never granted here.
    /// Completed is proposal evidence only and must never directly establish Succeeded.
    fn append_provider_event(
        &self,
        owner: &OwnerId,
        input: &ProviderEventInput,
    ) -> impl Future<Output = Result<ProviderEventReceipt>> + Send;
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
