//! Owner API only: clocks, generation and claims are never deserialized.
use orkestr_v2_contracts::ConversationId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Enable {
    pub expected_revision: i64,
    pub request_key: String,
    pub conversation_id: ConversationId,
    pub text: String,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Disable,
    Stop,
    Rollback,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    pub expected_revision: i64,
    pub request_key: String,
    pub action: Action,
}
#[derive(Serialize)]
pub struct Detail {
    pub namespace: Uuid,
    pub source_digest: String,
    pub schedule: Schedule,
    pub conversation_id: Option<ConversationId>,
    pub state: &'static str,
    pub dormant_reason: Option<String>,
    pub revision: i64,
    pub generation: i64,
    pub next_due_ms: Option<i64>,
    pub controller_armed: bool,
    pub controller_hold: Option<&'static str>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Read {}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    Once { due_ms: i64 },
    Interval { every_ms: i64 },
    UtcClock { weekly: bool, minute_of_day: u16 },
    Dormant,
}
