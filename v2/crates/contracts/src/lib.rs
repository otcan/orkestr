//! Version 0 HTTP contracts. No storage or provider dependencies.
mod accepted_results;
pub use accepted_results::*;
mod archived_history;
pub use archived_history::*;
mod conversations;
mod live_map;
pub use conversations::*;
pub use live_map::*;
mod conversation_settings;
pub use conversation_settings::*;
mod claude_native_reset;
pub use claude_native_reset::*;
mod calendar_rule;
pub use calendar_rule::*;
mod timer_results;
pub use timer_results::*;
mod desktop_leases;
pub use desktop_leases::*;
mod legacy_workers;
pub use legacy_workers::*;
mod sidebar;
pub use sidebar::*;
mod message_attachments;
pub use message_attachments::*;
mod message_times;
pub use message_times::*;
mod conversation_posts;
pub use conversation_posts::*;
mod restricted;
pub use restricted::*;
mod whatsapp_chats;
pub use whatsapp_chats::*;
mod v1_manage;
pub use v1_manage::*;
mod v1_workers;
pub use v1_workers::*;
mod beta;
pub use beta::*;
mod intelligence;
pub use intelligence::*;
mod cancellation;
mod held_inputs;
pub use held_inputs::*;
mod execution;
mod worker_discovery;
mod worker_tasks;
pub use execution::*;
pub use worker_discovery::*;
pub use worker_tasks::*;
mod events;
mod production_events;
pub use production_events::*;
mod resource_health;
pub use resource_health::*;
mod host_metrics;
pub use host_metrics::*;
mod stopped;
pub use cancellation::*;
pub use stopped::*;
pub mod runtime;
pub use events::*;
use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! id {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub uuid::Uuid);
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { self.0.fmt(f) }
        }
    )+};
}
id!(
    OwnerId,
    ProjectId,
    ConversationId,
    MessageId,
    TaskId,
    RunId,
    SessionId,
    EventId,
    EffectId,
    ApprovalId,
    ResourceId,
    PayloadId
);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Scope {
    Global,
    Project { project_id: ProjectId },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageInput {
    pub client_message_id: String,
    pub text: String,
}
/// The earlier chat message an owner input replied to (WhatsApp "reply"/quote),
/// kept with the input so the quoted context is never lost. `unavailable` marks a
/// quote that could not be resolved; nothing is guessed in that case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplyTo {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub sent_at: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub is_own_reply: bool,
    #[serde(default)]
    pub unavailable: bool,
}
impl ReplyTo {
    pub const TEXT_MAX: usize = 500;
    const FIELD_MAX: usize = 300;
    /// Bounded and non-empty: an empty or oversized quote is refused, not trimmed silently.
    pub fn valid(&self) -> bool {
        let field = |v: &Option<String>| {
            v.as_ref()
                .is_none_or(|s| !s.is_empty() && s.len() <= Self::FIELD_MAX)
        };
        field(&self.message_id)
            && field(&self.author)
            && field(&self.sent_at)
            && self.text.len() <= Self::TEXT_MAX * 4
            && (self.message_id.is_some() || !self.text.is_empty() || self.unavailable)
    }
}
/// `POST /messages` body: the input plus its optional quoted context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageRequest {
    pub client_message_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<ReplyTo>,
}
impl MessageRequest {
    pub fn into_parts(self) -> (MessageInput, Option<ReplyTo>) {
        (
            MessageInput {
                client_message_id: self.client_message_id,
                text: self.text,
            },
            self.reply_to,
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceStatus {
    Accepted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub message_id: MessageId,
    pub event_id: EventId,
    pub sequence: i64,
    pub status: AcceptanceStatus,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectInput {
    pub client_request_id: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceReadiness {
    pub local_git: String,
    pub local_oxrm: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub project_id: ProjectId,
    pub conversation_id: ConversationId,
    pub name: String,
    pub resources: ResourceReadiness,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectPage {
    pub projects: Vec<Project>,
    pub next_cursor: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub message_id: MessageId,
    pub sequence: i64,
    pub actor_kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<ReplyTo>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSnapshot {
    pub conversation_id: ConversationId,
    pub scope: Scope,
    pub messages: Vec<Message>,
    pub last_sequence: i64,
    pub next_cursor: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventEnvelope {
    pub event_id: EventId,
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub scope: Scope,
    pub aggregate_id: ConversationId,
    pub aggregate_version: i64,
    pub sequence: i64,
    pub correlation_id: MessageId,
    pub causation_id: MessageId,
    pub actor_kind: String,
    pub source: String,
    pub occurred_at: String,
    pub payload_ref_or_safe_payload: MessageAccepted,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageAccepted {
    pub kind: String,
    pub message_id: MessageId,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    pub token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub global_conversation_id: ConversationId,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupResponse {
    pub global_conversation_id: ConversationId,
}

mod production_cancellation;
pub use production_cancellation::*;
mod production_stopped;
pub use production_stopped::*;

mod execution_control;
pub use execution_control::*;

mod execution_stop;
pub use execution_stop::*;

mod provider_payload;
pub use provider_payload::*;

mod execution_acceptance;
pub use execution_acceptance::*;

mod history;
pub use history::*;

mod steering;
pub use steering::*;

mod attachments;
pub use attachments::*;

mod attachment_transfer;
pub use attachment_transfer::*;

mod attachment_keys;
pub use attachment_keys::*;

mod browser_session;
pub use browser_session::BrowserSessionProjection;

mod automatic_reply;
pub use automatic_reply::*;

mod memory;
pub use memory::*;

mod execution_window;
pub use execution_window::*;
mod execution_window_queue;
pub use execution_window_queue::*;

mod execution_window_reconciliation;
pub use execution_window_reconciliation::*;
