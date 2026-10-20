//! Archived legacy history attached to a native conversation.
//! These rows are display-only provenance. They never become conversation
//! input, events, inbox work, outbox effects or execution authority.
use crate::ConversationId;
use serde::{Deserialize, Serialize};

pub const ARCHIVED_BATCH_MAX: usize = 500;
pub const ARCHIVED_TEXT_MAX: usize = 1024 * 1024;
pub const ARCHIVED_ATTACHMENTS_MAX: usize = 32;
pub const ARCHIVED_PAGE_MAX: u32 = 100;

fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn optional(value: &Option<String>, max: usize) -> bool {
    value
        .as_deref()
        .is_none_or(|v| v.len() <= max && !v.chars().any(char::is_control))
}
fn role(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Content-addressed attachment metadata. Bytes travel in the private bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedAttachment {
    pub name: String,
    /// Lowercase SHA-256 of the copied bytes; empty when unavailable.
    pub sha256: String,
    pub bytes: u64,
    pub media_type: Option<String>,
    pub available: bool,
}
impl ArchivedAttachment {
    pub fn is_valid(&self) -> bool {
        let hash = self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        label(&self.name, 255)
            && optional(&self.media_type, 128)
            && self.bytes <= 1 << 40
            && if self.available {
                hash
            } else {
                self.sha256.is_empty() && self.bytes == 0
            }
    }
}

/// One source message in its original position with exact timestamp strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedMessage {
    pub source_message_id: String,
    pub source_position: i64,
    pub source_cursor: i64,
    pub role: String,
    pub phase: Option<String>,
    pub state: Option<String>,
    pub source_kind: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub text: String,
    pub attachments: Vec<ArchivedAttachment>,
}
impl ArchivedMessage {
    pub fn is_valid(&self) -> bool {
        label(&self.source_message_id, 256)
            && self.source_position > 0
            && self.source_cursor >= 0
            && role(&self.role)
            && [&self.phase, &self.state, &self.source_kind]
                .iter()
                .all(|v| optional(v, 64))
            && optional(&self.created_at, 64)
            && optional(&self.updated_at, 64)
            && self.text.len() <= ARCHIVED_TEXT_MAX
            && self.attachments.len() <= ARCHIVED_ATTACHMENTS_MAX
            && self.attachments.iter().all(ArchivedAttachment::is_valid)
    }
}

/// One ordered batch from a single source thread and snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedImportRequest {
    pub source_instance: String,
    pub source_thread_id: String,
    pub snapshot_id: String,
    pub messages: Vec<ArchivedMessage>,
}
impl ArchivedImportRequest {
    pub fn is_valid(&self) -> bool {
        let mut ids = std::collections::HashSet::new();
        label(&self.source_instance, 200)
            && label(&self.source_thread_id, 200)
            && label(&self.snapshot_id, 200)
            && !self.messages.is_empty()
            && self.messages.len() <= ARCHIVED_BATCH_MAX
            && self.messages.iter().all(ArchivedMessage::is_valid)
            && self
                .messages
                .iter()
                .all(|m| ids.insert(m.source_message_id.as_str()))
            && self
                .messages
                .windows(2)
                .all(|w| w[0].source_position < w[1].source_position)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedQuarantine {
    pub source_message_id: String,
    pub source_position: i64,
    /// `content_changed`, `position_conflict` or `out_of_order`.
    pub reason: String,
}

/// Per-source totals after the batch. `checksum` chains message digests in
/// source position order so producers can verify a complete copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedSourceStatus {
    pub source_instance: String,
    pub source_thread_id: String,
    pub last_snapshot_id: String,
    pub cursor: i64,
    pub message_count: u64,
    pub quarantined: u64,
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedImportReceipt {
    pub conversation_id: ConversationId,
    pub inserted: u32,
    pub duplicates: u32,
    pub quarantined: Vec<ArchivedQuarantine>,
    pub source: ArchivedSourceStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedHistoryStatus {
    pub conversation_id: ConversationId,
    pub sources: Vec<ArchivedSourceStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedEntry {
    /// Archive-local cursor; unrelated to native conversation sequences.
    pub archive_sequence: i64,
    pub source_instance: String,
    pub source_thread_id: String,
    pub snapshot_id: String,
    pub message: ArchivedMessage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedHistoryPage {
    pub conversation_id: ConversationId,
    pub entries: Vec<ArchivedEntry>,
    pub next_after: Option<i64>,
}
