//! Orkestr v2 event-driven domain starter.
//! In-memory only. No persisted event journal, policies, approvals or real effects.
//! A replay-safe state machine is the narrow first milestone, not an agent runtime.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationKind {
    Home,
    Project,
    Topic,
    Worker,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub kind: ConversationKind,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskState {
    Queued,
    Running { worker_id: String },
    Completed { worker_id: String, summary: String },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub conversation_id: String,
    pub state: TaskState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    ConversationCreated {
        id: String,
        kind: ConversationKind,
        parent_id: Option<String>,
    },
    TaskQueued {
        id: String,
        conversation_id: String,
    },
    TaskStarted {
        task_id: String,
        worker_id: String,
    },
    TaskCompleted {
        task_id: String,
        worker_id: String,
        summary: String,
    },
    TaskCancelled {
        task_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub event_id: String,
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyResult {
    Applied,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyError {
    EmptyIdentifier,
    ConflictingEventId,
    DuplicateEntity,
    MissingParent,
    MissingConversation,
    MissingTask,
    InvalidTransition,
    WorkerMismatch,
}

#[derive(Debug, Default)]
pub struct Engine {
    conversations: HashMap<String, Conversation>,
    tasks: HashMap<String, Task>,
    seen: HashMap<String, Event>,
    journal: Vec<Envelope>,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn conversations(&self) -> &HashMap<String, Conversation> {
        &self.conversations
    }

    pub fn tasks(&self) -> &HashMap<String, Task> {
        &self.tasks
    }

    pub fn journal(&self) -> &[Envelope] {
        &self.journal
    }

    /// Applies an event exactly once per event_id in this in-memory engine.
    /// Durability, DB transactions, outbox, authentication and remote effect
    /// exactly-once semantics are NOT provided by this starter.
    pub fn apply(&mut self, envelope: Envelope) -> Result<ApplyResult, ApplyError> {
        if envelope.event_id.trim().is_empty() {
            return Err(ApplyError::EmptyIdentifier);
        }

        if let Some(previous) = self.seen.get(&envelope.event_id) {
            return if previous == &envelope.event {
                Ok(ApplyResult::Duplicate)
            } else {
                Err(ApplyError::ConflictingEventId)
            };
        }

        match &envelope.event {
            Event::ConversationCreated {
                id,
                kind,
                parent_id,
            } => {
                if id.trim().is_empty() {
                    return Err(ApplyError::EmptyIdentifier);
                }
                if self.conversations.contains_key(id) {
                    return Err(ApplyError::DuplicateEntity);
                }
                if let Some(parent) = parent_id {
                    if !self.conversations.contains_key(parent) {
                        return Err(ApplyError::MissingParent);
                    }
                }
                self.conversations.insert(
                    id.clone(),
                    Conversation {
                        id: id.clone(),
                        kind: kind.clone(),
                        parent_id: parent_id.clone(),
                    },
                );
            }
            Event::TaskQueued { id, conversation_id } => {
                if id.trim().is_empty() || conversation_id.trim().is_empty() {
                    return Err(ApplyError::EmptyIdentifier);
                }
                if self.tasks.contains_key(id) {
                    return Err(ApplyError::DuplicateEntity);
                }
                if !self.conversations.contains_key(conversation_id) {
                    return Err(ApplyError::MissingConversation);
                }
                self.tasks.insert(
                    id.clone(),
                    Task {
                        id: id.clone(),
                        conversation_id: conversation_id.clone(),
                        state: TaskState::Queued,
                    },
                );
            }
            Event::TaskStarted { task_id, worker_id } => {
                if worker_id.trim().is_empty() {
                    return Err(ApplyError::EmptyIdentifier);
                }
                let task = self.tasks.get_mut(task_id).ok_or(ApplyError::MissingTask)?;
                if !matches!(task.state, TaskState::Queued) {
                    return Err(ApplyError::InvalidTransition);
                }
                task.state = TaskState::Running {
                    worker_id: worker_id.clone(),
                };
            }
            Event::TaskCompleted {
                task_id,
                worker_id,
                summary,
            } => {
                let task = self.tasks.get_mut(task_id).ok_or(ApplyError::MissingTask)?;
                match &task.state {
                    TaskState::Running { worker_id: assigned } if assigned != worker_id => {
                        return Err(ApplyError::WorkerMismatch);
                    }
                    TaskState::Running { .. } => {}
                    _ => return Err(ApplyError::InvalidTransition),
                }
                task.state = TaskState::Completed {
                    worker_id: worker_id.clone(),
                    summary: summary.clone(),
                };
            }
            Event::TaskCancelled { task_id } => {
                let task = self.tasks.get_mut(task_id).ok_or(ApplyError::MissingTask)?;
                if !matches!(task.state, TaskState::Queued | TaskState::Running { .. }) {
                    return Err(ApplyError::InvalidTransition);
                }
                task.state = TaskState::Cancelled;
            }
        }

        self.seen
            .insert(envelope.event_id.clone(), envelope.event.clone());
        self.journal.push(envelope);
        Ok(ApplyResult::Applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(event_id: &str, event: Event) -> Envelope {
        Envelope {
            event_id: event_id.to_owned(),
            event,
        }
    }

    fn project(id: &str, parent_id: Option<&str>) -> Event {
        Event::ConversationCreated {
            id: id.to_owned(),
            kind: ConversationKind::Project,
            parent_id: parent_id.map(str::to_owned),
        }
    }

    fn with_project() -> Engine {
        let mut engine = Engine::new();
        engine.apply(event("e1", project("p1", None))).unwrap();
        engine
    }

    #[test]
    fn nested_conversation_requires_existing_parent() {
        let mut engine = Engine::new();
        assert_eq!(
            engine.apply(event("e1", project("child", Some("missing")))),
            Err(ApplyError::MissingParent)
        );
        assert!(engine.journal().is_empty());
        engine.apply(event("e2", project("root", None))).unwrap();
        engine.apply(event("e3", project("child", Some("root")))).unwrap();
        assert_eq!(engine.conversations()["child"].parent_id.as_deref(), Some("root"));
    }

    #[test]
    fn event_id_is_idempotent_but_cannot_change_meaning() {
        let mut engine = Engine::new();
        let first = event("e1", project("p1", None));
        assert_eq!(engine.apply(first.clone()), Ok(ApplyResult::Applied));
        assert_eq!(engine.apply(first), Ok(ApplyResult::Duplicate));
        assert_eq!(
            engine.apply(event("e1", project("p2", None))),
            Err(ApplyError::ConflictingEventId)
        );
        assert_eq!(engine.journal().len(), 1);
    }

    #[test]
    fn running_requires_confirmed_worker_start() {
        let mut engine = with_project();
        engine.apply(event("e2", Event::TaskQueued {
            id: "task".into(),
            conversation_id: "p1".into(),
        })).unwrap();
        assert_eq!(
            engine.apply(event("e3", Event::TaskCompleted {
                task_id: "task".into(),
                worker_id: "w1".into(),
                summary: "unexpected".into(),
            })),
            Err(ApplyError::InvalidTransition)
        );
        assert!(matches!(engine.tasks()["task"].state, TaskState::Queued));
    }

    #[test]
    fn a_different_worker_cannot_complete_claimed_task() {
        let mut engine = with_project();
        engine.apply(event("e2", Event::TaskQueued {
            id: "task".into(),
            conversation_id: "p1".into(),
        })).unwrap();
        engine.apply(event("e3", Event::TaskStarted {
            task_id: "task".into(),
            worker_id: "w1".into(),
        })).unwrap();
        assert_eq!(
            engine.apply(event("e4", Event::TaskCompleted {
                task_id: "task".into(),
                worker_id: "w2".into(),
                summary: "wrong worker".into(),
            })),
            Err(ApplyError::WorkerMismatch)
        );
        assert_eq!(engine.journal().len(), 3);
    }

    #[test]
    fn event_history_replays_to_same_conversation_and_task_state() {
        let mut engine = with_project();
        let changes = [
            event("e2", Event::TaskQueued {
                id: "t1".into(),
                conversation_id: "p1".into(),
            }),
            event("e3", Event::TaskStarted {
                task_id: "t1".into(),
                worker_id: "codex".into(),
            }),
            event("e4", Event::TaskCompleted {
                task_id: "t1".into(),
                worker_id: "codex".into(),
                summary: "completed".into(),
            }),
        ];
        for change in changes {
            engine.apply(change).unwrap();
        }
        let mut replayed = Engine::new();
        for record in engine.journal().to_vec() {
            replayed.apply(record).unwrap();
        }
        assert_eq!(engine.tasks(), replayed.tasks());
        assert_eq!(engine.conversations(), replayed.conversations());
    }

    #[test]
    fn cancelled_task_cannot_be_restarted() {
        let mut engine = with_project();
        engine.apply(event("e2", Event::TaskQueued {
            id: "task".into(),
            conversation_id: "p1".into(),
        })).unwrap();
        engine.apply(event("e3", Event::TaskCancelled { task_id: "task".into() })).unwrap();
        assert_eq!(
            engine.apply(event("e4", Event::TaskStarted {
                task_id: "task".into(),
                worker_id: "w1".into(),
            })),
            Err(ApplyError::InvalidTransition)
        );
    }
}
