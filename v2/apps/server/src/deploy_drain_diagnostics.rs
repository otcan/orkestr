//! Bounded operator metadata; observations never decide whether a drain passed.
use orkestr_v2_contracts::ConversationId;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DrainWindowOutcome {
    NoLocalTask,
    LocalTaskNotRunning,
    LocalRolesNotReady,
    CoreSwitchNotReady,
    CoreSwitchUnavailable,
    Retired,
    CustodyReleased,
    RetirementFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DrainWindowDiagnostic {
    pub conversation_id: ConversationId,
    pub window_id: Option<Uuid>,
    pub generation: Option<u64>,
    pub age_ms: Option<i64>,
    pub local_roles_ready: Option<bool>,
    pub core_switch_ready: Option<bool>,
    pub outcome: DrainWindowOutcome,
}
impl DrainWindowDiagnostic {
    pub(crate) fn new(conversation_id: ConversationId) -> Self {
        Self {
            conversation_id,
            window_id: None,
            generation: None,
            age_ms: None,
            local_roles_ready: None,
            core_switch_ready: None,
            outcome: DrainWindowOutcome::NoLocalTask,
        }
    }
}

#[derive(Clone, Default, Debug, PartialEq, Eq, Serialize)]
pub struct DrainDiagnostics {
    pub observed_ms: i64,
    /// The full observed count; at most 64 entries are retained below.
    pub total: usize,
    pub windows: Vec<DrainWindowDiagnostic>,
}
