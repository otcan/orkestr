//! Authenticated browser session read projection; never an authority input.
use crate::{ConversationId, OwnerId};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
pub struct BrowserSessionProjection {
    pub owner_id: OwnerId,
    pub csrf_token: String,
    pub global_conversation_id: ConversationId,
}
