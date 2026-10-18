//! Proposed application-only dispatch authority. No durable implementation exists.
use super::{ProviderAdmission, RunState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDisposition {
    /// This invocation inserted the attempt. Not permission to call a provider.
    FreshCandidate,
    /// Identical admitted attempt; must not automatically claim or dispatch it.
    Replay,
    /// A dispatch may have been attempted; explicit reconciliation is required.
    ReconciliationRequired,
}
#[derive(Clone, PartialEq, Eq)]
pub struct RunAdmissionResult {
    /// Role/scope/purpose must be validated from the durable binding, not caller input.
    pub provider: ProviderAdmission,
    pub run_state: RunState,
    pub disposition: AdmissionDisposition,
    /// Store-issued unpredictable one-use locator, present only on FreshCandidate.
    /// Admission persists its verifier bound to attempt and supervisor incarnation;
    /// identical admission replay must NOT return the locator. Never log/serialize it.
    pub candidate_key: Option<String>,
}
/// Store-issued reservation locator, not a bearer credential or dispatch permission.
/// Every use must revalidate its association and bound supervisor authority in store.
#[derive(Clone, PartialEq, Eq)]
pub struct DispatchClaim {
    pub provider: ProviderAdmission,
    pub reservation_key: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchClaimResult {
    Reserved(Box<DispatchClaim>),
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

// Avoid recursively formatting the native provider envelope or issued locators.
impl std::fmt::Debug for RunAdmissionResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunAdmissionResult")
            .field("run_state", &self.run_state)
            .field("disposition", &self.disposition)
            .field("candidate_key", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for DispatchClaim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DispatchClaim")
            .field("reservation_key", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{
        AdmissionPurpose, Binding, ProviderKind, Role, RunAdmission, SessionState,
    };
    use orkestr_v2_contracts::{ConversationId, OwnerId, RunId, SessionId};

    fn provider() -> ProviderAdmission {
        let id = "00000000-0000-0000-0000-000000000001".parse().unwrap();
        ProviderAdmission {
            run: RunAdmission {
                owner_id: OwnerId(id),
                conversation_id: ConversationId(id),
                run_id: RunId(id),
                session_id: SessionId(id),
                role: Role::Deep,
                native_session_id: Some("synthetic-private-native".into()),
                lease_generation: 1,
                dispatch_fence: 1,
                attempt: 1,
                lease_deadline_ms: 1,
                purpose: AdmissionPurpose::Execution,
            },
            binding: Binding {
                owner_id: OwnerId(id),
                conversation_id: ConversationId(id),
                session_id: SessionId(id),
                role: Role::Deep,
                provider_kind: ProviderKind::ExplicitFixture,
                native_session_id: Some("synthetic-private-native".into()),
                parent_session_id: None,
                generation: 1,
                state: SessionState::Ready,
            },
        }
    }

    #[test]
    fn debug_redacts_issued_keys_and_native_envelopes() {
        let admission = RunAdmissionResult {
            provider: provider(),
            run_state: RunState::Starting,
            disposition: AdmissionDisposition::FreshCandidate,
            candidate_key: Some("synthetic-private-candidate".into()),
        };
        let claim = DispatchClaimResult::Reserved(Box::new(DispatchClaim {
            provider: provider(),
            reservation_key: "synthetic-private-reservation".into(),
        }));
        for output in [
            format!("{admission:?}"),
            format!("{admission:#?}"),
            format!("{claim:?}"),
            format!("{claim:#?}"),
        ] {
            assert!(output.contains("[REDACTED]"));
            assert!(!output.contains("synthetic-private"));
        }
    }
}
