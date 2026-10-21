//! Owner conversation sidebar: native conversations and linked V1 threads in
//! one activity-ordered list. Observation only: a sidebar entry never admits
//! input, starts execution or grants authority. Linked V1 entries accept owner
//! input only through [`V1ThreadInput`], which V1 itself admits and runs.
use crate::ConversationId;
use serde::{Deserialize, Serialize};

pub const SIDEBAR_MAX_ENTRIES: usize = 400;
pub const SIDEBAR_PREVIEW_MAX: usize = 160;
pub const SIDEBAR_NAME_MAX: usize = 300;
pub const SIDEBAR_KEY_MAX: usize = 220;
pub const V1_THREAD_ID_MAX: usize = 200;
pub const V1_HISTORY_MAX: usize = 50;
pub const V1_HISTORY_TEXT_MAX: usize = 16 * 1024;

/// V1 thread identifiers as V1 writes them (`uuid`, hex, `worker-<parent>-<hex>`).
pub fn valid_v1_thread_id(value: &str) -> bool {
    (1..=V1_THREAD_ID_MAX).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

/// Stable entry key: `v2:<conversation uuid>` or `v1:<V1 thread id>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SidebarKey {
    V2(ConversationId),
    V1(String),
}
impl SidebarKey {
    pub fn parse(value: &str) -> Option<Self> {
        if value.len() > SIDEBAR_KEY_MAX {
            return None;
        }
        if let Some(id) = value.strip_prefix("v2:") {
            let id = uuid::Uuid::parse_str(id).ok().filter(|id| !id.is_nil())?;
            // Canonical form only, so one conversation has exactly one key.
            return (id.to_string() == value[3..]).then_some(Self::V2(ConversationId(id)));
        }
        let id = value.strip_prefix("v1:")?;
        valid_v1_thread_id(id).then(|| Self::V1(id.to_owned()))
    }
}
impl std::fmt::Display for SidebarKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::V2(id) => write!(f, "v2:{id}"),
            Self::V1(id) => write!(f, "v1:{id}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidebarSource {
    /// A native V2 conversation (possibly with imported V1 history).
    V2,
    /// A V1 thread that has not moved to V2; shown read-only.
    V1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidebarAuthor {
    Owner,
    Assistant,
    Participant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidebarPreview {
    pub author: SidebarAuthor,
    /// One line, at most `SIDEBAR_PREVIEW_MAX` characters.
    pub text: String,
}
impl SidebarPreview {
    pub fn is_valid(&self) -> bool {
        self.text.chars().count() <= SIDEBAR_PREVIEW_MAX && !self.text.chars().any(char::is_control)
    }
}

/// Live runtime state. Native entries derive it from durable window and run
/// rows (Fast, Deep and Worker roles); V1 entries from V1's thread state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidebarActivity {
    /// A Fast reply is being produced.
    pub fast: bool,
    /// A Deep turn (or a V1 turn) is running or its window is opening.
    pub deep: bool,
    /// Running Worker runs.
    pub workers: u32,
}
impl SidebarActivity {
    pub fn active(&self) -> bool {
        self.fast || self.deep || self.workers > 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidebarEntry {
    /// `v2:<uuid>` or `v1:<thread>`.
    pub key: String,
    pub source: SidebarSource,
    pub name: String,
    pub conversation_id: Option<ConversationId>,
    /// The V1 thread this entry is (V1) or was imported from (V2).
    pub v1_thread_id: Option<String>,
    /// Key of the parent entry for a sub-chat (V1 worker sub-thread).
    pub parent_key: Option<String>,
    pub last_activity_ms: Option<i64>,
    pub preview: Option<SidebarPreview>,
    /// Replies newer than the owner's last view (V1: 0 or 1, a marker only).
    pub unread: u32,
    pub activity: SidebarActivity,
    pub read_only: bool,
    /// A coordinator session (e.g. Claude Code via V1 `api-session`) is attached.
    pub coordinator: bool,
    /// Value to report as read when the owner opens this entry.
    pub read_marker: i64,
}
impl SidebarEntry {
    pub fn is_valid(&self) -> bool {
        let key = SidebarKey::parse(&self.key);
        let identity = match (&key, self.source) {
            (Some(SidebarKey::V2(id)), SidebarSource::V2) => {
                self.conversation_id.as_ref() == Some(id) && !self.read_only
            }
            (Some(SidebarKey::V1(id)), SidebarSource::V1) => {
                self.conversation_id.is_none()
                    && self.v1_thread_id.as_deref() == Some(id.as_str())
                    && self.read_only
            }
            _ => false,
        };
        identity
            && label(&self.name, SIDEBAR_NAME_MAX)
            && self.v1_thread_id.as_deref().is_none_or(valid_v1_thread_id)
            && self
                .parent_key
                .as_deref()
                .is_none_or(|p| p != self.key && SidebarKey::parse(p).is_some())
            && self.last_activity_ms.is_none_or(|t| t > 0)
            && self.preview.as_ref().is_none_or(SidebarPreview::is_valid)
            && self.read_marker >= 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidebarV1Status {
    /// V1 thread registry read (possibly from a short-lived server cache).
    Ready,
    /// No V1 registry client; linked entries come from the host live map only.
    MapOnly,
    /// Neither a V1 client nor a live map is configured.
    Unconfigured,
    /// Configured but unavailable now; native entries are still listed.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidebarPage {
    pub schema_version: u32,
    pub observed_at_ms: i64,
    pub v1_status: SidebarV1Status,
    /// Newest activity first; parents and children are both listed flat.
    pub entries: Vec<SidebarEntry>,
    pub truncated: bool,
}
impl SidebarPage {
    pub fn is_valid(&self) -> bool {
        let mut keys = std::collections::HashSet::new();
        self.schema_version == 1
            && self.observed_at_ms > 0
            && self.entries.len() <= SIDEBAR_MAX_ENTRIES
            && self
                .entries
                .iter()
                .all(|e| e.is_valid() && keys.insert(e.key.as_str()))
    }
}

/// `PUT /api/v2/sidebar/read`: the owner viewed `key` up to `marker`
/// (V2: conversation sequence; V1: message cursor). Marks never move back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidebarReadMark {
    pub key: String,
    pub marker: i64,
}
impl SidebarReadMark {
    pub fn is_valid(&self) -> bool {
        SidebarKey::parse(&self.key).is_some() && self.marker >= 0
    }
}

/// Durable V1 lineage of an imported conversation: the V1 thread it came from
/// and, for a V1 worker sub-thread, the V1 parent thread. Write-once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationLineage {
    pub source_instance: String,
    pub source_thread_id: String,
    pub source_parent_thread_id: Option<String>,
}
impl ConversationLineage {
    pub fn is_valid(&self) -> bool {
        label(&self.source_instance, 200)
            && valid_v1_thread_id(&self.source_thread_id)
            && self
                .source_parent_thread_id
                .as_deref()
                .is_none_or(|p| valid_v1_thread_id(p) && p != self.source_thread_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1HistoryMessage {
    pub message_id: String,
    pub author: SidebarAuthor,
    pub text: String,
    pub created_at_ms: Option<i64>,
    /// V1 `phase` (`commentary`, `final_answer`, …) when present.
    pub phase: Option<String>,
    pub cursor: i64,
    /// Posted by the attached coordinator session (V1 `api-session`).
    #[serde(default)]
    pub coordinator: bool,
}

/// `GET /api/v2/v1-threads/{thread}/messages`: recent read-only V1 history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1HistoryPage {
    pub thread_id: String,
    pub name: String,
    pub coordinator: bool,
    /// Oldest first.
    pub messages: Vec<V1HistoryMessage>,
    /// Pass as `before` to read older messages.
    pub before_cursor: Option<i64>,
    pub latest_cursor: i64,
    /// The owner may post input here (`POST` on the same path). False for a
    /// thread whose runtime is delegated to V2: that one is written to its V2
    /// conversation directly, never through V1.
    #[serde(default)]
    pub writable: bool,
    /// V1 is working on the thread (a turn runs or owner input waits).
    #[serde(default)]
    pub working: bool,
}
impl V1HistoryPage {
    pub fn is_valid(&self) -> bool {
        valid_v1_thread_id(&self.thread_id)
            && label(&self.name, SIDEBAR_NAME_MAX)
            && self.messages.len() <= V1_HISTORY_MAX
            && self.messages.iter().all(|m| {
                label(&m.message_id, 256)
                    && m.text.len() <= V1_HISTORY_TEXT_MAX
                    && m.phase.as_deref().is_none_or(|p| label(p, 64))
                    && m.cursor >= 0
            })
            && self.messages.windows(2).all(|w| w[0].cursor < w[1].cursor)
            && self.before_cursor.is_none_or(|c| c >= 0)
            && self.latest_cursor >= 0
    }
}

pub const V1_INPUT_TEXT_MAX: usize = 16 * 1024;

/// `POST /api/v2/v1-threads/{thread}/messages`: owner input into a linked V1
/// thread, admitted by V1 as web UI input with UI-only reply delivery (the
/// reply is shown here, never sent to the thread's WhatsApp group).
/// `client_message_id` is the idempotency key: a retry with the same key
/// never creates a second input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1ThreadInput {
    pub client_message_id: String,
    pub text: String,
}
impl V1ThreadInput {
    pub fn is_valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.client_message_id)
            .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == self.client_message_id)
            && !self.text.trim().is_empty()
            && self.text.len() <= V1_INPUT_TEXT_MAX
            && !self.text.contains('\0')
    }
}

/// V1's receipt for [`V1ThreadInput`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1ThreadInputReceipt {
    pub thread_id: String,
    pub message_id: String,
    /// V1 already held this key: nothing new was admitted.
    pub duplicate: bool,
    /// V1 message state (`queued`, `running`, `completed`, …).
    pub state: String,
}
impl V1ThreadInputReceipt {
    pub fn is_valid(&self) -> bool {
        valid_v1_thread_id(&self.thread_id)
            && label(&self.message_id, 256)
            && label(&self.state, 64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v1(id: &str) -> SidebarEntry {
        SidebarEntry {
            key: format!("v1:{id}"),
            source: SidebarSource::V1,
            name: "Synthetic group".into(),
            conversation_id: None,
            v1_thread_id: Some(id.into()),
            parent_key: None,
            last_activity_ms: Some(10),
            preview: None,
            unread: 0,
            activity: SidebarActivity::default(),
            read_only: true,
            coordinator: true,
            read_marker: 3,
        }
    }

    #[test]
    fn keys_are_canonical_and_bounded() {
        let id = uuid::Uuid::new_v4();
        assert_eq!(
            SidebarKey::parse(&format!("v2:{id}")),
            Some(SidebarKey::V2(ConversationId(id)))
        );
        assert!(SidebarKey::parse(&format!("v2:{}", id.simple())).is_none());
        assert!(SidebarKey::parse("v2:00000000-0000-0000-0000-000000000000").is_none());
        assert!(SidebarKey::parse("v1:worker-abc-1234").is_some());
        assert!(SidebarKey::parse("v1:../x").is_none());
        assert!(SidebarKey::parse("v1:").is_none());
        assert!(SidebarKey::parse("v3:abc").is_none());
        assert_eq!(
            SidebarKey::V1("t-1".into()).to_string(),
            "v1:t-1".to_string()
        );
    }

    #[test]
    fn linked_v1_entries_are_read_only_and_never_carry_a_conversation() {
        let entry = v1("thread-a");
        assert!(entry.is_valid());
        let mut writable = entry.clone();
        writable.read_only = false;
        assert!(!writable.is_valid());
        let mut native = entry.clone();
        native.conversation_id = Some(ConversationId(uuid::Uuid::new_v4()));
        assert!(!native.is_valid());
        let mut own_parent = entry.clone();
        own_parent.parent_key = Some(entry.key.clone());
        assert!(!own_parent.is_valid());
        let mut long = entry;
        long.preview = Some(SidebarPreview {
            author: SidebarAuthor::Assistant,
            text: "x".repeat(SIDEBAR_PREVIEW_MAX + 1),
        });
        assert!(!long.is_valid());
    }

    #[test]
    fn pages_refuse_duplicate_keys_and_lineage_needs_a_distinct_parent() {
        let page = SidebarPage {
            schema_version: 1,
            observed_at_ms: 1,
            v1_status: SidebarV1Status::Ready,
            entries: vec![v1("a"), v1("a")],
            truncated: false,
        };
        assert!(!page.is_valid());
        let lineage = ConversationLineage {
            source_instance: "synthetic-v1".into(),
            source_thread_id: "child".into(),
            source_parent_thread_id: Some("child".into()),
        };
        assert!(!lineage.is_valid());
        assert!(ConversationLineage {
            source_parent_thread_id: Some("parent".into()),
            ..lineage
        }
        .is_valid());
    }
}
