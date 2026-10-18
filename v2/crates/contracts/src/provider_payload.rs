//! Removable provider text; journal references survive removal.
use crate::{ConversationId, PayloadId, RunId};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderPayload {
    pub payload_id: PayloadId,
    pub conversation_id: ConversationId,
    pub run_id: RunId,
    /// None after explicit removal. Committed retries never restore it.
    pub text: Option<String>,
}
impl std::fmt::Debug for ProviderPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderPayload")
            .field("payload_id", &self.payload_id)
            .field("removed", &self.text.is_none())
            .finish_non_exhaustive()
    }
}
