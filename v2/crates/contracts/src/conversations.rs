//! Native owner conversations. Listing or creating a thread grants no execution.
use crate::{ConversationId, Scope};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationInput {
    pub client_request_id: String,
    pub name: String,
}
impl ConversationInput {
    pub fn is_valid(&self) -> bool {
        !self.client_request_id.is_empty()
            && self.client_request_id.len() <= 128
            && self
                .client_request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
            && !self.name.trim().is_empty()
            && self.name.chars().count() <= 120
            && !self.name.chars().any(char::is_control)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationSummary {
    pub conversation_id: ConversationId,
    pub name: String,
    pub scope: Scope,
    pub last_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationPage {
    pub conversations: Vec<ConversationSummary>,
    pub next_cursor: Option<i64>,
}
