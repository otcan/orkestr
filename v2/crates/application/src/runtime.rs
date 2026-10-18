//! Canonical asynchronous runtime store port. No provider wait occurs in a transaction.
//! Runtime owns providers/supervision; core owns persistence and verified acceptance.
pub use orkestr_v2_contracts::runtime::*;
mod authority;
mod dispatch;
pub use dispatch::*;
pub use authority::*;
use orkestr_v2_contracts::{ConversationId, OwnerId, RunId, SessionId};
use std::{future::Future, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStoreError {
    InvalidInput,
    NotFound,
    Unauthorized,
    Busy,
    StaleLease,
    /// Dispatch authority was revoked; never a successful stop acknowledgement.
    Fenced,
    Conflict,
    Expired,
    /// Includes operations whose durable adapter has not been implemented.
    Unavailable,
}
pub type Result<T> = std::result::Result<T, RuntimeStoreError>;

/// SQLite implements bindings and inbox claims; remaining operations are unavailable.
/// Implementations must return Unavailable for any unimplemented operation.
/// Unsupported provider commands are a separate runtime capability blocker.
pub trait RuntimeStore: Send + Sync {
    /// Earliest eligible sequence; deep consumer only. Claim does not remove inbox rows.
    /// Store clock bounds leases to 1..=60 seconds; reclaim increments claim generation.
    fn claim_next(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        consumer: &SessionId,
        lease_duration: Duration,
    ) -> impl Future<Output = Result<Option<InboxClaim>>> + Send;

    /// Idempotent distinct canonical fast/deep identities; no provider process calls.
    /// Starting until confirmed native identity; never invent a replacement for Lost.
    fn ensure_role_bindings(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<RoleBindings>> + Send;

    /// Independent worker identity, optional same-owner/scope parent, idempotent key.
    fn create_worker_binding(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        parent: Option<&SessionId>,
        request_key: &str,
    ) -> impl Future<Output = Result<Binding>> + Send;

    /// Validate ownership/claim/generation/fence, persist Starting and acknowledge claim
    /// in the SAME transaction, closing the admit/ack crash gap. RunId is store assigned.
    /// Identical replay returns Replay or ReconciliationRequired, never FreshCandidate;
    /// changed replay conflicts. FreshCandidate is per inserting invocation only and
    /// grants no provider permission. Unknown dispatch always requires reconciliation.
    /// Deep only: binding_id must equal claim.consumer_session_id. Fast and workers
    /// cannot consume this claim. Independent worker admission is not yet exposed.
    fn admit_run(
        &self,
        claim: &InboxClaim,
        binding_id: &SessionId,
        expected_generation: u64,
        request_key: &str,
    ) -> impl Future<Output = Result<RunAdmissionResult>> + Send;

    /// Reserve only a fresh candidate under the authorized supervisor-bound handle.
    /// Atomically validate owner/scope/role/session/attempt, Execution purpose,
    /// live store-clock lease/fence and never-dispatched state; persist reservation.
    /// Verify and consume the admission-issued candidate key in this transaction;
    /// trusting the caller's FreshCandidate enum alone is forbidden.
    /// Concurrent contenders have one winner. Repeated requests never issue another
    /// reservation; changed content conflicts. Replays do not drive automatic dispatch.
    /// No supervisor-context enforcement means Unavailable, not an unbound grant.
    fn claim_provider_dispatch(
        &self,
        _candidate: &RunAdmissionResult,
        _request_key: &str,
    ) -> impl Future<Output = Result<DispatchClaimResult>> + Send {
        async { Err(RuntimeStoreError::Unavailable) }
    }

    /// Recheck reservation, bound supervisor incarnation, identity, purpose and live
    /// lease/fence atomically. Commit Reserved -> DeliveryUnknown BEFORE provider I/O.
    /// Only the CAS-winning invocation returns DispatchNow. Repeated/lost-ACK calls
    /// return ReconciliationRequired, never DispatchNow. A crash before/after provider
    /// invocation stays unknown; neither timeout nor missing Started authorizes retry.
    /// Cancellation/recovery must fence reservation consumption in the same authority.
    fn consume_provider_dispatch(
        &self,
        _claim: &DispatchClaim,
    ) -> impl Future<Output = Result<DispatchConsumption>> + Send {
        async { Err(RuntimeStoreError::Unavailable) }
    }

    /// Confirm opaque native identity with event-key dedup; reject cross-role aliasing.
    /// Return updated admission. A missing identity never means a session is Ready.
    fn bind_native_session(
        &self,
        admission: &RunAdmission,
        native_id: &str,
        source_event_key: &str,
    ) -> impl Future<Output = Result<RunAdmission>> + Send;

    /// Store-configured bounded extension; expired/stale/cancellation-only tokens fail.
    fn renew_lease(
        &self,
        admission: &RunAdmission,
        expected_generation: u64,
    ) -> impl Future<Output = Result<RunAdmission>> + Send;

    /// Owner/scope/run/session and observation tokens must match the admission.
    /// Store computes the semantic digest; caller digests never grant authority.
    /// Check current lease/expiry/fence before acknowledging even a duplicate.
    /// Atomic lease/expiry/state/fence check, dedup and journal/projection update.
    /// Started -> Running; CompletedProposal -> AwaitingAcceptance, NEVER Succeeded.
    /// Only current cancellation token may confirm Stopped -> Cancelled.
    /// Cancellation never rewrites existing CompletedProposal/Failed/Lost evidence;
    /// a racing stop cannot replace terminal truth with successful cancellation.
    /// Receipt acknowledges a committed observation (including identical replay).
    /// Unavailable/Busy retain the exact pending event and key for retry;
    /// StaleLease/Fenced/Expired discard it from the delivery queue without start/replay.
    /// Conflict is a protocol blocker, never a successful acknowledgement.
    fn record_observation(
        &self,
        admission: &RunAdmission,
        event_key: &str,
        observation: &ProviderObservation,
    ) -> impl Future<Output = Result<ObservationReceipt>> + Send;

    /// Durable CancelRequested + generation/fence increment + control outbox FIRST.
    /// Idempotent request key. Returned token is cancellation-ack authority only.
    /// A not-dispatched attempt may cancel directly; interruption failure is not success.
    fn request_cancel(
        &self,
        owner: &OwnerId,
        run: &RunId,
        request_key: &str,
    ) -> impl Future<Output = Result<CancelReceipt>> + Send;

    /// Idempotent after atomic admission handoff, generation checked. An expired or
    /// reclaimed claim cannot ack; follow-ups remain separately queued in original order.
    fn acknowledge_inbox(
        &self,
        claim: &InboxClaim,
        admitted_run: &RunAdmission,
    ) -> impl Future<Output = Result<()>> + Send;

    /// Fence prior-supervisor active admissions; preserve IDs and unknown dispatches.
    /// No provider restart/effect retry. now_ms is trusted supervisor input and cannot
    /// extend leases; store clock remains authoritative. Limit is 1..=100.
    /// Cursor binds supervisor+owner and resumes this idempotent recovery pass.
    fn recover_runtime(
        &self,
        owner: &OwnerId,
        supervisor_instance: &str,
        now_ms: i64,
        after: Option<&str>,
        limit: u32,
    ) -> impl Future<Output = Result<RecoveryPage>> + Send;
}

/// One authoritative durable port, retained under both names for runtime consumers.
pub use RuntimeStore as SessionStore;
