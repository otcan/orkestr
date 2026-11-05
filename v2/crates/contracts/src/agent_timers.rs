//! Agent-facing timers (TASK-52). A running Deep turn of a conversation holds
//! that conversation's owner-issued agent-timer grant and may list, create,
//! cancel, pause, resume and skip timers of that same conversation only. The
//! conversation always comes from the grant, never from a request field, so
//! no timer created or changed here can fire into another conversation.
//! Fast never gets this tool (it is read-only and the grant needs a running
//! Deep turn).
use crate::{CalendarRule, ConversationId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Header carrying a per-conversation agent-timer grant (64 lowercase hex).
pub const AGENT_TIMER_GRANT_HEADER: &str = "x-orkestr-agent-timer-grant";
/// The instruction every run of the timer receives.
pub const AGENT_TIMER_TEXT_MAX: usize = 8_000;
pub const AGENT_TIMER_LABEL_MAX: usize = 120;
/// At most this many live (enabled or paused, not exhausted, cancelled or
/// stopped) agent-created timers per conversation.
pub const AGENT_TIMER_ACTIVE_MAX: i64 = 32;
/// At most this many timers created (or moved by an upsert) by agents per
/// conversation per hour. Not configurable: it keeps agent loops slow.
pub const AGENT_TIMER_HOURLY_CREATES_MAX: i64 = 12;
/// Default rolling 24-hour create cap of a conversation with other
/// participants (and of any conversation not marked owner-only). The server
/// default comes from `ORKESTR_V2_AGENT_TIMER_DAILY_CREATES_MAX`.
pub const AGENT_TIMER_DAILY_CREATES_MAX: i64 = 24;
/// Default rolling 24-hour create cap of a conversation the owner marked
/// owner-only (`ORKESTR_V2_AGENT_TIMER_OWNER_ONLY_DAILY_CREATES_MAX`).
pub const AGENT_TIMER_OWNER_ONLY_DAILY_CREATES_MAX: i64 = 200;
/// Largest configurable daily create cap (a larger need is `off`).
pub const AGENT_TIMER_DAILY_CREATES_LIMIT: i64 = 10_000;
/// A one-shot timer must be at least this far in the future.
pub const AGENT_TIMER_MIN_LEAD_MS: i64 = 2 * 60_000;
/// ... and at most this far (400 days).
pub const AGENT_TIMER_MAX_HORIZON_MS: i64 = 400 * 86_400_000;
/// A recurring timer never runs more often than this.
pub const AGENT_TIMER_MIN_INTERVAL_MS: i64 = 30 * 60_000;
/// An agent pause lasts at most this long (60 days); the owner can pause longer.
pub const AGENT_TIMER_MAX_PAUSE_MS: i64 = 60 * 86_400_000;
/// Refused attempts per conversation per 10 minutes that are audited;
/// beyond this, attempts are refused without any write.
pub const AGENT_TIMER_REFUSALS_MAX: i64 = 20;

fn key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTimerGrant {
    pub conversation_id: ConversationId,
    pub issued: bool,
    pub generation: i64,
}
/// Returned once at issue; only its hash is stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTimerGrantIssued {
    pub grant: String,
    pub binding: AgentTimerGrant,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTimerGrantEntry {
    pub conversation_id: ConversationId,
    pub name: String,
    /// False for a restricted or archived conversation.
    pub eligible: bool,
    pub grant: AgentTimerGrant,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTimerGrantDirectory {
    pub conversations: Vec<AgentTimerGrantEntry>,
}

/// What an agent may schedule: one run at an instant, or a calendar rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentTimerSchedule {
    Once {
        due_ms: i64,
    },
    Calendar {
        timezone: String,
        #[serde(default)]
        weekdays: Vec<u8>,
        start_minute: u16,
        end_minute: u16,
        #[serde(default = "one")]
        every_hours: u8,
        minutes: Vec<u8>,
    },
}
fn one() -> u8 {
    1
}
impl AgentTimerSchedule {
    pub fn calendar_rule(&self) -> Option<CalendarRule> {
        match self {
            Self::Once { .. } => None,
            Self::Calendar {
                timezone,
                weekdays,
                start_minute,
                end_minute,
                every_hours,
                minutes,
            } => Some(CalendarRule {
                timezone: timezone.clone(),
                weekdays: weekdays.clone(),
                start_minute: *start_minute,
                end_minute: *end_minute,
                every_hours: *every_hours,
                minutes: minutes.clone(),
            }),
        }
    }
}

/// Also the body of an upsert (`POST .../agent-timers/upsert`): the newest
/// enabled or fired-one-shot agent timer of this conversation with the same
/// label is moved to the new schedule and text instead of creating another
/// one; only without such a timer is a new one created (and counted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTimerCreate {
    /// Idempotency key, unique per conversation: the same key with the same
    /// body is the same timer (a replay), with another body a conflict.
    pub request_key: String,
    pub label: String,
    pub schedule: AgentTimerSchedule,
    pub text: String,
}
impl AgentTimerCreate {
    pub fn is_valid(&self) -> bool {
        key(&self.request_key)
            && !self.label.trim().is_empty()
            && self.label.len() <= AGENT_TIMER_LABEL_MAX
            && !self.label.chars().any(char::is_control)
            && !self.text.trim().is_empty()
            && self.text.len() <= AGENT_TIMER_TEXT_MAX
            && !self.text.contains('\0')
    }
}

