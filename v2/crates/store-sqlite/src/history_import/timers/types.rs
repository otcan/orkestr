use super::*;

/// Schedule-only provenance: no prompts, paths, routes, native sessions or credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimerSchedule {
    Once {
        due_ms: i64,
    },
    Interval {
        every_ms: i64,
    },
    /// Bounded initial clock support is explicit UTC. No host-time fallback.
    UtcClock {
        weekly: bool,
        minute_of_day: u16,
    },
    /// Local wall clock in an IANA zone. `weekday` (1=Monday..7=Sunday) makes it
    /// weekly. Daylight-saving gaps resolve forward, repeated hours fire once.
    ZonedClock {
        timezone: String,
        weekday: Option<u8>,
        minute_of_day: u16,
    },
    /// Unknown legacy cadence/timezone retained verbatim as bounded schedule metadata.
    Dormant {
        cadence: String,
        timezone: Option<String>,
        time: Option<String>,
        every: Option<String>,
        run_at: Option<String>,
        reason: DormantTimerReason,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DormantTimerReason {
    MissingTimezone,
    UnsupportedTimezone,
    AmbiguousCadence,
    UncertainEffects,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerImportRequest {
    pub namespace: Uuid,
    pub source_namespace: String,
    pub source_timer_id: String,
    pub source_enabled: bool,
    pub schedule: TimerSchedule,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerState {
    Paused,
    Enabled,
    Disabled,
    Stopped,
    RolledBack,
    Exhausted,
}
impl TimerState {
    pub(super) fn parse(value: &str) -> Result<Self> {
        match value {
            "paused" => Ok(Self::Paused),
            "enabled" => Ok(Self::Enabled),
            "disabled" => Ok(Self::Disabled),
            "stopped" => Ok(Self::Stopped),
            "rolled_back" => Ok(Self::RolledBack),
            "exhausted" => Ok(Self::Exhausted),
            _ => Err(HistoryError::Unavailable),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerReceipt {
    pub namespace: Uuid,
    pub source_digest: String,
    pub state: TimerState,
    pub dormant_reason: Option<String>,
    pub revision: i64,
    pub generation: i64,
    pub next_due_ms: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerEnableRequest {
    pub namespace: Uuid,
    pub expected_revision: i64,
    pub request_key: String,
    pub conversation_id: ConversationId,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerControl {
    Disable,
    Stop,
    Rollback,
}
impl TimerControl {
    pub(super) fn values(self) -> (&'static str, &'static str) {
        match self {
            Self::Disable => ("disable", "disabled"),
            Self::Stop => ("stop", "stopped"),
            Self::Rollback => ("rollback", "rolled_back"),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerControlRequest {
    pub namespace: Uuid,
    pub expected_revision: i64,
    pub request_key: String,
    pub action: TimerControl,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerClaimRequest {
    pub namespace: Uuid,
    pub generation: i64,
    pub request_key: String,
    pub due_ms: i64,
}
/// Provenance receipt only; deliberately contains no runtime admission or provider token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerClaimReceipt {
    pub claim_id: Uuid,
    pub namespace: Uuid,
    pub generation: i64,
    pub due_ms: i64,
    pub conversation_id: ConversationId,
    pub source_digest: String,
}
