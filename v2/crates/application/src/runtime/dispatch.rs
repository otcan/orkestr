//! Proposed application-only dispatch authority. No durable implementation exists.
use super::RunAdmission;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDisposition {
    /// This invocation inserted the attempt. Not permission to call a provider.
    FreshCandidate,
    /// Identical admitted attempt; must not automatically claim or dispatch it.
    Replay,
    /// A dispatch may have been attempted; explicit reconciliation is required.
    ReconciliationRequired,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunAdmissionResult {
    /// Role/scope/purpose must be validated from the durable binding, not caller input.
    pub admission: RunAdmission,
    pub disposition: AdmissionDisposition,
}
/// Store-issued reservation locator, not a bearer credential or dispatch permission.
/// Every use must revalidate its association and bound supervisor authority in store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchClaim {
    pub admission: RunAdmission,
    pub reservation_key: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchClaimResult {
    Reserved(DispatchClaim),
    Replay,
    ReconciliationRequired,
}
/// Per-call result: never persist/replay DispatchNow as an idempotent receipt.
/// Deliberately neither Clone nor Copy; no serialized delivery capability is issued.
#[derive(Debug, PartialEq, Eq)]
pub enum DispatchConsumption {
    /// The unique call committed Reserved -> DeliveryUnknown before provider I/O.
    /// This says nothing about delivery or provider acknowledgement.
    DispatchNow,
    /// Already consumed, lost ACK, restart or other unknown outcome. Never dispatch.
    ReconciliationRequired,
}
