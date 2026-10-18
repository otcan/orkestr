//! Canonical asynchronous runtime store port. No provider wait occurs in a transaction.
//! Runtime owns providers/supervision; core owns persistence and verified acceptance.
use async_trait::async_trait;
pub use orkestr_v2_contracts::runtime::*;
use orkestr_v2_contracts::{ConversationId, OwnerId, RunId, SessionId};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStoreError {
    InvalidInput,
    NotFound,
    Unauthorized,
    Busy,
    StaleLease,
    Conflict,
    Expired,
    /// Includes operations whose durable adapter has not been implemented.
    Unavailable,
}
pub type Result<T> = std::result::Result<T, RuntimeStoreError>;

/// Per-call result, deliberately not serialized or persisted as an idempotent receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunAdmissionResult {
    pub admission: RunAdmission,
    /// True only for the invocation that commits the first admission/session turn.
    /// False for EVERY identical replay, including an original Execution admission.
    pub is_new: bool,
}

/// The full port is published, but no SQLite runtime adapter exists yet.
/// Implementations must return Unavailable for any unimplemented operation.
/// Unsupported provider commands are a separate runtime capability blocker.
#[async_trait]
pub trait RuntimeStore: Send + Sync {
    /// Earliest eligible sequence; deep consumer only. Claim does not remove inbox rows.
    /// Store clock bounds leases to 1..=60 seconds; reclaim increments claim generation.
    async fn claim_next(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        consumer: &SessionId,
        lease_duration: Duration,
    ) -> Result<Option<InboxClaim>>;

    /// Idempotent distinct canonical fast/deep identities; no provider process calls.
    /// Starting until confirmed native identity; never invent a replacement for Lost.
    async fn ensure_role_bindings(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<RoleBindings>;

    /// Independent worker identity, optional same-owner/scope parent, idempotent key.
    async fn create_worker_binding(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        parent: Option<&SessionId>,
        request_key: &str,
    ) -> Result<Binding>;

    /// Validate ownership/claim/generation/fence, persist Starting and acknowledge claim
    /// in the SAME transaction, closing the admit/ack crash gap. RunId is store assigned.
    /// Identical replay returns the original admission with is_new=false; changed
    /// semantic input conflicts. Only the inserting invocation returns is_new=true.
    /// Compute this flag per transaction; never persist/replay a true result.
    /// Concurrent identical admissions have at most one true result. Original
    /// Execution purpose on a replay does not authorize provider start.
    /// Crash after admission and before start leaves unknown dispatch requiring
    /// reconciliation, never automatic provider restart. Runtime validates scope,
    /// session and authoritative role before dispatch; cancellation purpose cannot start.
    async fn admit_run(
        &self,
        claim: &InboxClaim,
        binding_id: &SessionId,
        expected_generation: u64,
        request_key: &str,
    ) -> Result<RunAdmissionResult>;

    /// Confirm opaque native identity with event-key dedup; reject cross-role aliasing.
    /// Return updated admission. A missing identity never means a session is Ready.
    async fn bind_native_session(
        &self,
        admission: &RunAdmission,
        native_id: &str,
        source_event_key: &str,
    ) -> Result<RunAdmission>;

    /// Store-configured bounded extension; expired/stale/cancellation-only tokens fail.
    async fn renew_lease(
        &self,
        admission: &RunAdmission,
        expected_generation: u64,
    ) -> Result<RunAdmission>;

    /// Atomic lease/expiry/state/fence check, dedup and journal/projection update.
    /// Started -> Running; CompletedProposal -> AwaitingAcceptance, NEVER Succeeded.
    /// Only current cancellation token may confirm Stopped -> Cancelled.
    async fn record_observation(
        &self,
        admission: &RunAdmission,
        event_key: &str,
        observation: &ProviderObservation,
    ) -> Result<ObservationReceipt>;

    /// Durable CancelRequested + generation/fence increment + control outbox FIRST.
    /// Idempotent request key. Returned token is cancellation-ack authority only.
    /// A not-dispatched attempt may cancel directly; interruption failure is not success.
    async fn request_cancel(
        &self,
        owner: &OwnerId,
        run: &RunId,
        request_key: &str,
    ) -> Result<CancelReceipt>;

    /// Idempotent after atomic admission handoff, generation checked. An expired or
    /// reclaimed claim cannot ack; follow-ups remain separately queued in original order.
    async fn acknowledge_inbox(
        &self,
        claim: &InboxClaim,
        admitted_run: &RunAdmission,
    ) -> Result<()>;

    /// Fence prior-supervisor active admissions; preserve IDs and unknown dispatches.
    /// No provider restart/effect retry. now_ms is trusted supervisor input and cannot
    /// extend leases; store clock remains authoritative. Limit is 1..=100.
    /// Cursor binds supervisor+owner and resumes this idempotent recovery pass.
    async fn recover_runtime(
        &self,
        owner: &OwnerId,
        supervisor_instance: &str,
        now_ms: i64,
        after: Option<&str>,
        limit: u32,
    ) -> Result<RecoveryPage>;
}

/// One authoritative durable port, retained under both names for runtime consumers.
pub use RuntimeStore as SessionStore;
