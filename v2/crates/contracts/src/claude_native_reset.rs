//! An owner decision to lose native continuity while retaining durable history.
use crate::ConversationId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeNativeResetRequest {
    pub request_key: String,
    pub window_id: Uuid,
    pub generation: u64,
    pub acknowledge_native_history_loss: bool,
}
impl ClaudeNativeResetRequest {
    pub fn is_valid(&self) -> bool {
        !self.request_key.is_empty()
            && self.request_key.len() <= 128
            && self
                .request_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
            && !self.window_id.is_nil()
            && self.generation > 0
            && self.generation < 9_007_199_254_740_992
            && self.acknowledge_native_history_loss
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeNativeResetReceipt {
    pub reset_id: Uuid,
    pub conversation_id: ConversationId,
    pub window_id: Uuid,
    pub generation: u64,
    pub reset_at_ms: i64,
}
