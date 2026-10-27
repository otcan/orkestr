//! "New WhatsApp chat" from the Rust UI: a native conversation plus a V1
//! WhatsApp group thread whose runtime is delegated to it through the
//! compatibility adapter. The request carries owner preferences only; group
//! participants, accounts and every credential come from private server
//! configuration and never from the browser.
use crate::{ConversationId, ConversationProvider, ConversationSettingsUpdate};
use serde::{Deserialize, Serialize};

pub const WHATSAPP_CHAT_NAME_MAX: usize = 100;
pub const WHATSAPP_CHAT_WORKSPACE_MAX: usize = 512;
pub const WHATSAPP_CHAT_LIST_MAX: usize = 200;

/// `POST /api/v2/whatsapp-chats`. `client_request_id` is the idempotency key:
/// a retry continues the same chat from its last completed stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WhatsAppChatRequest {
    pub client_request_id: String,
    pub name: String,
    pub provider: ConversationProvider,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Absolute host directory for the chat's work. Recorded as the V1 thread
    /// directory; command execution in it stays operator configuration.
    #[serde(default)]
    pub workspace: Option<String>,
}

fn uuid_text(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}
pub fn whatsapp_chat_name_valid(value: &str) -> bool {
    value == value.trim()
        && !value.is_empty()
        && value.chars().count() <= WHATSAPP_CHAT_NAME_MAX
        && !value.chars().any(char::is_control)
}
pub fn whatsapp_chat_workspace_valid(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= WHATSAPP_CHAT_WORKSPACE_MAX
        && !value.split('/').any(|part| part == ".." || part == ".")
        && !value.chars().any(|c| c.is_control())
}

impl WhatsAppChatRequest {
    /// The conversation settings this request selects (full replacement of
    /// the defaults, so `expected_revision` is 0).
    pub fn settings(&self) -> ConversationSettingsUpdate {
        ConversationSettingsUpdate {
            expected_revision: 0,
            provider: self.provider,
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            honor_no_reply: true,
            reply_prefix: None,
            reply_footer: None,
            review_before_accepting: false,
            deep_grouping: None,
            parallel_deep: None,
        }
    }
    pub fn is_valid(&self) -> bool {
        uuid_text(&self.client_request_id)
            && whatsapp_chat_name_valid(&self.name)
            && self.settings().is_valid()
            && self
                .workspace
                .as_deref()
                .is_none_or(whatsapp_chat_workspace_valid)
    }
}

/// Completed stage of a provision; stages only move forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhatsAppChatStage {
    /// The native conversation exists.
    Conversation,
    /// Provider, model and effort are set.
    Settings,
    /// The V1 thread exists.
    V1Thread,
    /// The WhatsApp group exists and is bound to the V1 thread.
    Group,
    /// The adapter routes the V1 thread to the conversation.
    AdapterBinding,
    /// V1 delegates the thread's runtime to V2. Inbound group messages start
    /// once the operator registers the group with the scoped relay.
    RelayPending,
    /// The relay routes the group: the chat is live.
    Ready,
}
impl WhatsAppChatStage {
    pub const ALL: [Self; 7] = [
        Self::Conversation,
        Self::Settings,
        Self::V1Thread,
        Self::Group,
        Self::AdapterBinding,
        Self::RelayPending,
        Self::Ready,
    ];
    pub fn index(self) -> i64 {
        Self::ALL.iter().position(|s| *s == self).unwrap_or(0) as i64
    }
    pub fn from_index(value: i64) -> Option<Self> {
        usize::try_from(value)
            .ok()
            .and_then(|i| Self::ALL.get(i).copied())
    }
}

/// One "New WhatsApp chat" and how far it got.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WhatsAppChatProvision {
    pub client_request_id: String,
    pub conversation_id: ConversationId,
    pub name: String,
    pub v1_thread_id: String,
    pub remote_thread_id: String,
    pub workspace: Option<String>,
    pub chat_id: Option<String>,
    pub stage: WhatsAppChatStage,
    /// Why the next stage did not complete (a stable code); retry continues.
    pub error: Option<String>,
    pub archived: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}
impl WhatsAppChatProvision {
    pub fn is_valid(&self) -> bool {
        uuid_text(&self.client_request_id)
            && uuid_text(&self.remote_thread_id)
            && whatsapp_chat_name_valid(&self.name)
            && crate::valid_v1_thread_id(&self.v1_thread_id)
            && self.error.as_deref().is_none_or(|e| {
                !e.is_empty() && e.len() <= 64 && e.bytes().all(|b| b.is_ascii_graphic())
            })
            && self
                .chat_id
                .as_deref()
                .is_none_or(|c| !c.is_empty() && c.len() <= 256)
            && (self.stage < WhatsAppChatStage::Group || self.chat_id.is_some())
    }
}

/// `GET /api/v2/whatsapp-chats`: whether the server can create chats, the
/// choices it offers and the owner's provisions, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WhatsAppChatDirectory {
    pub available: bool,
    pub providers: Vec<ConversationProvider>,
    /// How many owner numbers each new group gets (the numbers stay private).
    pub participants: u32,
    pub provisions: Vec<WhatsAppChatProvision>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> WhatsAppChatRequest {
        WhatsAppChatRequest {
            client_request_id: "00000000-0000-4000-8000-000000000001".into(),
            name: "Synthetic chat".into(),
            provider: ConversationProvider::Codex,
            model: Some("synthetic-model".into()),
            reasoning_effort: Some("medium".into()),
            workspace: None,
        }
    }

    #[test]
    fn requests_are_bounded() {
        assert!(request().is_valid());
        let mut bad = request();
        bad.name = " padded".into();
        assert!(!bad.is_valid());
        bad = request();
        bad.reasoning_effort = Some("xhigh".into());
        bad.provider = ConversationProvider::Claude;
        assert!(!bad.is_valid(), "effort must match the provider");
        bad = request();
        bad.workspace = Some("relative/dir".into());
        assert!(!bad.is_valid());
        bad.workspace = Some("/srv/../etc".into());
        assert!(!bad.is_valid());
        bad.workspace = Some("/srv/synthetic".into());
        assert!(bad.is_valid());
        bad = request();
        bad.client_request_id = "00000000-0000-0000-0000-000000000000".into();
        assert!(!bad.is_valid());
        assert!(serde_json::from_str::<WhatsAppChatRequest>(
            r#"{"client_request_id":"00000000-0000-4000-8000-000000000001","name":"x","provider":"codex","participants":["x"]}"#
        )
        .is_err(), "participants never come from the browser");
    }

    #[test]
    fn stages_round_trip_in_order() {
        for (i, stage) in WhatsAppChatStage::ALL.iter().enumerate() {
            assert_eq!(stage.index(), i as i64);
            assert_eq!(WhatsAppChatStage::from_index(i as i64), Some(*stage));
        }
        assert!(WhatsAppChatStage::RelayPending < WhatsAppChatStage::Ready);
        assert_eq!(WhatsAppChatStage::from_index(7), None);
    }
}
