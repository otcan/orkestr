//! Factual Root intake provenance. No owner-intent or execution grant.
use crate::{
    ConversationId, ConversationProvider, EventId, InputAuthor, MessageId, OwnerId, RunId,
    SessionId,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootIntakeQuery {
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootRequestClaims {
    pub action: String,
    pub resource: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootIntakeInput {
    pub message_id: MessageId,
    pub event_id: EventId,
    pub sequence: i64,
    pub client_message_id: String,
    /// None is unavailable historical provenance, never browser authority.
    pub authentication_kind: Option<String>,
    pub service_credential_id: Option<String>,
    pub author: Option<InputAuthor>,
    pub original_text: String,
    pub original_text_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootIntakeProof {
    pub schema_version: u32,
    pub operation_id: Uuid,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub source_run_id: RunId,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub source_session_id: SessionId,
    pub source_provider: ConversationProvider,
    pub source_native_session_id: String,
    pub source_setup_generation: u64,
    pub source_resume_setup_id: Option<String>,
    pub binding_generation: i64,
    pub evidence_sha256: String,
    pub operation_state: String,
    pub recorded_at_ms: i64,
    /// These remain agent claims, even when the original input is owner-authored.
    pub agent_request: RootRequestClaims,
    /// Every actual consumed input, in order. A grouped turn has several;
    /// neither its head alone nor an agent summary represents the entire input.
    pub consumed_inputs: Vec<RootIntakeInput>,
}
