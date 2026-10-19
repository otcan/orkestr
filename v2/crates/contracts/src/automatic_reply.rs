//! Owner decisions and copy-only evidence. None of these values grant a send.
use crate::ConversationId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomaticReplyPermissionRequest {
    pub route_id: Uuid,
    pub expected_route_generation: i64,
    pub expected_permission_revision: i64,
    pub request_key: String,
    pub enabled: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomaticReplyPermissionReceipt {
    pub conversation_id: ConversationId,
    pub route_id: Uuid,
    pub route_generation: i64,
    pub permission_revision: i64,
    pub enabled: bool,
    pub request_key: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "availability",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum AutomaticReplySourceRevision {
    Known(String),
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "availability",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum AutomaticReplySourceGeneration {
    Known(u64),
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomaticReplyEffectClass {
    Sent,
    Sending,
    Uncertain,
    Unknown,
    NoRecord,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomaticReplyHistoricalEffect {
    pub classification: AutomaticReplyEffectClass,
    pub count: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomaticReplyHoldReason {
    OperatorPreserved,
    UncertainEffect,
    UnknownEffect,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomaticReplyPreservedInput {
    pub source_namespace: Uuid,
    pub source_input_identity: String,
    pub source_revision: AutomaticReplySourceRevision,
    pub hold_source_revision: AutomaticReplySourceRevision,
    pub source_route_generation: AutomaticReplySourceGeneration,
    pub historical_effects: Vec<AutomaticReplyHistoricalEffect>,
    pub hold_reason: AutomaticReplyHoldReason,
    /// Original metadata, never a cutoff or eligibility predicate.
    pub created_at: String,
    /// Canonical whole-second UTC, or explicit absence of historical evidence.
    pub observed_at: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomaticReplyInputReceipt {
    pub input_id: Uuid,
    pub conversation_id: ConversationId,
    pub dormant: bool,
    pub never_replay: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomaticReplySendState {
    Reserved,
    DeliveryUnknown,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomaticReplySendReceipt {
    pub reservation_id: Uuid,
    pub input_id: Uuid,
    pub route_id: Uuid,
    pub route_generation: i64,
    pub account_scope: String,
    pub permission_revision: i64,
    pub output_sha256: String,
    pub byte_length: u32,
    pub state: AutomaticReplySendState,
    pub written_bytes: u32,
}
