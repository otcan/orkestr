//! Web-safe runtime metadata. Native identities and execution authority live in application.
use crate::{EventId, PayloadId, RunId, SessionId};
use serde::{Deserialize, Serialize};

pub const RUNTIME_PORT_VERSION: u32 = 5;
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
