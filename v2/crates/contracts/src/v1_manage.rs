//! Owner management of a linked V1 chat from the Rust UI, through V1's own
//! API: model and effort, timers, WhatsApp binding options and desktop
//! grants/leases (read). V1 stays the authority; these are bounded views and
//! requests. Chats whose runtime is delegated to V2 are managed through their
//! V2 conversation instead.
use serde::{Deserialize, Serialize};

pub const V1_TIMER_PROMPT_MAX: usize = 16 * 1024;
pub const V1_TIMER_LABEL_MAX: usize = 120;
pub const V1_PARTICIPANTS_MAX: usize = 64;

fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}
fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-/+".contains(&b))
}

/// One model V1 offers for the thread and its efforts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1Model {
    pub id: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

/// `GET /api/v2/v1-threads/{thread}/settings` (V1 `model-settings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1ThreadSettings {
    pub thread_id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub models: Vec<V1Model>,
    /// V1 refuses changes (for example a running turn); the reason, if given.
    pub read_only: bool,
    pub read_only_reason: Option<String>,
}

/// `PUT /api/v2/v1-threads/{thread}/settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1ThreadSettingsUpdate {
    pub model: String,
    pub effort: String,
}
impl V1ThreadSettingsUpdate {
    pub fn is_valid(&self) -> bool {
        token(&self.model, 120) && token(&self.effort, 32)
    }
}

/// One V1 timer of the thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1Timer {
    pub id: String,
    pub label: Option<String>,
    pub cadence: Option<String>,
    pub time: Option<String>,
    pub every: Option<String>,
    pub timezone: Option<String>,
    pub run_at: Option<String>,
    pub prompt: Option<String>,
    pub enabled: bool,
    /// The V2 timer supervisor owns this timer (handed off); V1 refuses edits.
    pub owned_by_v2: bool,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1TimerList {
    pub thread_id: String,
    pub timers: Vec<V1Timer>,
}

/// Create (`POST …/timers`) or edit (`PATCH …/timers/{timer}`) a V1 timer.
/// Creation is idempotent per `client_request_id` for this server process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1TimerInput {
    pub client_request_id: String,
    pub label: String,
    /// `once`, `daily`, `weekly` or `interval`.
    pub cadence: String,
    /// `HH:MM` for daily and weekly.
    #[serde(default)]
    pub time: Option<String>,
    /// Interval such as `30m`, `2h`, `1d`.
    #[serde(default)]
    pub every: Option<String>,
    /// ISO time for `once`.
    #[serde(default)]
    pub run_at: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    pub prompt: String,
}
impl V1TimerInput {
    pub fn is_valid(&self) -> bool {
        let clock = |t: &str| {
            t.len() == 5
                && t.as_bytes()[2] == b':'
                && t[..2].parse::<u8>().is_ok_and(|h| h < 24)
                && t[3..].parse::<u8>().is_ok_and(|m| m < 60)
        };
        let interval = |e: &str| {
            e.len() >= 2
                && e.len() <= 8
                && e[..e.len() - 1].parse::<u32>().is_ok_and(|n| n > 0)
                && matches!(e.as_bytes()[e.len() - 1], b'm' | b'h' | b'd')
        };
        let schedule = match self.cadence.as_str() {
            "daily" | "weekly" => self.time.as_deref().is_some_and(clock),
            "interval" => self.every.as_deref().is_some_and(interval),
            "once" => self.run_at.as_deref().is_some_and(|r| token(r, 40)),
            _ => false,
        };
        uuid::Uuid::parse_str(&self.client_request_id).is_ok_and(|id| !id.is_nil())
            && label(&self.label, V1_TIMER_LABEL_MAX)
            && schedule
            && self.timezone.as_deref().is_none_or(|z| token(z, 64))
            && !self.prompt.trim().is_empty()
            && self.prompt.len() <= V1_TIMER_PROMPT_MAX
            && !self.prompt.contains('\0')
    }
}

/// The WhatsApp options of a V1 thread's binding the owner manages in V1's
/// settings panel. Accounts, chat, owner contacts and remote fields are not
/// editable here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1WhatsAppOptions {
    pub thread_id: String,
    pub chat_id: Option<String>,
    pub display_name: Option<String>,
    pub enabled: bool,
    pub reply_prefix: Option<String>,
    pub suppress_updates: bool,
    pub suppress_debug_footer: bool,
    pub additional_participants_enabled: bool,
    pub additional_participant_ids: Vec<String>,
    /// Delegated to V2: read-only here.
    pub delegated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1WhatsAppOptionsUpdate {
    pub reply_prefix: Option<String>,
    pub suppress_updates: bool,
    pub suppress_debug_footer: bool,
    pub additional_participants_enabled: bool,
    pub additional_participant_ids: Vec<String>,
}
pub fn whatsapp_participant_id(value: &str) -> bool {
    value.split_once('@').is_some_and(|(user, domain)| {
        (5..=24).contains(&user.len())
            && user.bytes().all(|b| b.is_ascii_digit())
            && matches!(domain, "c.us" | "lid" | "s.whatsapp.net")
    })
}
impl V1WhatsAppOptionsUpdate {
    pub fn is_valid(&self) -> bool {
        let mut seen = std::collections::HashSet::new();
        self.reply_prefix.as_deref().is_none_or(|p| label(p, 64))
            && self.additional_participant_ids.len() <= V1_PARTICIPANTS_MAX
            && self
                .additional_participant_ids
                .iter()
                .all(|id| whatsapp_participant_id(id) && seen.insert(id.as_str()))
    }
}

/// One desktop V1 grants the thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1DesktopGrant {
    pub slug: String,
    pub permissions: Vec<String>,
    pub expires_at: Option<String>,
}
/// One V1 desktop lease held for the thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1DesktopLease {
    pub slug: String,
    pub state: String,
    pub expires_at: Option<String>,
    pub purpose: Option<String>,
}
/// `GET /api/v2/v1-threads/{thread}/desktops`: read-only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V1Desktops {
    pub thread_id: String,
    pub grants: Vec<V1DesktopGrant>,
    pub leases: Vec<V1DesktopLease>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timer() -> V1TimerInput {
        V1TimerInput {
            client_request_id: "00000000-0000-4000-8000-000000000001".into(),
            label: "Synthetic".into(),
            cadence: "daily".into(),
            time: Some("07:30".into()),
            every: None,
            run_at: None,
            timezone: Some("Europe/Berlin".into()),
            prompt: "Synthetic prompt".into(),
        }
    }

    #[test]
    fn timer_schedules_are_bounded() {
        assert!(timer().is_valid());
        let mut t = timer();
        t.time = Some("24:00".into());
        assert!(!t.is_valid());
        t = timer();
        t.cadence = "interval".into();
        assert!(!t.is_valid());
        t.every = Some("30m".into());
        assert!(t.is_valid());
        t.every = Some("0h".into());
        assert!(!t.is_valid());
        t = timer();
        t.cadence = "hourly".into();
        assert!(!t.is_valid());
    }

    #[test]
    fn whatsapp_options_accept_only_participant_ids() {
        let mut u = V1WhatsAppOptionsUpdate {
            reply_prefix: Some("synthetic:".into()),
            suppress_updates: true,
            suppress_debug_footer: false,
            additional_participants_enabled: true,
            additional_participant_ids: vec!["10000000001@c.us".into(), "20000000002@lid".into()],
        };
        assert!(u.is_valid());
        u.additional_participant_ids.push("10000000001@c.us".into());
        assert!(!u.is_valid());
        u.additional_participant_ids = vec!["someone".into()];
        assert!(!u.is_valid());
    }
}
