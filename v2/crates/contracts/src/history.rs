//! Dormant published history only; these records never authorize execution.
use crate::{ConversationId, Message, OwnerId, Scope};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryImportRequest {
    pub namespace: Uuid,
    pub source_digest: String,
    pub source_conversation_id: ConversationId,
    pub source_scope: Scope,
    pub source_watermark: i64,
    pub messages: Vec<Message>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryImportReceipt {
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub namespace: Uuid,
    pub source_digest: String,
    pub source_conversation_id: ConversationId,
    pub source_watermark: i64,
    pub message_count: u64,
    pub revision: i64,
    pub active: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryRollbackRequest {
    pub namespace: Uuid,
    pub expected_revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryRollbackReceipt {
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub namespace: Uuid,
    pub import_revision: i64,
    pub revision: i64,
    pub active: bool,
}
