//! Durable owner intent waiting for a free execution window slot.
//! A queued entry is never execution authority; Core admission still decides.
use crate::{ConversationId, EventId, MessageId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Most window requests the owner may hold queued across all conversations.
pub const MAX_QUEUED_WINDOW_REQUESTS: u32 = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuedWindowState {
    /// Durably waiting for capacity or for this conversation's earlier work.
    Queued,
    /// Admitted exactly once into the named window.
    Dispatched,
    /// Never admitted; the saved message stays in history and can be resent.
    Withdrawn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuedWindowWithdrawal {
    /// The input was held, consumed or otherwise left the eligible queue.
    InputUnavailable,
    /// The conversation's previous window needs operator reconciliation.
    ReconciliationRequired,
    /// Repeated admission refusal; no window was created for this request.
    AdmissionRefused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowQueued {
    pub conversation_id: ConversationId,
    pub request_key: String,
    pub input_message_id: MessageId,
    pub input_event_id: EventId,
    pub input_request_key: String,
    pub state: QueuedWindowState,
    /// One-based order among all of the owner's queued requests while queued.
    pub position: Option<u32>,
    pub queued_at_ms: i64,
    pub window_id: Option<Uuid>,
    pub withdrawal: Option<QueuedWindowWithdrawal>,
}

/// Owner-wide capacity summary plus the selected conversation's queued entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowQueue {
    pub conversation_id: ConversationId,
    pub capacity: u32,
    pub active: u32,
    pub queued_total: u32,
    pub entries: Vec<ExecutionWindowQueued>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_receipt_roundtrips_with_closed_vocabulary() {
        let value = serde_json::json!({
            "conversation_id":"00000000-0000-4000-8000-000000000001",
            "request_key":"synthetic-window","input_message_id":"00000000-0000-4000-8000-000000000002",
            "input_event_id":"00000000-0000-4000-8000-000000000003","input_request_key":"synthetic-input",
            "state":"queued","position":3,"queued_at_ms":1,"window_id":null,"withdrawal":null
        });
        let parsed: ExecutionWindowQueued = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
        let mut unknown = value.clone();
        unknown["authority"] = serde_json::json!("grant");
        assert!(serde_json::from_value::<ExecutionWindowQueued>(unknown).is_err());
        let mut state = value;
        state["state"] = serde_json::json!("running");
        assert!(serde_json::from_value::<ExecutionWindowQueued>(state).is_err());
    }
}
