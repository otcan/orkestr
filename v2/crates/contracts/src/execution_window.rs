//! Browser observations and intent only; none of these values grants execution.
use crate::{ConversationId, EventId, MessageId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionWindowState {
    Opening,
    Active,
    Retiring,
    Closed,
    ReconciliationRequired,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowLimits {
    pub duration_ms: u32,
    pub attempts: u32,
    pub bytes: u64,
    /// Included in the totals above, never additional budget.
    pub cleanup_ms: u32,
    pub cleanup_attempts: u32,
    pub cleanup_bytes: u64,
}
impl Default for ExecutionWindowLimits {
    fn default() -> Self {
        Self {
            duration_ms: 900_000,
            attempts: 32,
            bytes: 67_108_864,
            cleanup_ms: 30_000,
            cleanup_attempts: 4,
            cleanup_bytes: 1_048_576,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowRequest {
    pub request_key: String,
    pub input_message_id: MessageId,
    pub input_event_id: EventId,
    pub input_request_key: String,
    pub expected_generation: u64,
    /// Some admits another input to the same active window without new budget.
    pub window_id: Option<Uuid>,
    /// Required for a new window after the first; exact CLOSED predecessor.
    pub predecessor_window_id: Option<Uuid>,
}
impl ExecutionWindowRequest {
    pub fn is_valid(&self) -> bool {
        key(&self.request_key)
            && !self.input_request_key.is_empty()
            && self.input_request_key.len() <= 128
            && !self.input_request_key.chars().any(char::is_control)
            && !self.input_message_id.0.is_nil()
            && !self.input_event_id.0.is_nil()
            && self.expected_generation < 9_007_199_254_740_991
            && self.window_id.is_none_or(|id| !id.is_nil())
            && self.predecessor_window_id.is_none_or(|id| !id.is_nil())
            && !(self.window_id.is_some() && self.predecessor_window_id.is_some())
    }
}
fn key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowStatus {
    pub window_id: Uuid,
    pub conversation_id: ConversationId,
    pub generation: u64,
    pub state: ExecutionWindowState,
    pub input_message_id: MessageId,
    pub input_event_id: EventId,
    pub predecessor_window_id: Option<Uuid>,
    pub opened_at_ms: i64,
    pub work_deadline_ms: i64,
    pub expires_at_ms: i64,
    pub limits: ExecutionWindowLimits,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowAdmission {
    /// Immutable original admission status. Read current status after a retry.
    pub status: ExecutionWindowStatus,
    pub input_message_id: MessageId,
    pub input_event_id: EventId,
    pub input_request_key: String,
    pub request_key: String,
    pub duplicate: bool,
}
