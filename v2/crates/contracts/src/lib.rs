//! Version 0 HTTP contracts. No storage or provider dependencies.
mod cancellation;
mod held_inputs;
mod worker_tasks;
pub use held_inputs::*;
pub use worker_tasks::*;
mod execution;
mod worker_discovery;
pub use execution::*;
pub use worker_discovery::*;
mod events;
mod production_events;
pub use production_events::*;
mod resource_health;
pub use resource_health::*;
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

mod provider_payload;
pub use provider_payload::*;

mod execution_control;
pub use execution_control::*;
mod execution_stop;
pub use execution_stop::*;

mod execution_acceptance;
pub use execution_acceptance::*;

mod steering;
pub use steering::*;