/// Server defaults of the rolling 24-hour create cap (`None` = no cap).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentTimerDailyCaps {
    /// Conversations without an owner setting (and `default`).
    pub default: Option<i64>,
    /// Conversations the owner marked `owner_only`.
    pub owner_only: Option<i64>,
}
impl Default for AgentTimerDailyCaps {
    fn default() -> Self {
        Self {
            default: Some(AGENT_TIMER_DAILY_CREATES_MAX),
            owner_only: Some(AGENT_TIMER_OWNER_ONLY_DAILY_CREATES_MAX),
        }
    }
}
impl AgentTimerDailyCaps {
    /// The effective cap of a conversation with `mode`.
    pub fn resolve(&self, mode: AgentTimerCapMode, fixed: Option<i64>) -> Option<i64> {
        match mode {
            AgentTimerCapMode::Default => self.default,
            AgentTimerCapMode::OwnerOnly => self.owner_only,
            AgentTimerCapMode::Fixed => fixed,
            AgentTimerCapMode::Off => None,
        }
    }
}
/// Parse one cap setting: `off`, or 1..=`AGENT_TIMER_DAILY_CREATES_LIMIT`.
pub fn parse_agent_timer_daily_cap(value: &str) -> Option<Option<i64>> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("off") {
        return Some(None);
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|n| (1..=AGENT_TIMER_DAILY_CREATES_LIMIT).contains(n))
        .map(Some)
}

