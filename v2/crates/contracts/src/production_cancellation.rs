//! Metadata only: this event never grants interrupt or execution authority.
use crate::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancellationRequestedEnvelope {
    pub event_id: EventId,
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub scope: Scope,
    pub aggregate_id: ConversationId,
    pub aggregate_version: i64,
    pub sequence: i64,
    pub occurred_at: String,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub payload_ref_or_safe_payload: CancellationRequested,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancellationRequested {
    pub kind: CancellationTag,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub outcome: CancellationOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationTag {
    CancellationRequested,
}

/// NotDispatched means durable cancellation before provider delivery; Unknown
/// means cancellation requested with delivery/outcome still unconfirmed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationOutcome {
    NotDispatched,
    Unknown,
}

impl CancellationRequestedEnvelope {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 6 && self.sequence > 0 && self.aggregate_version == self.sequence
    }
}
