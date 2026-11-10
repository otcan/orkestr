//! Owner-wide public desk inventory; no tokens, profile paths or endpoints.
use crate::ConversationId;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopResource {
    pub slug: String,
    pub label: String,
    pub state: String,
    pub lease_state: String,
    pub holder: Option<String>,
    pub expires_at: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopResourceBinding {
    pub conversation_id: ConversationId,
    pub name: String,
    pub desktop_slugs: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopInventory {
    pub schema_version: u32,
    pub resources: Vec<DesktopResource>,
    pub bindings: Vec<DesktopResourceBinding>,
    pub observed_at_ms: i64,
}

/// What a desk's reported runtime state allows. V1 reports `active`, `running`,
/// `inactive`, `failed`, `partial` and a few others; anything unrecognised is
/// `Indeterminate` and never counts as either running or stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopRuntime {
    Running,
    Stopped,
    /// Some units are up or failed: Start repairs it, Stop clears it.
    Partial,
    Indeterminate,
}
impl DesktopRuntime {
    pub fn from_state(state: &str) -> Self {
        match state.trim().to_ascii_lowercase().as_str() {
            "running" | "active" | "open" => Self::Running,
            "inactive" | "stopped" | "closed" | "exited" | "prepared" => Self::Stopped,
            "partial" | "failed" => Self::Partial,
            _ => Self::Indeterminate,
        }
    }
    /// Starting a running desk can trigger a degraded-state repair, so Start
    /// is limited to desks that are actually down or incomplete.
    pub fn can_start(self) -> bool {
        matches!(self, Self::Stopped | Self::Partial)
    }
    pub fn can_stop(self) -> bool {
        !matches!(self, Self::Stopped)
    }
    /// V1 only shares a desk that is up.
    pub fn can_link(self) -> bool {
        matches!(self, Self::Running)
    }
}

/// Stop needs an explicit confirmation unless the desk is known to be free
/// and its runtime state is known. An unverified desk may be in use.
pub fn stop_needs_confirmation(lease_state: &str, runtime: DesktopRuntime) -> bool {
    lease_state != "unreserved" || runtime == DesktopRuntime::Indeterminate
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrecognised_runtime_states_are_never_running_or_stopped() {
        for state in ["active", "running", "open", " ACTIVE "] {
            assert_eq!(DesktopRuntime::from_state(state), DesktopRuntime::Running);
        }
        for state in ["inactive", "stopped", "closed", "exited", "prepared"] {
            assert_eq!(DesktopRuntime::from_state(state), DesktopRuntime::Stopped);
        }
        for state in ["partial", "failed"] {
            assert_eq!(DesktopRuntime::from_state(state), DesktopRuntime::Partial);
        }
        for state in ["unknown", "", "future-state"] {
            let runtime = DesktopRuntime::from_state(state);
            assert_eq!(runtime, DesktopRuntime::Indeterminate);
            assert!(!runtime.can_start() && !runtime.can_link() && runtime.can_stop());
        }
    }
    #[test]
    fn actions_follow_the_runtime() {
        let actions = |r: DesktopRuntime| (r.can_start(), r.can_stop(), r.can_link());
        assert_eq!(actions(DesktopRuntime::Running), (false, true, true));
        assert_eq!(actions(DesktopRuntime::Stopped), (true, false, false));
        assert_eq!(actions(DesktopRuntime::Partial), (true, true, false));
    }
    #[test]
    fn only_a_known_free_desk_stops_without_confirmation() {
        assert!(!stop_needs_confirmation(
            "unreserved",
            DesktopRuntime::Running
        ));
        assert!(stop_needs_confirmation(
            "unreserved",
            DesktopRuntime::Indeterminate
        ));
        for lease in ["reserved", "stale", "expired", "unknown", ""] {
            assert!(stop_needs_confirmation(lease, DesktopRuntime::Running));
        }
    }
}
