//! Read-only continuation admission/result evidence. An accepted proposal is
//! attributed model output, never an attestation of external business effects.
use crate::{
    ConversationId, ConversationProvider, EventId, InputAuthor, MessageId, OwnerId, RunId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceContextQuery {
    pub source_run_id: RunId,
    pub source_message_id: MessageId,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceContextProof {
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub source_run_id: RunId,
    pub source_message_id: MessageId,
    pub source_native_session_id: String,
    pub source_provider: ConversationProvider,
    pub provider_generation: i64,
    pub binding_generation: i64,
    pub eligible_for_continuation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceReceiptQuery {
    pub client_message_id: String,
    pub text_sha256: String,
    pub expected_provider_generation: i64,
    pub continuation_source_run_id: RunId,
    pub source_native_session_id: String,
    pub source_provider: ConversationProvider,
    pub author: InputAuthor,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceAdmissionProof {
    pub message_id: MessageId,
    pub event_id: EventId,
    pub sequence: i64,
    pub client_message_id: String,
    pub text_sha256: String,
    pub expected_provider_generation: i64,
    pub continuation_source_run_id: RunId,
    pub source_native_session_id: String,
    pub source_provider: ConversationProvider,
    pub source_binding_generation: i64,
    pub author: InputAuthor,
    /// Actual Core authentication kind, separately from claimed author.
    pub authentication_kind: String,
    pub service_credential_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRunProof {
    pub run_id: RunId,
    pub native_session_id: String,
    pub provider: ConversationProvider,
    pub binding_generation: i64,
    pub state: String,
    pub dispatch_state: String,
    pub input_relation: String,
    pub completion_event_id: Option<EventId>,
    pub acceptance_event_id: Option<EventId>,
    pub payload_id: Option<String>,
    pub payload_sha256: Option<String>,
    pub payload_text: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceReceiptProjection {
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    /// missing, legacy_unproven or admitted. Absence never permits replay.
    pub admission_state: String,
    pub admission: Option<SourceAdmissionProof>,
    pub input_state: Option<String>,
    pub run: Option<SourceRunProof>,
    /// This port attests Core lineage, not external effects.
    pub business_state: String,
    pub work_completed: bool,
}
