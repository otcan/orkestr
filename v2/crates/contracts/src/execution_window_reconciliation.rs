//! Audited recovery of an execution window whose opening process is gone.
//! A reconciliation never accepts, re-executes or grants budget; it records the
//! owner's (or the deadline-passed startup path's) explicit terminal decision.
use crate::{ConversationId, EventId, RunId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// What happens to runs still awaiting owner acceptance in the stranded window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionWindowReconciliationDecision {
    /// Unaccepted proposals become explicitly abandoned; never accepted or rerun.
    AbandonUnaccepted,
    /// Every run must already be accepted or stopped (accept-then-retire).
    RetireResolved,
}

/// Who asked for the reconciliation. `Startup` is the automatic path and is
/// refused unless the window's hard deadline has already passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionWindowReconciliationActor {
    Startup,
    Owner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionWindowTerminalOutcome {
    Accepted,
    Stopped,
    Abandoned,
    /// The window's open failed before it produced any run of its own (no
    /// prior run), or its last Deep turn lapsed with its process gone (names
    /// that turn). Only a reconciliation outcome.
    Failed,
}
impl ExecutionWindowTerminalOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Stopped => "stopped",
            Self::Abandoned => "abandoned",
            Self::Failed => "failed",
        }
    }
    /// Parses a recorded window outcome. A run's terminal evidence kind is
    /// parsed separately: `failed` there names a reconciled Worker, never a turn.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "accepted" => Some(Self::Accepted),
            "stopped" => Some(Self::Stopped),
            "abandoned" => Some(Self::Abandoned),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// Why a window's open is recorded as failed. Derived by Core from durable
/// state at reconciliation time; the live error of the lost process is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionWindowOpenFailureCause {
    /// The window's private credential was never issued. Usually the manager
    /// admitted it first; a window the manager refused to admit has this
    /// cause too and is closed by Core without a manager record.
    CredentialUnissued,
    /// The credential was issued but the opening never bound it.
    CredentialUnbound,
    /// The window was bound, but setup (for example broker readiness or Fast
    /// setup) failed before any run of its own existed.
    SetupIncomplete,
}
impl ExecutionWindowOpenFailureCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CredentialUnissued => "credential_unissued",
            Self::CredentialUnbound => "credential_unbound",
            Self::SetupIncomplete => "setup_incomplete",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "credential_unissued" => Some(Self::CredentialUnissued),
            "credential_unbound" => Some(Self::CredentialUnbound),
            "setup_incomplete" => Some(Self::SetupIncomplete),
            _ => None,
        }
    }
}

/// Owner HTTP request body. IDs select the exact stranded window only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowReconciliationRequest {
    pub window_id: Uuid,
    pub generation: u64,
    pub decision: ExecutionWindowReconciliationDecision,
}
impl ExecutionWindowReconciliationRequest {
    pub fn is_valid(&self) -> bool {
        !self.window_id.is_nil() && self.generation > 0 && self.generation < 9_007_199_254_740_992
    }
}

/// Immutable audit receipt. `duplicate` marks a replay of a committed decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowReconciliation {
    pub reconciliation_id: Uuid,
    pub window_id: Uuid,
    pub conversation_id: ConversationId,
    pub generation: u64,
    pub actor: ExecutionWindowReconciliationActor,
    pub decision: ExecutionWindowReconciliationDecision,
    pub outcome: ExecutionWindowTerminalOutcome,
    /// The window's own last Deep turn. None only for a failed open.
    pub prior_run_id: Option<RunId>,
    pub terminal_event_id: Option<EventId>,
    pub abandoned_run_ids: Vec<RunId>,
    /// Workers left `cancel_requested` past their lease deadline, now failed.
    pub failed_run_ids: Vec<RunId>,
    /// Set only for a `failed` open.
    pub open_failure_cause: Option<ExecutionWindowOpenFailureCause>,
    /// The retired window the conversation continues from after a failed open.
    pub restored_window_id: Option<Uuid>,
    pub released_input_event_ids: Vec<EventId>,
    pub reconciled_at_ms: i64,
    pub duplicate: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_validation_and_wire_names() {
        let mut request = ExecutionWindowReconciliationRequest {
            window_id: Uuid::from_u128(7),
            generation: 5,
            decision: ExecutionWindowReconciliationDecision::AbandonUnaccepted,
        };
        assert!(request.is_valid());
        assert_eq!(
            serde_json::to_value(&request).unwrap()["decision"],
            "abandon_unaccepted"
        );
        request.generation = 0;
        assert!(!request.is_valid());
        request.generation = 1;
        request.window_id = Uuid::nil();
        assert!(!request.is_valid());
        assert!(serde_json::from_str::<ExecutionWindowReconciliationRequest>(
            r#"{"window_id":"00000000-0000-0000-0000-000000000007","generation":1,"decision":"accept"}"#
        )
        .is_err());
        for outcome in ["accepted", "stopped", "abandoned", "failed"] {
            assert_eq!(
                ExecutionWindowTerminalOutcome::parse(outcome)
                    .unwrap()
                    .as_str(),
                outcome
            );
        }
        assert!(ExecutionWindowTerminalOutcome::parse("succeeded").is_none());
        for cause in [
            "credential_unissued",
            "credential_unbound",
            "setup_incomplete",
        ] {
            assert_eq!(
                ExecutionWindowOpenFailureCause::parse(cause)
                    .unwrap()
                    .as_str(),
                cause
            );
        }
        assert!(ExecutionWindowOpenFailureCause::parse("open_failed").is_none());
    }
}
