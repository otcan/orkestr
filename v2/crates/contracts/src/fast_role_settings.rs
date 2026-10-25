//! Optional Codex Fast-turn overrides, independent of Deep/Worker settings.
use crate::{ConversationId, CODEX_EFFORTS};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FastRoleSettings {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub revision: i64,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub updated_at_ms: Option<i64>,
}
impl FastRoleSettings {
    pub fn defaults(conversation_id: ConversationId) -> Self {
        Self {
            schema_version: 1,
            conversation_id,
            revision: 0,
            model: None,
            reasoning_effort: None,
            updated_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FastRoleSettingsUpdate {
    pub expected_revision: i64,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}
impl FastRoleSettingsUpdate {
    pub fn is_valid(&self) -> bool {
        self.expected_revision >= 0
            && self.model.as_deref().is_none_or(crate::launch_model_valid)
            && self
                .reasoning_effort
                .as_deref()
                .is_none_or(|value| CODEX_EFFORTS.contains(&value))
    }
}
