//! Authenticated discovery observations, never execution authority.
use crate::{ConversationId, ExecutionWindowLimits, ExecutionWindowStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BetaDiscovery {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub provider: BetaProvider,
    pub role: BetaRole,
    pub controls: BetaControls,
    pub limits: ExecutionWindowLimits,
    pub window: Option<ExecutionWindowStatus>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BetaProvider {
    Codex,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BetaRole {
    Deep,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BetaControls {
    pub stop: bool,
    pub steer: bool,
    pub accept: bool,
}
