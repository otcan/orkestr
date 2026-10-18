//! Server-side provider input. Never serialize native identities or raw progress to metadata.
use super::{Binding, RunAdmission, RunState};
use orkestr_v2_contracts::{EventId, RunId, SessionId};

pub const MAX_PROVIDER_PROGRESS_BYTES: usize = 8192;

/// Execution-only envelope. A CancelReceipt is never a substitute for this admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAdmission {
    pub run: RunAdmission,
    pub binding: Binding,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderEvent {
    Started,
    Progress(String),
    /// Informational evidence, never an approval grant.
    ApprovalRequested,
    CompletedProposal {
        synthetic: bool,
    },
    Failed,
    Stopped,
    Lost,
}
impl ProviderEvent {
    pub fn is_bounded(&self) -> bool {
        match self {
            Self::Progress(text) => text.len() <= MAX_PROVIDER_PROGRESS_BYTES,
            _ => true,
        }
    }
}

/// Sequence starts at one and is stable across retries. No caller-supplied digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEventInput {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub lease_generation: u64,
    pub dispatch_fence: u64,
    pub sequence: u64,
    pub event: ProviderEvent,
}
impl ProviderEventInput {
    pub fn is_bounded(&self) -> bool {
        self.sequence > 0
            && self.sequence <= i64::MAX as u64
            && self.lease_generation > 0
            && self.lease_generation <= i64::MAX as u64
            && self.dispatch_fence > 0
            && self.dispatch_fence <= i64::MAX as u64
            && self.event.is_bounded()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEventReceipt {
    pub event_id: EventId,
    pub scope_sequence: i64,
    pub sequence: u64,
    pub state: RunState,
    pub duplicate: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_limit_counts_utf8_bytes() {
        assert!(ProviderEvent::Progress("é".repeat(4096)).is_bounded());
        assert!(!ProviderEvent::Progress("é".repeat(4097)).is_bounded());
    }
}
