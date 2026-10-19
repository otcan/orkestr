//! Explicit storage consent. None of these values grants execution authority.
use crate::{EventId, OwnerId, ProjectId, TaskId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryScope {
    Owner,
    Project { project_id: ProjectId },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "category", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryContent {
    Preference {
        key: String,
        value: String,
    },
    Fact {
        statement: String,
    },
    Decision {
        summary: String,
        rationale: Option<String>,
    },
    Commitment {
        summary: String,
        task_id: Option<TaskId>,
        due_at_ms: Option<i64>,
    },
    OpenLoop {
        summary: String,
        task_id: Option<TaskId>,
        due_at_ms: Option<i64>,
    },
    ProjectSummary {
        summary: String,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySourceKind {
    Owner,
    Assistant,
    Worker,
    Web,
    Connector,
    Automation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemorySource {
    pub kind: MemorySourceKind,
    pub actor_id: String,
    pub origin: String,
    pub captured_at_ms: i64,
    pub task_id: Option<TaskId>,
    pub event_id: Option<EventId>,
    pub cursor: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryCandidate {
    pub scope: MemoryScope,
    pub content: MemoryContent,
    pub source: MemorySource,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryOperation {
    Create {
        candidate: MemoryCandidate,
    },
    Correct {
        memory_id: Uuid,
        expected_revision: u64,
        candidate: MemoryCandidate,
    },
    Forget {
        memory_id: Uuid,
        expected_revision: u64,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryProposal {
    pub schema_version: u16,
    pub request_key: String,
    pub operation: MemoryOperation,
    pub digest: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryConsentAction {
    Remember,
    Approve,
    Correct,
    Forget,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryOwnerDecision {
    pub action: MemoryConsentAction,
    pub digest: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryTrust {
    OwnerAuthored,
    OwnerConfirmed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryReceipt {
    pub memory_id: Uuid,
    pub revision: u64,
    pub forgotten: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryRecord {
    pub memory_id: Uuid,
    pub owner_id: OwnerId,
    pub revision: u64,
    pub candidate: MemoryCandidate,
    pub trust: MemoryTrust,
    pub consented_at_ms: i64,
    pub updated_at_ms: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryQuery {
    pub project_id: Option<ProjectId>,
    pub query: String,
    pub limit: u16,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryContext {
    pub text: String,
    pub included_ids: Vec<Uuid>,
    pub omitted_count: usize,
}
