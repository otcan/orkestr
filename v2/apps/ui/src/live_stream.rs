//! Live conversation updates: what to do with each stream result, reconnect
//! backoff, and the connection bar shown in the chat.
use crate::{is_replay_item, StreamItem};

/// Window event the Retry button dispatches to wake a waiting reconnect.
pub const RETRY_EVENT: &str = "orkestr-stream-retry";
/// Per-viewer localStorage key: whether the conversation Details drawer is open.
pub const DETAILS_OPEN_KEY: &str = "orkestr.v2.conversationDetailsOpen";

/// Delay before reconnect attempt `failures` (1-based): 1 s doubling to 15 s.
pub fn backoff_ms(failures: u32) -> u32 {
    if failures == 0 {
        return 0;
    }
    (1000_u32 << (failures - 1).min(4)).min(15_000)
}

/// The next step after one stream read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// The sign-in expired; hand over to the session owner.
    Expired,
    /// The cursor is not usable; reload history from the start.
    Resync,
    /// Idle or woken (tab shown, focus, Retry): re-read history after the
    /// cursor so nothing written meanwhile is missed, then reconnect.
    CatchUp,
    /// A journal event: apply history up to it.
    Apply,
    /// The connection failed; back off and reconnect from the cursor.
    Failure,
}

pub fn classify(item: &StreamItem) -> Next {
    if item.status == 401 || item.event == "session_expired" {
        Next::Expired
    } else if item.status == 409 || item.event == "resync_required" {
        Next::Resync
    } else if item.status == 200 && matches!(item.event.as_str(), "idle" | "wake") {
        Next::CatchUp
    } else if item.status == 200 && is_replay_item(item) {
        Next::Apply
    } else {
        Next::Failure
    }
}

/// Connection state shown to the owner.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Connection {
    #[default]
    Connecting,
    Live,
    Reconnecting {
        failures: u32,
    },
}

impl Connection {
    /// Text for the connection bar; `None` hides the bar.
    pub fn bar(&self) -> Option<&'static str> {
        match self {
            Connection::Reconnecting { .. } => Some("Reconnecting…"),
            _ => None,
        }
    }

    pub fn failed(self) -> Self {
        match self {
            Connection::Reconnecting { failures } => Connection::Reconnecting {
                failures: failures.saturating_add(1),
            },
            _ => Connection::Reconnecting { failures: 1 },
        }
    }

    pub fn failures(&self) -> u32 {
        match self {
            Connection::Reconnecting { failures } => *failures,
            _ => 0,
        }
    }
}
