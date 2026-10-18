//! Read-only execution presentation. Capabilities are authority advertisements,
//! never a grant to dispatch, stop or steer. Routes are supplied by server composition.
use crate::{ConversationId, PayloadId, RunId};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPhase {
    Queued,
    Starting,
    Running,
    CancelRequested,
    Cancelled,
    AwaitingAcceptance,
    Completed,
    Failed,
    Blocked,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionCapabilities {
    pub stop: bool,
    pub steer: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionProgress {
    pub payload_id: PayloadId,
    pub observed_at_ms: i64,
}
/// CPU is 0..=1000 permille of the process's allocated CPU capacity, NOT host
/// utilization or unbounded percent-of-one-core. RAM is resident bytes. Samples
/// are optional; absence never means zero usage or a healthy running process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionResources {
    pub cpu_capacity_permille: u16,
    pub resident_bytes: u64,
    pub observed_at_ms: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionStatus {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub run_id: Option<RunId>,
    /// Monotonic per-conversation snapshot revision, assigned by the store.
    pub revision: i64,
    pub observed_at_ms: i64,
    pub phase: ExecutionPhase,
    pub queue_age_ms: Option<u64>,
    pub progress: Option<ExecutionProgress>,
    pub resources: Option<ExecutionResources>,
    pub capabilities: ExecutionCapabilities,
}
impl ExecutionStatus {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && self.revision >= 0
            && self.observed_at_ms > 0
            && (self.phase == ExecutionPhase::Queued || self.run_id.is_some())
            && self
                .progress
                .as_ref()
                .is_none_or(|p| p.observed_at_ms > 0 && p.observed_at_ms <= self.observed_at_ms)
            && self.resources.as_ref().is_none_or(|s| {
                s.cpu_capacity_permille <= 1000
                    && s.observed_at_ms > 0
                    && s.observed_at_ms <= self.observed_at_ms
            })
    }
}
