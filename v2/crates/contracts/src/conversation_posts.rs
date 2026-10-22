//! Conversation posts: assistant-side messages written into a conversation
//! from outside any run (an external coordinator session, operator alert
//! tooling). A post never creates an input, never wakes or steers a provider
//! and never starts execution. See `docs/v2/conversation-posts.md`.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Largest post text in UTF-8 bytes.
pub const CONVERSATION_POST_TEXT_MAX: usize = 16_000;
/// Largest display label in bytes.
pub const CONVERSATION_POST_LABEL_MAX: usize = 40;
/// Largest `request_key` in bytes.
pub const CONVERSATION_POST_KEY_MAX: usize = 128;
/// Largest page of a post listing.
pub const CONVERSATION_POST_PAGE_MAX: u16 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationPostAuthor {
    Coordinator,
    Operator,
}
impl ConversationPostAuthor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Coordinator => "coordinator",
            Self::Operator => "operator",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "coordinator" => Some(Self::Coordinator),
            "operator" => Some(Self::Operator),
            _ => None,
        }
    }
    /// The label shown when the request gives none.
    pub fn default_label(self) -> &'static str {
        match self {
            Self::Coordinator => "Coordinator",
            Self::Operator => "Operator",
        }
    }
}

/// `POST /api/v2/conversations/{id}/posts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationPostRequest {
    pub request_key: String,
    pub author: ConversationPostAuthor,
    #[serde(default)]
    pub label: Option<String>,
    pub text: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// A bounded token for the WhatsApp debug footer (`[A-Za-z0-9._:-]{1,64}`).
pub fn valid_post_token(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}
pub fn valid_post_key(value: &str) -> bool {
    (1..=CONVERSATION_POST_KEY_MAX).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}
pub fn valid_post_label(value: &str) -> bool {
    value.len() <= CONVERSATION_POST_LABEL_MAX
        && !value.trim().is_empty()
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
/// Non-empty after trim, at most 16000 bytes, no control characters other
/// than newline, carriage return and tab, and not the bare `NO_REPLY` marker
/// (which the WhatsApp side would treat as "send nothing").
pub fn valid_post_text(value: &str) -> bool {
    value.len() <= CONVERSATION_POST_TEXT_MAX
        && !value.trim().is_empty()
        && value.trim() != "NO_REPLY"
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationPost {
    pub id: Uuid,
    pub conversation_id: crate::ConversationId,
    pub request_key: String,
    pub author: ConversationPostAuthor,
    pub label: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub text: String,
    /// The conversation's latest event sequence when the post was written:
    /// the post is shown after that event.
    pub after_sequence: i64,
    pub created_ms: i64,
    /// When the delivery adapter took it over; `None` while pending.
    pub delivered_ms: Option<i64>,
}
impl ConversationPost {
    pub fn is_valid(&self) -> bool {
        valid_post_key(&self.request_key)
            && valid_post_label(&self.label)
            && valid_post_text(&self.text)
            && self.provider.as_deref().is_none_or(valid_post_token)
            && self.model.as_deref().is_none_or(valid_post_token)
            && self.after_sequence >= 0
            && self.created_ms > 0
    }
}

/// `GET /api/v2/conversations/{id}/posts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationPosts {
    pub conversation_id: crate::ConversationId,
    /// Oldest first.
    pub posts: Vec<ConversationPost>,
}
impl ConversationPosts {
    pub fn is_valid(&self) -> bool {
        self.posts.len() <= usize::from(CONVERSATION_POST_PAGE_MAX)
            && self
                .posts
                .iter()
                .all(|p| p.conversation_id == self.conversation_id && p.is_valid())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_bounds() {
        assert!(valid_post_text("hello\nworld\t!"));
        assert!(!valid_post_text("   "));
        assert!(!valid_post_text(" NO_REPLY "));
        assert!(!valid_post_text("bell\u{7}"));
        assert!(valid_post_text(&"a".repeat(16_000)));
        assert!(!valid_post_text(&"a".repeat(16_001)));
        assert!(valid_post_label("Coordinator"));
        assert!(!valid_post_label(" Coordinator"));
        assert!(!valid_post_label(&"a".repeat(41)));
        assert!(valid_post_token("claude-opus-4.1"));
        assert!(!valid_post_token("has space"));
        assert!(valid_post_key("coord:2026-10-22:1"));
        assert!(!valid_post_key("a/b"));
        assert!(!valid_post_key(""));
    }

    #[test]
    fn request_refuses_unknown_fields_and_authors() {
        let ok: ConversationPostRequest =
            serde_json::from_str(r#"{"request_key":"k","author":"operator","text":"x"}"#).unwrap();
        assert_eq!(ok.author, ConversationPostAuthor::Operator);
        assert!(serde_json::from_str::<ConversationPostRequest>(
            r#"{"request_key":"k","author":"owner","text":"x"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<ConversationPostRequest>(
            r#"{"request_key":"k","author":"operator","text":"x","extra":1}"#
        )
        .is_err());
    }
}
