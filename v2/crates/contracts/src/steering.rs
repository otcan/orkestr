//! Owner input only. These DTOs never authorize native writes.
use crate::{ConversationId, EventId, ExecutionControlRequest, MessageId, RunId};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSteeringRequest {
    pub control: ExecutionControlRequest,
    pub text: String,
}
impl ExecutionSteeringRequest {
    pub fn is_valid(&self) -> bool {
        self.control.is_valid()
            && self.control.expected_control_revision.is_some()
            && !self.text.trim().is_empty()
            && self.text.len() <= 16384
            && !self.text.contains('\0')
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SteeringDisposition {
    Reserved,
    QueuedUnsupported,
    QueuedOrdered,
}
/// Immutable admission receipt, not native acknowledgement or completion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSteeringReceipt {
    pub conversation_id: ConversationId,
    pub run_id: RunId,
    pub request_key: String,
    pub message_id: MessageId,
    pub event_id: EventId,
    pub scope_sequence: i64,
    pub disposition: SteeringDisposition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SteeringDeliveryState {
    Queued,
    Reserved,
    DeliveryUnknown,
    Acknowledged,
    Rejected,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSteeringStatus {
    pub receipt: ExecutionSteeringReceipt,
    pub state: SteeringDeliveryState,
    pub written_bytes: u32,
}
