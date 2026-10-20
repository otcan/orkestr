//! V1 worker sub-threads ("Parent / Worker N") linked to the V2 conversation
//! their parent moved to. A link is lineage and ownership bookkeeping only:
//! history arrives through archived history (`source_thread_id` = worker id),
//! active work either finishes in V1 or is recreated as a V2 Worker task, and
//! the worker's git worktree has exactly one writer (`v1`, `v2` or none)
//! that changes only by explicit transitions passing through `none`.
use crate::{ConversationId, TaskId};
use serde::{Deserialize, Serialize};

pub const LEGACY_WORKERS_BATCH_MAX: usize = 256;

fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn optional(value: &Option<String>, max: usize) -> bool {
    value.as_deref().is_none_or(|v| label(v, max))
}
fn source_id(value: &str) -> bool {
    (1..=200).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyWorkerSourceState {
    Active,
    Retired,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyWorkerDisposition {
    /// Retired in V1; history only.
    Archived,
    /// Keeps running in V1 until it retires there.
    FinishInV1,
    /// Retired in V1 and continued as a V2 Worker task under the parent.
    RecreateInV2,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeWriter {
    V1,
    V2,
    None,
}

macro_rules! names {
    ($ty:ident { $($v:ident = $s:literal),+ }) => {
        impl $ty {
            pub fn as_str(self) -> &'static str { match self { $(Self::$v => $s),+ } }
            pub fn parse(value: &str) -> Option<Self> { match value { $($s => Some(Self::$v),)+ _ => None } }
        }
    };
}
names!(LegacyWorkerSourceState { Active = "active", Retired = "retired" });
names!(LegacyWorkerDisposition { Archived = "archived", FinishInV1 = "finish_in_v1", RecreateInV2 = "recreate_in_v2" });
names!(WorktreeWriter { V1 = "v1", V2 = "v2", None = "none" });

/// Source facts read from a consistent V1 snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyWorkerRecord {
    pub source_thread_id: String,
    pub source_parent_thread_id: String,
    pub worker_index: Option<u32>,
    pub title: String,
    pub source_state: LegacyWorkerSourceState,
    pub branch: Option<String>,
    /// Absolute path as V1 recorded it; an unavailable reference until claimed.
    pub worktree_path: Option<String>,
}
impl LegacyWorkerRecord {
    pub fn is_valid(&self) -> bool {
        source_id(&self.source_thread_id)
            && source_id(&self.source_parent_thread_id)
            && self.source_thread_id != self.source_parent_thread_id
            && label(&self.title, 300)
            && optional(&self.branch, 255)
            && self
                .worktree_path
                .as_deref()
                .is_none_or(|p| label(p, 1024) && p.starts_with('/') && !p.contains("/../"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyWorkerRegisterRequest {
    pub source_instance: String,
    pub snapshot_id: String,
    pub workers: Vec<LegacyWorkerRecord>,
}
impl LegacyWorkerRegisterRequest {
    pub fn is_valid(&self) -> bool {
        let mut ids = std::collections::HashSet::new();
        label(&self.source_instance, 200)
            && label(&self.snapshot_id, 200)
            && !self.workers.is_empty()
            && self.workers.len() <= LEGACY_WORKERS_BATCH_MAX
            && self
                .workers
                .iter()
                .all(|w| w.is_valid() && ids.insert(w.source_thread_id.as_str()))
            && self
                .workers
                .windows(2)
                .all(|w| w[0].source_parent_thread_id == w[1].source_parent_thread_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyWorkerRegisterOutcome {
    Inserted,
    Updated,
    Unchanged,
    /// Identity changed (parent, index, branch or path) or V1 restored a worker
    /// whose worktree V2 already claimed. Nothing was written for this worker.
    Conflict,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyWorkerRegisterItem {
    pub source_thread_id: String,
    pub outcome: LegacyWorkerRegisterOutcome,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyWorkerRegisterReceipt {
    pub conversation_id: ConversationId,
    pub items: Vec<LegacyWorkerRegisterItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyWorkerLink {
    pub conversation_id: ConversationId,
    pub source_instance: String,
    pub last_snapshot_id: String,
    pub record: LegacyWorkerRecord,
    pub disposition: LegacyWorkerDisposition,
    pub worktree_writer: WorktreeWriter,
    pub v2_task_id: Option<TaskId>,
    /// Messages already present in archived history for this worker.
    pub archived_messages: i64,
    pub revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyWorkerList {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub workers: Vec<LegacyWorkerLink>,
}

/// One explicit transition, guarded by the link revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum LegacyWorkerAction {
    SetDisposition {
        disposition: LegacyWorkerDisposition,
    },
    /// V1 stops being the writer. Requires the worker retired in V1.
    ReleaseV1Worktree,
    /// V2 becomes the only writer. Requires no writer and no other V2 claim
    /// on the same path.
    ClaimV2Worktree,
    ReleaseV2Worktree,
    /// Rollback: hand an unowned worktree back to V1.
    ReturnV1Worktree,
    /// Record the V2 Worker task that continues this worker.
    LinkTask {
        task_id: TaskId,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyWorkerTransition {
    pub source_instance: String,
    pub source_thread_id: String,
    pub expected_revision: i64,
    #[serde(flatten)]
    pub action: LegacyWorkerAction,
}
impl LegacyWorkerTransition {
    pub fn is_valid(&self) -> bool {
        label(&self.source_instance, 200)
            && source_id(&self.source_thread_id)
            && self.expected_revision > 0
            && match &self.action {
                LegacyWorkerAction::LinkTask { task_id } => !task_id.0.is_nil(),
                _ => true,
            }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str) -> LegacyWorkerRecord {
        LegacyWorkerRecord {
            source_thread_id: id.into(),
            source_parent_thread_id: "parent-1".into(),
            worker_index: Some(1),
            title: "Parent / Worker 1".into(),
            source_state: LegacyWorkerSourceState::Active,
            branch: Some("orkestr/parent/w1".into()),
            worktree_path: Some("/srv/example/worktrees/parent-1/w1".into()),
        }
    }
    #[test]
    fn records_and_batches_are_validated() {
        let request = LegacyWorkerRegisterRequest {
            source_instance: "orkestr-v1".into(),
            snapshot_id: "snap-1".into(),
            workers: vec![record("w1"), record("w2")],
        };
        assert!(request.is_valid());
        let mut dup = request.clone();
        dup.workers.push(record("w1"));
        assert!(!dup.is_valid());
        let mut mixed = request.clone();
        mixed.workers[1].source_parent_thread_id = "other".into();
        assert!(!mixed.is_valid());
        let mut relative = record("w3");
        relative.worktree_path = Some("worktrees/w3".into());
        assert!(!relative.is_valid());
        let mut self_parent = record("parent-1");
        self_parent.source_parent_thread_id = "parent-1".into();
        assert!(!self_parent.is_valid());
    }
    #[test]
    fn transitions_serialize_with_action_tag() {
        let t: LegacyWorkerTransition = serde_json::from_value(serde_json::json!({
            "source_instance": "orkestr-v1", "source_thread_id": "w1",
            "expected_revision": 2, "action": "set_disposition", "disposition": "recreate_in_v2"
        }))
        .unwrap();
        assert!(t.is_valid());
        assert_eq!(
            t.action,
            LegacyWorkerAction::SetDisposition {
                disposition: LegacyWorkerDisposition::RecreateInV2
            }
        );
        assert!(
            serde_json::from_value::<LegacyWorkerTransition>(serde_json::json!({
                "source_instance": "orkestr-v1", "source_thread_id": "w1",
                "expected_revision": 2, "action": "force_claim"
            }))
            .is_err()
        );
    }
}
