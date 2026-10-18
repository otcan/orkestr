//! Confirmed fixture stop metadata, never an interruption capability.
use crate::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixtureProviderStoppedEnvelope {
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
    pub payload_ref_or_safe_payload: FixtureProviderStopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixtureProviderStopped {
    pub kind: FixtureStoppedTag,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub run_sequence: u64,
    pub receipt_state: FixtureStoppedReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureStoppedTag {
    FixtureProviderStopped,
}

/// Only a persisted acknowledgement of the exact issued cancellation-purpose
/// token may produce this state. A request or interrupt result cannot do so.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureStoppedReceiptState {
    Cancelled,
}
