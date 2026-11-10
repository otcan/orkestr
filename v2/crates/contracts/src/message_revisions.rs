//! An owner's edit or removal of their own earlier message. Each change is a
//! new revision that references the original; nothing is rewritten in place.
use crate::{ConversationId, EventId, MessageId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Longest corrected text; leaves room for the notice wrapped around it.
pub const MESSAGE_REVISION_TEXT_MAX: usize = 28672;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRevisionKind {
    Edit,
    Delete,
}
impl MessageRevisionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::Delete => "delete",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "edit" => Some(Self::Edit),
            "delete" => Some(Self::Delete),
            _ => None,
        }
    }
}

/// Where the owner made the change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRevisionSource {
    #[default]
    Web,
    Whatsapp,
}
impl MessageRevisionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Whatsapp => "whatsapp",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "web" => Some(Self::Web),
            "whatsapp" => Some(Self::Whatsapp),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageRevisionRequest {
    pub request_key: String,
    pub kind: MessageRevisionKind,
    /// The corrected text of an edit. Absent for a removal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub source: MessageRevisionSource,
    /// The revision the caller last saw (0: the original). A mismatch means
    /// another change landed first, and this one is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<i64>,
    /// The change is to one WhatsApp message that was merged with others into
    /// this one. The agent is told, but the merged text stays as shown.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub part: bool,
}
impl MessageRevisionRequest {
    pub fn is_valid(&self) -> bool {
        let key_valid = !self.request_key.is_empty()
            && self.request_key.len() <= 128
            && self
                .request_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b));
        let text_valid = match (self.kind, self.text.as_deref()) {
            (MessageRevisionKind::Edit, Some(text)) => {
                !text.trim().is_empty() && text.len() <= MESSAGE_REVISION_TEXT_MAX
            }
            (MessageRevisionKind::Delete, None) => true,
            _ => false,
        };
        let part_valid = !self.part || self.source == MessageRevisionSource::Whatsapp;
        key_valid && text_valid && part_valid && self.expected_revision.is_none_or(|n| n >= 0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageRevisionReceipt {
    pub revision_id: Uuid,
    pub conversation_id: ConversationId,
    pub message_id: MessageId,
    pub revision: i64,
    pub kind: MessageRevisionKind,
    pub notice_message_id: MessageId,
    pub notice_event_id: EventId,
    pub notice_sequence: i64,
    /// The agent will receive this change as an input in its queue.
    pub agent_notified: bool,
    /// The agent could have read an earlier text of this message.
    pub agent_saw_earlier_text: bool,
    pub created_at_ms: i64,
    pub duplicate: bool,
}

/// The current state of an edited or removed message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRevisionSummary {
    pub revision: i64,
    pub kind: MessageRevisionKind,
    /// The corrected text. Absent once the message is removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub source: MessageRevisionSource,
    pub revised_at_ms: i64,
}

/// Marks a row that exists only to carry a revision to the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRevisionNotice {
    pub target_message_id: MessageId,
    /// The change this row announces, so a client that already shows the
    /// target can update it without re-reading older history.
    pub change: MessageRevisionSummary,
    pub agent_notified: bool,
    pub agent_saw_earlier_text: bool,
    /// It changes one merged source message, so the target's text stays.
    #[serde(default)]
    pub part: bool,
}

/// Revision facts of one snapshot row. `Message.text` stays the immutable
/// original; a client shows `latest` over it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MessageRevisionState {
    /// The server would accept an edit or removal of this message.
    #[serde(default)]
    pub can_revise: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<MessageRevisionSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice_for: Option<MessageRevisionNotice>,
}

/// One change in a message's audit record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageRevisionEntry {
    pub revision_id: Uuid,
    pub revision: i64,
    pub kind: MessageRevisionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub source: MessageRevisionSource,
    pub notice_message_id: MessageId,
    pub agent_notified: bool,
    pub agent_saw_earlier_text: bool,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub part: bool,
}

/// The audit record of one message: the original and every change, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageRevisionHistory {
    pub conversation_id: ConversationId,
    pub message_id: MessageId,
    pub original_text: String,
    pub revisions: Vec<MessageRevisionEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(text: Option<&str>) -> MessageRevisionRequest {
        MessageRevisionRequest {
            request_key: "edit-1".into(),
            kind: MessageRevisionKind::Edit,
            text: text.map(str::to_owned),
            source: MessageRevisionSource::Web,
            expected_revision: None,
            part: false,
        }
    }

    #[test]
    fn an_edit_needs_text_and_a_removal_refuses_it() {
        assert!(edit(Some("corrected")).is_valid());
        assert!(!edit(None).is_valid());
        assert!(!edit(Some("  \n")).is_valid());
        assert!(!edit(Some(&"a".repeat(MESSAGE_REVISION_TEXT_MAX + 1))).is_valid());
        let mut remove = edit(None);
        remove.kind = MessageRevisionKind::Delete;
        assert!(remove.is_valid());
        remove.text = Some("no".into());
        assert!(!remove.is_valid());
    }

    #[test]
    fn only_a_whatsapp_change_can_name_one_merged_part() {
        let mut request = edit(Some("x"));
        request.part = true;
        assert!(!request.is_valid());
        request.source = MessageRevisionSource::Whatsapp;
        assert!(request.is_valid());
    }

    #[test]
    fn keys_and_expected_revisions_are_bounded() {
        let mut request = edit(Some("x"));
        request.request_key = "white space".into();
        assert!(!request.is_valid());
        request.request_key = "k".repeat(129);
        assert!(!request.is_valid());
        request.request_key = "ok:1".into();
        request.expected_revision = Some(-1);
        assert!(!request.is_valid());
        request.expected_revision = Some(0);
        assert!(request.is_valid());
    }

    #[test]
    fn the_source_defaults_to_web_and_unknown_fields_are_refused() {
        let parsed: MessageRevisionRequest =
            serde_json::from_str(r#"{"request_key":"a","kind":"delete"}"#).unwrap();
        assert_eq!(parsed.source, MessageRevisionSource::Web);
        assert!(serde_json::from_str::<MessageRevisionRequest>(
            r#"{"request_key":"a","kind":"delete","owner":"x"}"#
        )
        .is_err());
    }
}
