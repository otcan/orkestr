//! Owner-authored subtask data. No native session or execution authority fields.
use crate::{ConversationId, EventId, MessageId, RunId, TaskId};
use serde::{Deserialize, Serialize};

pub const MAX_WORKER_TASKS_PER_PARENT: usize = 32;
pub const MAX_WORKER_TASK_INSTRUCTIONS: usize = 16_384;
pub const MAX_WORKER_TASK_TITLE: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerTaskCreateRequest {
    pub parent_run_id: RunId,
    pub expected_control_revision: i64,
    pub request_key: String,
    pub title: String,
    pub instructions: String,
    /// Without execution_budget_ms this remains the hard delegation lifetime.
    pub lifetime_ms: u32,
    /// Explicit owner total execution budget; initial leases stay <=30 seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_budget_ms: Option<u32>,
}
impl WorkerTaskCreateRequest {
    pub fn is_valid(&self) -> bool {
        !self.parent_run_id.0.is_nil()
            && self.expected_control_revision > 0
            && !self.request_key.is_empty()
            && self.request_key.len() <= 128
            && self
                .request_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
            && !self.title.trim().is_empty()
            && self.title.len() <= MAX_WORKER_TASK_TITLE
            && !self.title.chars().any(char::is_control)
            && !self.instructions.trim().is_empty()
            && self.instructions.len() <= MAX_WORKER_TASK_INSTRUCTIONS
            && !self.instructions.contains('\0')
            && (1..=30_000).contains(&self.lifetime_ms)
            && self
                .execution_budget_ms
                .is_none_or(|budget| (self.lifetime_ms..=3_600_000).contains(&budget))
    }
}

/// Immutable creation evidence, never a replacement claim or dispatch locator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerTaskReceipt {
    pub schema_version: u32,
    pub task_id: TaskId,
    pub conversation_id: ConversationId,
    pub parent_run_id: RunId,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub created_at_ms: i64,
}
impl WorkerTaskReceipt {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.task_id.0.is_nil()
            && !self.conversation_id.0.is_nil()
            && !self.parent_run_id.0.is_nil()
            && !self.source_message_id.0.is_nil()
            && !self.source_event_id.0.is_nil()
            && self.created_at_ms > 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerTaskPhase {
    Queued,
    /// A one-use claim was issued. This is not evidence of a live executor.
    Claimed,
    Preparing,
    Running,
    AwaitingAcceptance,
    Completed,
    CancelRequested,
    Cancelled,
    Failed,
    Held,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerTaskStatus {
    pub task: WorkerTaskReceipt,
    pub phase: WorkerTaskPhase,
    pub title: Option<String>,
    pub instructions_available: bool,
    pub run_id: Option<RunId>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerTaskList {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub parent_run_id: RunId,
    /// Current owner/parent eligibility. HTTP also requires an owned scheduler.
    /// This observation grants no authority and can change between requests.
    pub can_create: bool,
    pub tasks: Vec<WorkerTaskStatus>,
}
impl WorkerTaskStatus {
    pub fn is_valid(&self) -> bool {
        self.task.is_valid()
            && self.run_id.as_ref().is_none_or(|run| !run.0.is_nil())
            && self.title.as_ref().is_none_or(|title| {
                !title.trim().is_empty()
                    && title.len() <= MAX_WORKER_TASK_TITLE
                    && !title.chars().any(char::is_control)
            })
            && self.title.is_some() == self.instructions_available
            && match self.phase {
                WorkerTaskPhase::Queued | WorkerTaskPhase::Claimed => self.run_id.is_none(),
                WorkerTaskPhase::Held => true,
                _ => self.run_id.is_some(),
            }
    }
}
impl WorkerTaskList {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.conversation_id.0.is_nil()
            && !self.parent_run_id.0.is_nil()
            && self.tasks.len() <= MAX_WORKER_TASKS_PER_PARENT
            && (!self.can_create || self.tasks.len() < MAX_WORKER_TASKS_PER_PARENT)
            && self.tasks.iter().enumerate().all(|(index, task)| {
                task.is_valid()
                    && task.task.conversation_id == self.conversation_id
                    && task.task.parent_run_id == self.parent_run_id
                    && !self.tasks[..index]
                        .iter()
                        .any(|other| other.task.task_id == task.task.task_id)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn instructions_and_control_precondition_are_bounded() {
        let mut request = WorkerTaskCreateRequest {
            parent_run_id: RunId(uuid::Uuid::from_u128(1)),
            expected_control_revision: 1,
            request_key: "task:one".into(),
            title: "Read synthetic input".into(),
            instructions: "Return a short independent summary.\nDo not execute effects.".into(),
            lifetime_ms: 30_000,
            execution_budget_ms: None,
        };
        assert!(request.is_valid());
        request.execution_budget_ms = Some(3_600_000);
        assert!(request.is_valid());
        request.execution_budget_ms = Some(3_600_001);
        assert!(!request.is_valid());
        request.execution_budget_ms = Some(29_999);
        assert!(!request.is_valid());
        request.execution_budget_ms = None;
        request.instructions = "x".repeat(MAX_WORKER_TASK_INSTRUCTIONS + 1);
        assert!(!request.is_valid());
        request.instructions = " ".into();
        assert!(!request.is_valid());
        request.instructions = "bounded".into();
        request.lifetime_ms = 30_001;
        assert!(!request.is_valid());
        request.lifetime_ms = 1;
        request.expected_control_revision = 0;
        assert!(!request.is_valid());
    }
}
