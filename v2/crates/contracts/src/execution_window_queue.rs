//! Durable owner intent waiting for a free execution window slot.
//! A queued entry is never execution authority; Core admission still decides.
use crate::{ConversationId, EventId, MessageId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Most window requests the owner may hold queued across all conversations.
pub const MAX_QUEUED_WINDOW_REQUESTS: u32 = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuedWindowState {
    /// Durably waiting for capacity or for this conversation's earlier work.
    Queued,
    /// Admitted exactly once into the named window.
    Dispatched,
    /// Never admitted; the saved message stays in history and can be resent.
    Withdrawn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuedWindowWithdrawal {
    /// The input was held, consumed or otherwise left the eligible queue.
    InputUnavailable,
    /// The conversation's previous window needs operator reconciliation.
    ReconciliationRequired,
    /// Repeated admission refusal; no window was created for this request.
    AdmissionRefused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowQueued {
    pub conversation_id: ConversationId,
    pub request_key: String,
    pub input_message_id: MessageId,
    pub input_event_id: EventId,
    pub input_request_key: String,
    pub state: QueuedWindowState,
    /// One-based order among all of the owner's queued requests while queued.
    pub position: Option<u32>,
    pub queued_at_ms: i64,
    pub window_id: Option<Uuid>,
    pub withdrawal: Option<QueuedWindowWithdrawal>,
}

/// Owner-wide capacity summary plus the selected conversation's queued entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWindowQueue {
    pub conversation_id: ConversationId,
    pub capacity: u32,
    pub active: u32,
    pub queued_total: u32,
    pub entries: Vec<ExecutionWindowQueued>,
    /// Live host admission view; absent from servers without pressure admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<WindowHostAdmission>,
}

/// Why a new window waits although the safety backstop has room.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostBusyReason {
    /// Linux CPU pressure (PSI "some") is above the admission threshold.
    CpuPressure,
    /// Linux memory pressure (PSI) is above the admission threshold.
    MemoryPressure,
    /// Available memory is below the admission floor.
    MemoryLow,
}

/// Presentation-only snapshot of live host pressure and the window ceiling.
/// It grants nothing; Core admission still decides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowHostAdmission {
    /// PSI cpu "some" avg60, whole percent (0..=100).
    pub cpu_pressure_pct: u32,
    /// PSI memory "some" avg10, whole percent (0..=100).
    pub memory_pressure_pct: u32,
    pub memory_available_mib: u64,
    /// Set when a new interactive (owner) window would wait right now.
    pub interactive_wait: Option<HostBusyReason>,
    /// Set when a new background (timer) window would wait right now.
    pub background_wait: Option<HostBusyReason>,
    /// This conversation's total window lifetime ceiling while work continues.
    pub max_window_ms: i64,
}
impl WindowHostAdmission {
    pub fn is_valid(&self) -> bool {
        self.cpu_pressure_pct <= 100
            && self.memory_pressure_pct <= 100
            && (60_000..=86_400_000).contains(&self.max_window_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_receipt_roundtrips_with_closed_vocabulary() {
        let value = serde_json::json!({
            "conversation_id":"00000000-0000-4000-8000-000000000001",
            "request_key":"synthetic-window","input_message_id":"00000000-0000-4000-8000-000000000002",
            "input_event_id":"00000000-0000-4000-8000-000000000003","input_request_key":"synthetic-input",
            "state":"queued","position":3,"queued_at_ms":1,"window_id":null,"withdrawal":null
        });
        let parsed: ExecutionWindowQueued = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
        let mut unknown = value.clone();
        unknown["authority"] = serde_json::json!("grant");
        assert!(serde_json::from_value::<ExecutionWindowQueued>(unknown).is_err());
        let mut state = value;
        state["state"] = serde_json::json!("running");
        assert!(serde_json::from_value::<ExecutionWindowQueued>(state).is_err());
    }

    #[test]
    fn queue_host_view_is_optional_and_closed() {
        let base = serde_json::json!({
            "conversation_id":"00000000-0000-4000-8000-000000000001",
            "capacity":64,"active":2,"queued_total":0,"entries":[]
        });
        let parsed: ExecutionWindowQueue = serde_json::from_value(base.clone()).unwrap();
        assert!(parsed.host.is_none());
        assert_eq!(serde_json::to_value(&parsed).unwrap(), base);
        let mut with = base.clone();
        with["host"] = serde_json::json!({
            "cpu_pressure_pct":63,"memory_pressure_pct":0,"memory_available_mib":40000,
            "interactive_wait":null,"background_wait":"cpu_pressure","max_window_ms":14_400_000
        });
        let parsed: ExecutionWindowQueue = serde_json::from_value(with.clone()).unwrap();
        let host = parsed.host.clone().unwrap();
        assert!(host.is_valid());
        assert_eq!(host.background_wait, Some(HostBusyReason::CpuPressure));
        assert_eq!(serde_json::to_value(&parsed).unwrap(), with);
        with["host"]["grant"] = serde_json::json!(true);
        assert!(serde_json::from_value::<ExecutionWindowQueue>(with).is_err());
    }
}
