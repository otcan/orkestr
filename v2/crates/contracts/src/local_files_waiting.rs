//! Owner-wide signal of local folder writes waiting for the owner (ORK-804).
//! A write the agent queued is performed only after the owner presses Allow
//! in the one browser tab serving the folder. Every other tab and device of
//! the owner reads this list to say that a write waits and where to act.
//!
//! The replies are read by UI releases that may be older or newer than the
//! server, so these types accept unknown fields: a newer server may add one
//! without breaking an older UI.
use crate::{ConversationId, LOCAL_FILE_NAME_MAX, LOCAL_FILE_OPEN_MAX};
use serde::{Deserialize, Serialize};

/// Server feature (`GET /api/v2/health`) of `GET /api/v2/local-files/waiting`.
pub const LOCAL_FILE_WRITES_WAITING_FEATURE: &str = "local_file_writes_waiting_v1";
/// Conversations listed at most.
pub const LOCAL_FILE_WAITING_MAX: usize = 50;
/// Conversation names are shown cut to this many characters.
pub const LOCAL_FILE_WAITING_NAME_MAX: usize = 300;

fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

/// One conversation with at least one unfinished, unexpired write that waits
/// for the owner, while its folder tab is connected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFileWriteWaiting {
    pub conversation_id: ConversationId,
    /// The conversation's name, for the owner.
    pub conversation_name: String,
    /// The folder name the connected tab reported.
    pub folder_name: String,
    /// Writes waiting in this conversation.
    pub writes: u32,
    /// The earliest deadline of those writes (Unix ms); after it they expire.
    pub deadline_ms: i64,
}
impl LocalFileWriteWaiting {
    pub fn is_valid(&self) -> bool {
        !self.conversation_id.0.is_nil()
            && label(&self.conversation_name, LOCAL_FILE_WAITING_NAME_MAX)
            && label(&self.folder_name, LOCAL_FILE_NAME_MAX)
            && (1..=LOCAL_FILE_OPEN_MAX).contains(&i64::from(self.writes))
            && self.deadline_ms > 0
    }
}

/// `GET /api/v2/local-files/waiting` (owner).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFileWritesWaiting {
    /// Oldest waiting write first.
    pub conversations: Vec<LocalFileWriteWaiting>,
}
impl LocalFileWritesWaiting {
    pub fn is_valid(&self) -> bool {
        let mut seen = std::collections::HashSet::new();
        self.conversations.len() <= LOCAL_FILE_WAITING_MAX
            && self
                .conversations
                .iter()
                .all(|c| c.is_valid() && seen.insert(c.conversation_id.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waiting() -> LocalFileWriteWaiting {
        LocalFileWriteWaiting {
            conversation_id: ConversationId(uuid::Uuid::new_v4()),
            conversation_name: "Synthetic chat".into(),
            folder_name: "Synthetic folder".into(),
            writes: 1,
            deadline_ms: 10,
        }
    }

    #[test]
    fn waiting_writes_are_bounded_display_data() {
        let one = waiting();
        assert!(one.is_valid());
        for bad in [
            LocalFileWriteWaiting {
                conversation_id: ConversationId(uuid::Uuid::nil()),
                ..one.clone()
            },
            LocalFileWriteWaiting {
                conversation_name: " ".into(),
                ..one.clone()
            },
            LocalFileWriteWaiting {
                conversation_name: "x".repeat(LOCAL_FILE_WAITING_NAME_MAX + 1),
                ..one.clone()
            },
            LocalFileWriteWaiting {
                folder_name: "a\nb".into(),
                ..one.clone()
            },
            LocalFileWriteWaiting {
                writes: 0,
                ..one.clone()
            },
            LocalFileWriteWaiting {
                writes: LOCAL_FILE_OPEN_MAX as u32 + 1,
                ..one.clone()
            },
            LocalFileWriteWaiting {
                deadline_ms: 0,
                ..one.clone()
            },
        ] {
            assert!(!bad.is_valid(), "{bad:?}");
        }
        let twice = LocalFileWritesWaiting {
            conversations: vec![one.clone(), one.clone()],
        };
        assert!(!twice.is_valid(), "one entry per conversation");
        let many = LocalFileWritesWaiting {
            conversations: (0..=LOCAL_FILE_WAITING_MAX).map(|_| waiting()).collect(),
        };
        assert!(!many.is_valid());
        assert!(LocalFileWritesWaiting {
            conversations: vec![one]
        }
        .is_valid());
    }

    #[test]
    fn replies_accept_fields_a_newer_server_adds() {
        let id = uuid::Uuid::new_v4();
        let reply: LocalFileWritesWaiting = serde_json::from_str(&format!(
            r#"{{"conversations":[{{"conversation_id":"{id}","conversation_name":"Synthetic chat","folder_name":"Synthetic folder","writes":2,"deadline_ms":5,"later":true}}],"later":1}}"#
        ))
        .unwrap();
        assert!(reply.is_valid());
        assert_eq!(reply.conversations[0].writes, 2);
    }
}
