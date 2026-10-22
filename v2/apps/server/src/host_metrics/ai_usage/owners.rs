//! Who a session's tokens belong to. Resolved at request time from what the
//! owner can see: V2 runs (native session → conversation), the V1 thread
//! registry (Codex thread id and workspace), the operator's live map
//! (sessions attached to a thread and their agents) and, last, the
//! session's working directory. Paths are compared here and never returned.
use super::ledger::Session;
use orkestr_v2_contracts::{AiOwnerKind, AiProvider, AI_USAGE_MAX_LABEL};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Owner {
    pub key: String,
    pub kind: AiOwnerKind,
    pub label: String,
    pub link: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Thread {
    pub id: String,
    pub name: String,
    pub codex_thread_id: Option<String>,
    pub workspace: Option<String>,
    /// The V2 conversation the thread runs in (delegated or migrated).
    pub conversation: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Directory {
    /// Native provider session id → (conversation id, role).
    pub runs: HashMap<String, (String, String)>,
    /// Conversation id → name.
    pub names: HashMap<String, String>,
    pub threads: Vec<Thread>,
    /// Live-map session id → thread id.
    pub attached: HashMap<String, String>,
    /// Sources whose otherwise unclaimed sessions are coordinators.
    pub coordinator_sources: Vec<bool>,
}

fn clip(label: String) -> String {
    label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(AI_USAGE_MAX_LABEL)
        .collect()
}

fn short(id: &str) -> &str {
    let id = id.trim_start_matches("agent:");
    &id[..id.len().min(8)]
}

impl Directory {
    fn conversation(&self, id: &str, role: Option<String>) -> Owner {
        let label = self
            .names
            .get(id)
            .cloned()
            .unwrap_or_else(|| format!("Conversation {}", short(id)));
        Owner {
            key: format!("conversation:{id}"),
            kind: AiOwnerKind::Conversation,
            label: clip(label),
            link: Some(format!("#conversation/{id}")),
            role,
        }
    }

    fn thread(&self, thread: &Thread) -> Owner {
        match &thread.conversation {
            Some(id) => self.conversation(id, None),
            None => Owner {
                key: format!("thread:{}", thread.id),
                kind: AiOwnerKind::Thread,
                label: clip(thread.name.clone()),
                link: Some(format!("#v1/{}", thread.id)),
                role: None,
            },
        }
    }

    fn thread_by_id(&self, id: &str) -> Option<&Thread> {
        self.threads.iter().find(|t| t.id == id)
    }

    fn thread_by_dir(&self, cwd: &str) -> Option<&Thread> {
        let cwd = cwd.trim_end_matches('/');
        self.threads
            .iter()
            .filter(|t| {
                t.workspace.as_deref().is_some_and(|w| {
                    let w = w.trim_end_matches('/');
                    !w.is_empty() && (cwd == w || cwd.starts_with(&format!("{w}/")))
                })
            })
            .max_by_key(|t| t.workspace.as_ref().map_or(0, |w| w.len()))
    }

    /// The owner of `session`; `find` looks up a parent session.
    pub fn resolve(&self, session: &Session, find: &dyn Fn(AiProvider, &str) -> Option<Session>) -> Owner {
        self.resolve_at(session, find, 0)
    }

    fn resolve_at(
        &self,
        session: &Session,
        find: &dyn Fn(AiProvider, &str) -> Option<Session>,
        depth: usize,
    ) -> Owner {
        // Helper agents: grouped under the session that started them.
        if let (Some(parent), true) = (&session.parent, depth < 4) {
            if session.agent.is_some() || session.id.starts_with("agent:") {
                let parent_owner = match find(session.provider, parent) {
                    Some(p) => self.resolve_at(&p, find, depth + 1),
                    None => self.direct(&Session {
                        id: parent.clone(),
                        parent: None,
                        agent: None,
                        ..session.clone()
                    }),
                };
                let base = parent_owner.key.trim_start_matches("agents:").to_owned();
                return Owner {
                    key: format!("agents:{base}"),
                    kind: AiOwnerKind::Agent,
                    label: clip(format!("Helper agents of {}", parent_owner.label)),
                    link: parent_owner.link,
                    role: None,
                };
            }
            // A fork continues its parent's work.
            if let Some(p) = find(session.provider, parent) {
                let mut owner = self.resolve_at(&p, find, depth + 1);
                if owner.kind != AiOwnerKind::Other {
                    owner.role = owner.role.or(Some("fork".into()));
                    return owner;
                }
            }
        }
        self.direct(session)
    }

    fn direct(&self, session: &Session) -> Owner {
        if let Some((conversation, role)) = self.runs.get(&session.id) {
            return self.conversation(conversation, Some(role.clone()));
        }
        if let Some(thread) = self.attached.get(&session.id) {
            let thread = self.thread_by_id(thread).cloned().unwrap_or(Thread {
                id: thread.clone(),
                name: format!("Thread {}", short(thread)),
                ..Default::default()
            });
            if session.provider == AiProvider::Claude {
                let base = self.thread(&thread);
                return Owner {
                    key: format!("coordinator:{}", thread.id),
                    kind: AiOwnerKind::Coordinator,
                    label: clip(format!("Coordinator of {}", base.label)),
                    link: base.link,
                    role: Some("coordinator".into()),
                };
            }
            return self.thread(&thread);
        }
        if let Some(thread) = self
            .threads
            .iter()
            .find(|t| t.codex_thread_id.as_deref() == Some(session.id.as_str()))
        {
            return self.thread(thread);
        }
        if let Some(cwd) = session.cwd.as_deref() {
            if let Some(thread) = self.thread_by_dir(cwd) {
                return self.thread(thread);
            }
            if let Some(dir) = super::super::consumers::workspace(cwd) {
                return Owner {
                    key: format!("workspace:{dir}"),
                    kind: AiOwnerKind::Thread,
                    label: clip(format!("Workspace {dir}")),
                    link: None,
                    role: None,
                };
            }
        }
        let coordinator = self
            .coordinator_sources
            .get(session.source as usize)
            .copied()
            .unwrap_or(false);
        if coordinator && session.provider == AiProvider::Claude {
            return Owner {
                key: format!("session:claude:{}", session.id),
                kind: AiOwnerKind::Coordinator,
                label: format!("Claude Code session {}", short(&session.id)),
                link: None,
                role: Some("coordinator".into()),
            };
        }
        Owner {
            key: format!("session:{}:{}", session.provider.label(), session.id),
            kind: AiOwnerKind::Other,
            label: format!("{} session {}", session.provider.label(), short(&session.id)),
            link: None,
            role: None,
        }
    }
}
