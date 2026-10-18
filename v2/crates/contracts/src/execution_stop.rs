//! A durable request receipt is distinct from a provider stop acknowledgement.
use crate::{ConversationId, RunId};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStopOutcome {
    /// Dispatch authority was removed before any provider delivery permission.
    NotDispatched,
    /// Durable fence/control intent exists; delivery and interruption are unknown.
    RequestedUnknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionStopReceipt {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub run_id: RunId,
    pub request_key: String,
    pub requested_revision: i64,
    /// Original committed conversation revision, stable across receipt replay.
    pub revision: i64,
    pub outcome: ExecutionStopOutcome,
}
impl ExecutionStopReceipt {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.conversation_id.0.is_nil()
            && !self.run_id.0.is_nil()
            && self.requested_revision >= 0
            && self.revision > self.requested_revision
            && !self.request_key.is_empty()
            && self.request_key.len() <= 128
            && !self.request_key.chars().any(char::is_control)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_receipt_cannot_claim_confirmed_interruption() {
        let mut receipt = ExecutionStopReceipt {
            schema_version: 1,
            conversation_id: ConversationId(uuid::Uuid::from_u128(1)),
            run_id: RunId(uuid::Uuid::from_u128(2)),
            request_key: "stop:1".into(),
            requested_revision: 4,
            revision: 5,
            outcome: ExecutionStopOutcome::RequestedUnknown,
        };
        assert!(receipt.is_valid());
        receipt.revision = 4;
        assert!(!receipt.is_valid());
        receipt.revision = 5;
        receipt.run_id = RunId(uuid::Uuid::nil());
        assert!(!receipt.is_valid());
    }
}
