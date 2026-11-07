//! Secret-free Core observations, never an agent grant or authorization receipt.
use crate::{AgentTimerGrant, AgentTimerLimits};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTimerDiscovery {
    pub grant: AgentTimerGrant,
    pub limits: AgentTimerLimits,
    pub eligible: bool,
    pub running_deep: bool,
    pub recurring_allowed: bool,
}
