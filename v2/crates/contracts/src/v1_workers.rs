//! `GET /api/v2/conversations/{id}/v1-workers`: the V1 worker sub-threads of
//! the V1 thread a conversation is linked to (imported from, or delegated to
//! it), for the conversation's Work tab. Observation only: listing a worker
//! never admits input, starts execution or grants authority. V1 stays the
//! authority for these threads.
use crate::{valid_v1_thread_id, ConversationId, SidebarPreview, SidebarV1Status};
use serde::{Deserialize, Serialize};

/// Workers per page. Active workers come first, so a cut drops retired ones.
pub const V1_WORKERS_MAX: usize = 32;
/// Nesting levels below the linked thread (the sidebar's parent-chain bound).
pub const V1_WORKERS_DEPTH: u32 = 8;
/// Worker names are shortened for this list.
pub const V1_WORKER_NAME_MAX: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V1WorkerState {
    /// V1 reports a running turn.
    Working,
    Idle,
    /// Retired in V1; history only.
    Retired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1WorkerEntry {
    pub thread_id: String,
    pub name: String,
    /// The V1 thread it hangs under: the linked thread or another worker.
    pub parent_thread_id: String,
    /// 1 for a direct child of the linked thread.
    pub depth: u32,
    pub state: V1WorkerState,
    pub last_activity_ms: Option<i64>,
    /// The sidebar's cached preview, when one was already read. Never read
    /// from V1 for this list.
    pub preview: Option<SidebarPreview>,
    /// The sidebar lists it, so `#v1/<thread_id>` opens it.
    pub openable: bool,
    /// The worker was itself imported into this V2 conversation.
    pub conversation_id: Option<ConversationId>,
}
impl V1WorkerEntry {
    pub fn is_valid(&self) -> bool {
        valid_v1_thread_id(&self.thread_id)
            && valid_v1_thread_id(&self.parent_thread_id)
            && self.parent_thread_id != self.thread_id
            && !self.name.trim().is_empty()
            && self.name.chars().count() <= V1_WORKER_NAME_MAX
            && !self.name.chars().any(char::is_control)
            && (1..=V1_WORKERS_DEPTH).contains(&self.depth)
            && self.last_activity_ms.is_none_or(|t| t > 0)
            && self.preview.as_ref().is_none_or(SidebarPreview::is_valid)
            && self.conversation_id.as_ref().is_none_or(|c| !c.0.is_nil())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1WorkersPage {
    pub schema_version: u32,
    pub observed_at_ms: i64,
    pub conversation_id: ConversationId,
    /// The V1 thread this conversation is linked to; `None`: not linked.
    pub v1_thread_id: Option<String>,
    pub v1_status: SidebarV1Status,
    /// Active workers (newest activity first), then retired ones.
    pub workers: Vec<V1WorkerEntry>,
    /// Retired workers found, including any cut by the bound.
    pub retired: u32,
    pub truncated: bool,
}
impl V1WorkersPage {
    pub fn is_valid(&self) -> bool {
        let mut ids = std::collections::HashSet::new();
        self.schema_version == 1
            && self.observed_at_ms > 0
            && !self.conversation_id.0.is_nil()
            && self.v1_thread_id.as_deref().is_none_or(valid_v1_thread_id)
            && (self.v1_thread_id.is_some() || self.workers.is_empty())
            && self.workers.len() <= V1_WORKERS_MAX
            && self.workers.iter().all(|w| {
                w.is_valid()
                    && self.v1_thread_id.as_deref() != Some(w.thread_id.as_str())
                    && ids.insert(w.thread_id.as_str())
            })
            && self
                .workers
                .iter()
                .filter(|w| w.state == V1WorkerState::Retired)
                .count()
                <= self.retired as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker(id: &str) -> V1WorkerEntry {
        V1WorkerEntry {
            thread_id: id.into(),
            name: "Synthetic worker".into(),
            parent_thread_id: "synthetic-group".into(),
            depth: 1,
            state: V1WorkerState::Idle,
            last_activity_ms: Some(1),
            preview: None,
            openable: true,
            conversation_id: None,
        }
    }

    #[test]
    fn pages_are_bounded_unique_and_never_list_the_linked_thread() {
        let mut page = V1WorkersPage {
            schema_version: 1,
            observed_at_ms: 1,
            conversation_id: ConversationId(uuid::Uuid::from_u128(1)),
            v1_thread_id: Some("synthetic-group".into()),
            v1_status: SidebarV1Status::Ready,
            workers: vec![worker("worker-synthetic-group-1")],
            retired: 0,
            truncated: false,
        };
        assert!(page.is_valid());
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["workers"][0]["state"], "idle");
        assert_eq!(serde_json::from_value::<V1WorkersPage>(json).unwrap(), page);
        page.workers.push(worker("worker-synthetic-group-1"));
        assert!(!page.is_valid(), "duplicate");
        page.workers[1] = worker("synthetic-group");
        assert!(!page.is_valid(), "the linked thread itself");
        page.workers[1] = worker("worker-synthetic-group-2");
        page.workers[1].state = V1WorkerState::Retired;
        assert!(!page.is_valid(), "retired count");
        page.retired = 1;
        assert!(page.is_valid());
        page.workers[1].depth = V1_WORKERS_DEPTH + 1;
        assert!(!page.is_valid(), "depth bound");
        page.workers[1].depth = 2;
        page.v1_thread_id = None;
        assert!(!page.is_valid(), "workers without a linked thread");
    }
}
