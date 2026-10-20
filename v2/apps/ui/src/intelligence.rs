//! Capability observations describe composition; execution routes authorize each action.
use orkestr_v2_contracts::ConversationId;
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleCapability {
    pub configured: bool,
    pub available: bool,
    pub stop: bool,
    pub steer: bool,
    pub accept: bool,
    pub max_parallel: u32,
}
impl RoleCapability {
    fn valid(&self, max: u32, steer: bool) -> bool {
        if self.configured {
            self.max_parallel == max && self.stop && self.accept && self.steer == steer
        } else {
            !self.available && !self.stop && !self.steer && !self.accept && self.max_parallel == 0
        }
    }
    pub fn label(&self) -> &'static str {
        if !self.configured {
            "Not configured"
        } else if self.available {
            "Available"
        } else {
            "Configured"
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntelligenceCapabilities {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub deep: RoleCapability,
    pub fast: RoleCapability,
    pub worker: RoleCapability,
}
impl IntelligenceCapabilities {
    pub fn valid(&self, conversation: &str) -> bool {
        self.schema_version == 1
            && !self.conversation_id.0.is_nil()
            && self.conversation_id.to_string() == conversation
            && self.deep.valid(1, true)
            && self.fast.valid(1, false)
            && self.worker.valid(4, false)
    }
}
