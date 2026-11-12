//! Explicit terminal disposition of an exact unstarted owner input.
use crate::{ConversationId, EventId, MessageId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerInputRetirementRequest {
    pub request_key: String,
    pub reason: String,
}
impl OwnerInputRetirementRequest {
    pub fn is_valid(&self) -> bool {
        !self.request_key.is_empty()
            && self.request_key.len() <= 128
            && self
                .request_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
            && !self.reason.trim().is_empty()
            && self.reason.len() <= 512
            && !self.reason.chars().any(char::is_control)
    }
}

/// Receipt reason of an operator settlement (ORK-798): an automatic result
/// that sits in a closed window and can never run.
pub const STALE_INPUT_SETTLEMENT_REASON: &str = "operator_settled_stale";

/// Owner/operator settlement of one exact stale automatic result. The reason
/// is fixed ([`STALE_INPUT_SETTLEMENT_REASON`]); the receipt is the ordinary
/// immutable [`OwnerInputRetirementReceipt`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StaleInputSettlementRequest {
    pub request_key: String,
}
impl StaleInputSettlementRequest {
    pub fn is_valid(&self) -> bool {
        OwnerInputRetirementRequest {
            request_key: self.request_key.clone(),
            reason: STALE_INPUT_SETTLEMENT_REASON.into(),
        }
        .is_valid()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnerInputRetirementState {
    Retired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerInputRetirementReceipt {
    pub retirement_id: Uuid,
    pub conversation_id: ConversationId,
    pub message_id: MessageId,
    pub event_id: EventId,
    pub scope_sequence: i64,
    pub reason: String,
    pub state: OwnerInputRetirementState,
    pub retired_at_ms: i64,
    pub duplicate: bool,
}
