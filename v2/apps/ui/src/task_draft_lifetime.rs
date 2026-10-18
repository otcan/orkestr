//! App-owned, bounded task drafts. Child component retirement never owns their storage.
use crate::{session_scope::SessionScope, worker_tasks::TaskDraft};
use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationId, RunId};

const MAX_DRAFTS: usize = 128;
struct Entry {
    key: Option<(ConversationId, RunId)>,
    draft: Signal<TaskDraft>,
}
pub struct TaskDrafts {
    owner: ScopeId,
    generation: Option<u64>,
    entries: Vec<Entry>,
}
impl TaskDrafts {
    pub fn new(owner: ScopeId) -> Self {
        Self {
            owner,
            generation: None,
            entries: Vec::new(),
        }
    }
    pub fn activate(&mut self, generation: u64) {
        self.clear_owner();
        self.generation = Some(generation);
    }
    pub fn clear_owner(&mut self) {
        self.generation = None;
        for entry in &mut self.entries {
            entry.draft.set(TaskDraft::default());
            entry.key = None;
        }
    }
    fn open(
        &mut self,
        generation: u64,
        conversation: ConversationId,
        parent: RunId,
    ) -> Option<Signal<TaskDraft>> {
        if self.generation != Some(generation) || conversation.0.is_nil() || parent.0.is_nil() {
            return None;
        }
        let key = (conversation, parent);
        if let Some(entry) = self
            .entries
            .iter()
            .find(|entry| entry.key.as_ref() == Some(&key))
        {
            return Some(entry.draft);
        }
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.key.is_none()) {
            entry.key = Some(key);
            return Some(entry.draft);
        }
        if self.entries.len() >= MAX_DRAFTS {
            return None;
        }
        let draft = Signal::new_in_scope(TaskDraft::default(), self.owner);
        self.entries.push(Entry {
            key: Some(key),
            draft,
        });
        Some(draft)
    }
}

/// Same hook used by the mounted task form and virtual-DOM lifetime regressions.
/// Auth teardown clears every pooled value; slots are reused, never unbounded per login.
pub fn use_task_draft(
    conversation: ConversationId,
    parent: RunId,
    session: Signal<SessionScope>,
) -> Option<Signal<TaskDraft>> {
    let mut drafts = use_context::<Signal<TaskDrafts>>();
    use_hook(move || {
        let generation = session.read().generation();
        session
            .read()
            .is_current(generation)
            .then(|| drafts.write().open(generation, conversation, parent))
            .flatten()
    })
}
