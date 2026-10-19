//! Capability observations only; these fields never grant execution authority.
use crate::ConversationId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntelligenceCapabilities {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub deep: RoleCapability,
    pub fast: RoleCapability,
    pub worker: RoleCapability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleCapability {
    pub configured: bool,
    pub available: bool,
    pub stop: bool,
    pub steer: bool,
    pub accept: bool,
    pub max_parallel: u32,
}

impl IntelligenceCapabilities {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.conversation_id.0.is_nil()
            && self.deep.matches(true, 1)
            && self.fast.matches(false, 1)
            && self.worker.matches(false, 4)
    }
}

impl RoleCapability {
    fn matches(&self, steer: bool, parallel: u32) -> bool {
        if self.configured {
            self.stop && self.accept && self.steer == steer && self.max_parallel == parallel
        } else {
            !self.available && !self.stop && !self.steer && !self.accept && self.max_parallel == 0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capabilities_cannot_claim_available_unconfigured_roles_or_worker_steering() {
        let unavailable = RoleCapability {
            configured: false,
            available: false,
            stop: false,
            steer: false,
            accept: false,
            max_parallel: 0,
        };
        let mut value = IntelligenceCapabilities {
            schema_version: 1,
            conversation_id: ConversationId(uuid::Uuid::new_v4()),
            deep: unavailable.clone(),
            fast: unavailable.clone(),
            worker: unavailable,
        };
        assert!(value.is_valid());
        value.fast.available = true;
        assert!(!value.is_valid());
        value.fast.available = false;
        value.worker = RoleCapability {
            configured: true,
            available: false,
            stop: true,
            steer: false,
            accept: true,
            max_parallel: 4,
        };
        assert!(value.is_valid());
        value.worker.steer = true;
        assert!(!value.is_valid());
        let mut forged = serde_json::to_value(&value).unwrap();
        forged["worker"]["launcher"] = serde_json::json!("caller-selected");
        assert!(serde_json::from_value::<IntelligenceCapabilities>(forged).is_err());
    }
}
