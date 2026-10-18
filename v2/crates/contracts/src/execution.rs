//! Read-only execution presentation. Capabilities are authority advertisements,
//! never a grant to dispatch, stop or steer. Routes are supplied by server composition.
use crate::{ConversationId, EventId, PayloadId, RunId};
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
pub struct ExecutionAcceptanceCandidate {
    pub run_id: RunId,
    pub completion_event_id: EventId,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionStatus {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub run_id: Option<RunId>,
    /// Monotonic per-conversation durable-state revision, assigned by the store.
    /// observed_at_ms and derived queue_age_ms are read-time samples, excluded
    /// from equal-revision semantic identity; all other fields must match.
    pub revision: i64,
    pub observed_at_ms: i64,
    pub phase: ExecutionPhase,
    /// Exact committed completion and revision from this same read snapshot.
    /// Read evidence only; never an acceptance or provider authority grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_candidate: Option<ExecutionAcceptanceCandidate>,
    pub queue_age_ms: Option<u64>,
    pub progress: Option<ExecutionProgress>,
    pub resources: Option<ExecutionResources>,
    pub capabilities: ExecutionCapabilities,
}
impl ExecutionStatus {
    /// Compare equal-revision durable meaning, excluding only read-time clock
    /// sampling and derived queue age. Call is_valid and scope/auth checks first.
    pub fn same_revision_state(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.conversation_id == other.conversation_id
            && self.run_id == other.run_id
            && self.revision == other.revision
            && self.phase == other.phase
            && self.acceptance_candidate == other.acceptance_candidate
            && self.progress == other.progress
            && self.resources == other.resources
            && self.capabilities == other.capabilities
    }

    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && self.revision >= 0
            && self.observed_at_ms > 0
            && (self.phase == ExecutionPhase::Queued || self.run_id.is_some())
            && self.acceptance_candidate.as_ref().is_none_or(|c| {
                self.phase == ExecutionPhase::AwaitingAcceptance
                    && self.run_id.as_ref() == Some(&c.run_id)
                    && !c.run_id.0.is_nil()
                    && !c.completion_event_id.0.is_nil()
            })
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equal_revision_excludes_only_clock_and_queue_age_samples() {
        let first = ExecutionStatus {
            schema_version: 1,
            conversation_id: ConversationId(uuid::Uuid::from_u128(1)),
            run_id: None,
            revision: 1,
            observed_at_ms: 1000,
            phase: ExecutionPhase::Queued,
            acceptance_candidate: None,
            queue_age_ms: Some(0),
            progress: None,
            resources: None,
            capabilities: ExecutionCapabilities {
                stop: false,
                steer: false,
            },
        };
        let mut sampled = first.clone();
        sampled.observed_at_ms = 2000;
        sampled.queue_age_ms = Some(1000);
        assert!(first.same_revision_state(&sampled));
        sampled.capabilities.stop = true;
        assert!(!first.same_revision_state(&sampled));
        sampled.capabilities.stop = false;
        sampled.phase = ExecutionPhase::Blocked;
        assert!(!first.same_revision_state(&sampled));
    }
}
