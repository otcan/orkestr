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
}
impl ExecutionWindowTerminalOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Stopped => "stopped",
            Self::Abandoned => "abandoned",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "accepted" => Some(Self::Accepted),
            "stopped" => Some(Self::Stopped),
            "abandoned" => Some(Self::Abandoned),
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
    pub prior_run_id: RunId,
    pub terminal_event_id: EventId,
    pub abandoned_run_ids: Vec<RunId>,
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
        for outcome in ["accepted", "stopped", "abandoned"] {
            assert_eq!(
                ExecutionWindowTerminalOutcome::parse(outcome)
                    .unwrap()
                    .as_str(),
                outcome
            );
        }
        assert!(ExecutionWindowTerminalOutcome::parse("succeeded").is_none());
    }
}
