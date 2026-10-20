//! Read-only owner live map: external views and their attached sessions merged
//! with native conversations. Observation only; nothing here grants execution.
//! Host transcript locations are never part of this contract.
use crate::{
    runtime::RunState, ConversationId, ExecutionPhase, ExecutionWindowState, RunId, SessionId,
    WorkerRecoveryDisposition,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Upper bounds shared by the server validator and browser model.
pub const LIVE_MAP_MAX_VIEWS: usize = 1_000;
pub const LIVE_MAP_MAX_SESSIONS: usize = 500;
pub const LIVE_MAP_MAX_AGENTS: usize = 500;
pub const LIVE_MAP_MAX_TEXT: usize = 512;
pub const LIVE_MAP_MAX_CONVERSATIONS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostLiveMapStatus {
    /// The configured file was read and validated.
    Ready,
    /// Configured, but absent (the generator has not written it yet).
    Missing,
    /// Present but not a readable regular file.
    Unreadable,
    /// Larger than the server cap; never partially parsed.
    TooLarge,
    /// Not JSON, or outside the accepted schema and bounds.
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostLiveMap {
    pub status: HostLiveMapStatus,
    /// Generator timestamp, when present and parseable.
    pub generated_at_ms: Option<i64>,
    /// File modification time; staleness evidence independent of generator clocks.
    pub modified_at_ms: Option<i64>,
    pub views: Vec<LiveView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveDelegation {
    pub remote_backend: Option<String>,
    pub remote_thread_id: Option<String>,
    pub remote_runtime_enabled: Option<bool>,
    /// Set only when the remote thread names a native conversation of this owner.
    pub conversation_id: Option<ConversationId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveAgent {
    pub agent_id: String,
    pub name: Option<String>,
    pub status: String,
    pub started_at_ms: Option<i64>,
    pub last_activity_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveSession {
    pub session_id: String,
    pub kind: String,
    pub role: String,
    pub live: bool,
    pub last_activity_ms: Option<i64>,
    pub agents: Vec<LiveAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveView {
    pub view: String,
    pub name: Option<String>,
    pub chat_id: Option<String>,
    pub thread_id: Option<String>,
    pub fast_layer: Option<String>,
    pub delegated_to_v2: Option<LiveDelegation>,
    pub sessions: Vec<LiveSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveWindow {
    pub window_id: Uuid,
    pub generation: u64,
    pub state: ExecutionWindowState,
    pub opened_at_ms: i64,
    pub work_deadline_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveRole {
    pub run_id: Option<RunId>,
    pub phase: ExecutionPhase,
    pub observed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveWorker {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub parent_run_id: RunId,
    pub state: RunState,
    pub recovery: WorkerRecoveryDisposition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveConversation {
    pub conversation_id: ConversationId,
    pub name: String,
    pub window: Option<LiveWindow>,
    pub fast: Option<LiveRole>,
    pub deep: Option<LiveRole>,
    pub workers: Vec<LiveWorker>,
    /// Some native reads failed; absent fields are unknown, not idle.
    pub partial: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveMap {
    pub schema_version: u32,
    pub observed_at_ms: i64,
    pub host: HostLiveMap,
    pub conversations: Vec<LiveConversation>,
    pub conversations_truncated: bool,
}

impl LiveMap {
    pub fn is_valid(&self) -> bool {
        let text = |s: &str| s.chars().count() <= LIVE_MAP_MAX_TEXT;
        let opt = |s: &Option<String>| s.as_deref().is_none_or(text);
        self.schema_version == 1
            && self.observed_at_ms > 0
            && self.host.views.len() <= LIVE_MAP_MAX_VIEWS
            && (self.host.status == HostLiveMapStatus::Ready || self.host.views.is_empty())
            && self.host.views.iter().all(|v| {
                text(&v.view)
                    && opt(&v.name)
                    && opt(&v.chat_id)
                    && opt(&v.thread_id)
                    && opt(&v.fast_layer)
                    && v.delegated_to_v2
                        .as_ref()
                        .is_none_or(|d| opt(&d.remote_backend) && opt(&d.remote_thread_id))
                    && v.sessions.len() <= LIVE_MAP_MAX_SESSIONS
                    && v.sessions.iter().all(|s| {
                        text(&s.session_id)
                            && text(&s.kind)
                            && text(&s.role)
                            && s.agents.len() <= LIVE_MAP_MAX_AGENTS
                            && s.agents
                                .iter()
                                .all(|a| text(&a.agent_id) && opt(&a.name) && text(&a.status))
                    })
            })
            && self.conversations.len() <= LIVE_MAP_MAX_CONVERSATIONS
            && self
                .conversations
                .iter()
                .all(|c| !c.conversation_id.0.is_nil() && c.workers.len() <= 100)
    }
}
