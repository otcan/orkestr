//! Canonical asynchronous runtime store port. No provider wait occurs in a transaction.
//! Runtime owns providers/supervision; core owns persistence and verified acceptance.
pub use orkestr_v2_contracts::runtime::*;
mod authority;
pub use authority::*;
mod provider;
use orkestr_v2_contracts::{ConversationId, OwnerId, RunId, SessionId};
pub use provider::*;
use std::time::Duration;
/// Attribute for runtime adapters/spies; dependency remains application-owned.
pub use async_trait::async_trait;

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
    /// Identical request replay returns original admission; changed replay conflicts.
    /// Deep only: binding_id must equal claim.consumer_session_id. Fast and workers
    /// cannot consume this claim. Independent worker admission is not yet exposed.
    async fn admit_run(
        &self,
        claim: &InboxClaim,
        binding_id: &SessionId,
        expected_generation: u64,
        request_key: &str,
    ) -> Result<RunAdmission>;

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

    /// Authenticate owner and run/session association FIRST; never disclose a receipt
    /// across principals or mismatched associations. A committed identical
    /// sequence/body returns its original receipt even after expiry/fencing, without
    /// a new write or transition. Changed replay conflicts. Core computes the digest.
    /// A new contiguous sequence requires current execution authority,
    /// matching lease/fence, expiry and legal state; no provider completion is success.
    /// Progress is bounded and must use removable payload storage, never raw journal text.
    /// Unavailable/Busy retains exact pending input. Fenced/StaleLease is explicit refusal;
    /// preserve original terminal evidence for reconciliation, never fabricate Stopped.
    /// A newer cancellation fence is control-only, never execution start/poll authority.
    async fn append_provider_event(
        &self,
        owner: &OwnerId,
        admission: &ProviderAdmission,
        input: &ProviderEventInput,
    ) -> Result<ProviderEventReceipt>;

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
