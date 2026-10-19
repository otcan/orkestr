//! Explicit owner acceptance; provider completion never constitutes this decision.
use crate::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionAcceptanceRequest {
    pub run_id: RunId,
    pub completion_event_id: EventId,
    pub expected_revision: i64,
    pub request_key: String,
}
impl ExecutionAcceptanceRequest {
    pub fn is_valid(&self) -> bool {
        !self.run_id.0.is_nil()
            && !self.completion_event_id.0.is_nil()
            && self.expected_revision >= 0
            && !self.request_key.is_empty()
            && self.request_key.len() <= 128
            && self
                .request_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionAcceptanceOutcome {
    Succeeded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionAcceptanceReceipt {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub run_id: RunId,
    pub completion_event_id: EventId,
    pub acceptance_event_id: EventId,
    pub request_key: String,
    pub requested_revision: i64,
    /// Original committed conversation revision, including on historical replay.
    pub revision: i64,
    pub outcome: ExecutionAcceptanceOutcome,
}
impl ExecutionAcceptanceReceipt {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.conversation_id.0.is_nil()
            && !self.acceptance_event_id.0.is_nil()
            && self.acceptance_event_id != self.completion_event_id
            && self.revision > self.requested_revision
            && ExecutionAcceptanceRequest {
                run_id: self.run_id.clone(),
                completion_event_id: self.completion_event_id.clone(),
                expected_revision: self.requested_revision,
                request_key: self.request_key.clone(),
            }
            .is_valid()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionAcceptedEnvelope {
    pub event_id: EventId,
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub scope: Scope,
    pub aggregate_id: ConversationId,
    pub aggregate_version: i64,
    pub sequence: i64,
    pub occurred_at: String,
    pub payload_ref_or_safe_payload: ExecutionAccepted,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionAccepted {
    pub kind: ExecutionAcceptedTag,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub completion_event_id: EventId,
    pub outcome: ExecutionAcceptanceOutcome,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionAcceptedTag {
    ExecutionAccepted,
}
impl ExecutionAcceptedEnvelope {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 9
            && self.sequence > 0
            && self.aggregate_version == self.sequence
            && !self.event_id.0.is_nil()
            && !self.owner_id.0.is_nil()
            && !self.aggregate_id.0.is_nil()
            && !self.payload_ref_or_safe_payload.run_id.0.is_nil()
            && !self.payload_ref_or_safe_payload.session_id.0.is_nil()
            && !self
                .payload_ref_or_safe_payload
                .completion_event_id
                .0
                .is_nil()
            && self.event_id != self.payload_ref_or_safe_payload.completion_event_id
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acceptance_requires_exact_completion_and_bounded_key() {
        let mut r = ExecutionAcceptanceRequest {
            run_id: RunId(uuid::Uuid::from_u128(1)),
            completion_event_id: EventId(uuid::Uuid::from_u128(2)),
            expected_revision: 3,
            request_key: "accept:1".into(),
        };
        assert!(r.is_valid());
        r.completion_event_id = EventId(uuid::Uuid::nil());
        assert!(!r.is_valid());
        r.completion_event_id = EventId(uuid::Uuid::from_u128(2));
        r.request_key = "unsafe key".into();
        assert!(!r.is_valid());
    }
}