/// How a conversation's daily create cap is chosen (owner setting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTimerCapMode {
    /// The server default (no setting stored).
    Default,
    /// Only the owner is in this chat: the server's owner-only default.
    OwnerOnly,
    /// Exactly `daily_creates_max`.
    Fixed,
    /// No daily cap. The hourly, live-timer and schedule caps still apply.
    Off,
}
impl AgentTimerCapMode {
    pub fn text(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::OwnerOnly => "owner_only",
            Self::Fixed => "fixed",
            Self::Off => "off",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "default" => Self::Default,
            "owner_only" => Self::OwnerOnly,
            "fixed" => Self::Fixed,
            "off" => Self::Off,
            _ => return None,
        })
    }
}
/// Owner request: `PUT .../agent-timer-limits`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTimerLimitsUpdate {
    pub mode: AgentTimerCapMode,
    /// Required for `fixed`, refused otherwise.
    #[serde(default)]
    pub daily_creates_max: Option<i64>,
}
impl AgentTimerLimitsUpdate {
    pub fn is_valid(&self) -> bool {
        match (self.mode, self.daily_creates_max) {
            (AgentTimerCapMode::Fixed, Some(n)) => {
                (1..=AGENT_TIMER_DAILY_CREATES_LIMIT).contains(&n)
            }
            (_, None) => self.mode != AgentTimerCapMode::Fixed,
            _ => false,
        }
    }
}
/// A conversation's create caps as they apply now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTimerLimits {
    pub conversation_id: ConversationId,
    pub mode: AgentTimerCapMode,
    /// The effective rolling 24-hour create cap; `None` = no daily cap.
    pub daily_creates_max: Option<i64>,
    pub hourly_creates_max: i64,
    pub live_timers_max: i64,
    /// Agent creates of the last 24 hours (fired, cancelled and live alike).
    pub created_last_24h: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTimerOperation {
    /// Disable: no further runs. Reversible only by the owner.
    Cancel,
    /// Pause until `until_ms` (absent: the longest agent pause).
    Pause,
    /// Lift a pause; a run that came due while paused is not replayed.
    Resume,
    /// Drop only the next scheduled run.
    SkipNext,
}
impl AgentTimerOperation {
    pub fn text(self) -> &'static str {
        match self {
            Self::Cancel => "cancel",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::SkipNext => "skip_next",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTimerControl {
    pub request_key: String,
    pub operation: AgentTimerOperation,
    #[serde(default)]
    pub until_ms: Option<i64>,
}
impl AgentTimerControl {
    pub fn is_valid(&self) -> bool {
        key(&self.request_key)
            && (self.operation == AgentTimerOperation::Pause || self.until_ms.is_none())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTimerView {
    pub namespace: Uuid,
    pub label: Option<String>,
    /// paused, enabled, disabled, stopped, rolled_back or exhausted.
    pub state: String,
    pub schedule: String,
    pub next_due_ms: Option<i64>,
    pub pause_until_ms: Option<i64>,
    /// Created through this tool (else by the owner or imported from V1).
    pub created_by_agent: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTimerList {
    pub conversation_id: ConversationId,
    pub timers: Vec<AgentTimerView>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTimerReceipt {
    /// False for an idempotent replay of the same request.
    pub changed: bool,
    pub timer: AgentTimerView,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create(key: &str, label: &str, text: &str) -> AgentTimerCreate {
        AgentTimerCreate {
            request_key: key.into(),
            label: label.into(),
            schedule: AgentTimerSchedule::Once { due_ms: 1 },
            text: text.into(),
        }
    }

    #[test]
    fn request_validation() {
        assert!(create("reminder-1", "Biocytogen 12:15", "Remind").is_valid());
        assert!(!create("", "l", "t").is_valid());
        assert!(!create("bad key", "l", "t").is_valid());
        assert!(!create("k", " ", "t").is_valid());
        assert!(!create("k", "l\nx", "t").is_valid());
        assert!(!create("k", "l", " ").is_valid());
        assert!(!create("k", "l", &"x".repeat(AGENT_TIMER_TEXT_MAX + 1)).is_valid());
        let pause = |operation, until_ms| AgentTimerControl {
            request_key: "k".into(),
            operation,
            until_ms,
        };
        assert!(pause(AgentTimerOperation::Pause, Some(5)).is_valid());
        assert!(pause(AgentTimerOperation::Pause, None).is_valid());
        assert!(!pause(AgentTimerOperation::Cancel, Some(5)).is_valid());
        assert!(pause(AgentTimerOperation::SkipNext, None).is_valid());
    }

    #[test]
    fn daily_cap_settings() {
        let caps = AgentTimerDailyCaps::default();
        assert_eq!(caps.resolve(AgentTimerCapMode::Default, None), Some(24));
        assert_eq!(caps.resolve(AgentTimerCapMode::OwnerOnly, None), Some(200));
        assert_eq!(caps.resolve(AgentTimerCapMode::Fixed, Some(7)), Some(7));
        assert_eq!(caps.resolve(AgentTimerCapMode::Off, Some(7)), None);
        assert_eq!(parse_agent_timer_daily_cap(" off "), Some(None));
        assert_eq!(parse_agent_timer_daily_cap("150"), Some(Some(150)));
        for bad in ["0", "-1", "10001", "x", ""] {
            assert_eq!(parse_agent_timer_daily_cap(bad), None, "{bad}");
        }
        let update = |mode, daily_creates_max| AgentTimerLimitsUpdate {
            mode,
            daily_creates_max,
        };
        assert!(update(AgentTimerCapMode::Fixed, Some(50)).is_valid());
        assert!(!update(AgentTimerCapMode::Fixed, None).is_valid());
        assert!(!update(AgentTimerCapMode::Fixed, Some(0)).is_valid());
        assert!(!update(AgentTimerCapMode::Off, Some(50)).is_valid());
        assert!(update(AgentTimerCapMode::OwnerOnly, None).is_valid());
        let wire: AgentTimerLimitsUpdate =
            serde_json::from_str(r#"{"mode":"owner_only"}"#).unwrap();
        assert_eq!(wire.mode, AgentTimerCapMode::OwnerOnly);
    }

    #[test]
    fn schedule_wire_format() {
        let once: AgentTimerSchedule =
            serde_json::from_str(r#"{"kind":"once","due_ms":42}"#).unwrap();
        assert_eq!(once, AgentTimerSchedule::Once { due_ms: 42 });
        assert!(once.calendar_rule().is_none());
        let daily: AgentTimerSchedule = serde_json::from_str(
            r#"{"kind":"calendar","timezone":"Europe/Berlin","start_minute":540,"end_minute":540,"minutes":[0]}"#,
        )
        .unwrap();
        assert_eq!(daily.calendar_rule().unwrap().every_hours, 1);
        assert!(serde_json::from_str::<AgentTimerSchedule>(
            r#"{"kind":"interval","every_ms":60000}"#
        )
        .is_err());
    }
}
