//! Read-only Worker lineage discovery. IDs and states confer no execution authority.
use crate::{
    runtime::{RunState, SessionRole},
    ConversationId, EventId, MessageId, RunId, SessionId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerRecoveryDisposition {
    /// Current supervisor incarnation; not a claim of process health or readiness.
    CurrentIncarnation,
    /// Blocked or historical incarnation. Never automatically redispatch.
    ReconciliationRequired,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerExecutionSummary {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub parent_run_id: RunId,
    pub parent_session_id: SessionId,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub role: SessionRole,
    pub state: RunState,
    pub control_revision: i64,
    pub recovery: WorkerRecoveryDisposition,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerExecutionPage {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub revision: i64,
    pub observed_at_ms: i64,
    pub workers: Vec<WorkerExecutionSummary>,
    /// Opaque ordering locator only. Each page is a fresh read, not a stable cut.
    pub next_after: Option<RunId>,
}
impl WorkerExecutionPage {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.conversation_id.0.is_nil()
            && self.revision >= 0
            && self.observed_at_ms > 0
            && self.workers.len() <= 100
            && self.workers.iter().all(|w| {
                w.role == SessionRole::Worker
                    && w.control_revision > 0
                    && [
                        &w.run_id.0,
                        &w.session_id.0,
                        &w.parent_run_id.0,
                        &w.parent_session_id.0,
                        &w.source_message_id.0,
                        &w.source_event_id.0,
                    ]
                    .iter()
                    .all(|id| !id.is_nil())
                    && w.run_id != w.parent_run_id
                    && w.session_id != w.parent_session_id
            })
            && self
                .workers
                .windows(2)
                .all(|w| w[0].run_id.to_string() < w[1].run_id.to_string())
            && self
                .next_after
                .as_ref()
                .is_none_or(|id| self.workers.last().is_some_and(|w| &w.run_id == id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_rejects_unknown_shape_and_invalid_authority_free_metadata() {
        let mut page = WorkerExecutionPage {
            schema_version: 1,
            conversation_id: ConversationId(uuid::Uuid::from_u128(1)),
            revision: 0,
            observed_at_ms: 1,
            workers: vec![],
            next_after: None,
        };
        assert!(page.is_valid());
        page.next_after = Some(RunId(uuid::Uuid::from_u128(2)));
        assert!(!page.is_valid());
        page.next_after = None;
        page.schema_version = 2;
        assert!(!page.is_valid());
    }
}
