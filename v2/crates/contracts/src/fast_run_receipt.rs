//! Core Fast lineage facts. Kernel process custody is verified separately.
use crate::{ConversationId, ConversationProvider, EventId, MessageId, OwnerId, RunId, SessionId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FastRunReceiptQuery {
    pub input_message_id: MessageId,
    pub input_event_id: EventId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FastRunReceipt {
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub input_message_id: MessageId,
    pub input_event_id: EventId,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub native_session_id: String,
    pub provider: ConversationProvider,
    pub binding_generation: i64,
    pub context_id: String,
    pub incarnation_id: String,
    pub window_id: Uuid,
    pub window_generation: i64,
    pub state: String,
    pub dispatch_state: String,
    /// A completed Core presentation, not external delivery or business effects.
    pub acceptance_event_id: Option<EventId>,
}
