//! Browser DTO adapter for timer_http/dto.rs at 1a92f545. No client clock/claim.
use orkestr_v2_contracts::ConversationId;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn valid_namespace(value: &str) -> bool {
    serde_json::from_value::<ConversationId>(json!(value)).is_ok_and(|id| !id.0.is_nil())
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Schedule {
    Once {
        due_ms: i64,
    },
    Interval {
        every_ms: i64,
    },
    UtcClock {
        weekly: bool,
        minute_of_day: u16,
    },
    ZonedClock {
        timezone: String,
        weekday: Option<u8>,
        minute_of_day: u16,
    },
    /// Weekdays, an hour window and minute offsets in a zone; `summary` is the
    /// server's plain-words rendering of the same rule.
    Calendar {
        timezone: String,
        weekdays: Vec<u8>,
        start_minute: u16,
        end_minute: u16,
        every_hours: u8,
        minutes: Vec<u8>,
        summary: String,
    },
    /// Runs only when a trigger event arrives.
    Event,
    Dormant,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Paused,
    Enabled,
    Disabled,
    Stopped,
    RolledBack,
    Exhausted,
}
impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paused => "paused",
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Stopped => "stopped",
            Self::RolledBack => "rolled_back",
            Self::Exhausted => "exhausted",
        }
    }
}
/// Per-timer behaviour: silent mode, pause, skip dates, digest, trigger.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Policy {
    pub revision: i64,
    /// `off` or `unless_changed`.
    pub silent_mode: String,
    pub pause_until_ms: Option<i64>,
    #[serde(default)]
    pub skip_dates: Vec<String>,
    pub skip_timezone: Option<String>,
    pub digest: Option<DigestRule>,
    pub trigger: Option<TriggerRule>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DigestRule {
    pub timezone: String,
    pub minutes: Vec<u16>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct TriggerRule {
    /// `message`, `email` or `other`.
    pub sources: Vec<String>,
    #[serde(default)]
    pub min_interval_s: u32,
}
/// Latest result and the quiet streak of one timer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Stats {
    /// `delivered`, `silent` or `digest`.
    pub last_kind: Option<String>,
    pub last_summary: Option<String>,
    pub last_at_ms: Option<i64>,
    pub silent_runs: i64,
    pub total_runs: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Digest {
    pub id: String,
    pub text: String,
    pub item_count: i64,
    pub created_ms: i64,
    pub delivered_ms: Option<i64>,
}
/// Server-formatted local times (the timer's own zone), so the page never
/// computes zone arithmetic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalTimes {
    pub next: Option<String>,
    pub last_result: Option<String>,
    pub pause_until: Option<String>,
}
/// One row of `GET /api/v2/conversations/{id}/timers`: the timer detail plus
/// its source label, policy and run statistics (absent from older servers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub detail: Detail,
    pub label: Option<String>,
    pub policy: Option<Policy>,
    pub stats: Option<Stats>,
    pub local: LocalTimes,
    /// Created here (editable), not imported from V1.
    pub native: bool,
}
const LISTED_EXTRA: [&str; 11] = [
    "label",
    "source_thread_id",
    "source_namespace",
    "source_timer_id",
    "source_enabled",
    "policy",
    "stats",
    "next_due_local",
    "last_result_local",
    "pause_until_local",
    "native",
];
/// A conversation's timers with its conversation-wide pause and recent digests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub rows: Vec<Listed>,
    pub pause_until_ms: Option<i64>,
    pub pause_until_local: Option<String>,
    pub digests: Vec<Digest>,
}
/// The conversation's timers; `None` when the answer is not a valid listing.
pub fn listing(value: &Value, conversation: &str) -> Option<Vec<Listed>> {
    full_listing(value, conversation).map(|l| l.rows)
}
pub fn full_listing(value: &Value, conversation: &str) -> Option<Listing> {
    if value.get("conversation_id")?.as_str()? != conversation {
        return None;
    }
    let text = |row: &serde_json::Map<String, Value>, key: &str| {
        row.get(key).and_then(Value::as_str).map(str::to_owned)
    };
    let rows = value
        .get("timers")?
        .as_array()?
        .iter()
        .map(|row| {
            let mut detail = row.as_object()?.clone();
            let label = text(&detail, "label");
            let local = LocalTimes {
                next: text(&detail, "next_due_local"),
                last_result: text(&detail, "last_result_local"),
                pause_until: text(&detail, "pause_until_local"),
            };
            let native = detail
                .get("native")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let policy = detail
                .get("policy")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let stats = detail
                .get("stats")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            for key in LISTED_EXTRA {
                detail.remove(key);
            }
            let detail: Detail = serde_json::from_value(Value::Object(detail)).ok()?;
            let namespace = detail.namespace.clone();
            detail.valid_for(&namespace).then_some(Listed {
                detail,
                label,
                policy,
                stats,
                local,
                native,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let digests = match value.get("digests") {
        Some(list) => serde_json::from_value(list.clone()).ok()?,
        None => Vec::new(),
    };
    Some(Listing {
        rows,
        pause_until_ms: value.get("pause_until_ms").and_then(Value::as_i64),
        pause_until_local: value
            .get("pause_until_local")
            .and_then(Value::as_str)
            .map(str::to_owned),
        digests,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Detail {
    pub namespace: String,
    pub source_digest: String,
    pub schedule: Schedule,
    pub conversation_id: Option<ConversationId>,
    pub state: State,
    pub dormant_reason: Option<String>,
    pub revision: i64,
    pub generation: i64,
    pub next_due_ms: Option<i64>,
    pub controller_armed: bool,
    pub controller_hold: Option<String>,
}
impl Detail {
    pub fn valid_for(&self, namespace: &str) -> bool {
        self.namespace == namespace
            && valid_namespace(namespace)
            && self.revision > 0
            && self.generation >= 0
            && !self.source_digest.is_empty()
            && self.source_digest.len() <= 256
            && self
                .conversation_id
                .as_ref()
                .is_none_or(|id| !id.0.is_nil())
            && self.next_due_ms.is_none_or(|due| due > 0)
            && self.controller_hold.as_deref().is_none_or(|hold| {
                matches!(
                    hold,
                    "explicit_owner_rearm_required"
                        | "scheduler_unavailable"
                        | "durable_owner_enable_required"
                )
            })
            && (!self.controller_armed
                || (self.state == State::Enabled && self.controller_hold.is_none()))
            && match self.schedule {
                Schedule::Once { due_ms } => due_ms > 0,
                Schedule::Interval { every_ms } => every_ms > 0,
                Schedule::UtcClock { minute_of_day, .. } => minute_of_day < 1440,
                Schedule::ZonedClock {
                    ref timezone,
                    weekday,
                    minute_of_day,
                } => {
                    minute_of_day < 1440
                        && !timezone.is_empty()
                        && timezone.len() <= 64
                        && weekday.is_none_or(|day| (1..=7).contains(&day))
                }
                Schedule::Calendar {
                    ref timezone,
                    ref weekdays,
                    start_minute,
                    end_minute,
                    every_hours,
                    ref minutes,
                    ref summary,
                } => {
                    !timezone.is_empty()
                        && timezone.len() <= 64
                        && weekdays.iter().all(|d| (1..=7).contains(d))
                        && !minutes.is_empty()
                        && minutes.iter().all(|m| *m < 60)
                        && start_minute <= end_minute
                        && end_minute < 1440
                        && (1..=24).contains(&every_hours)
                        && !summary.is_empty()
                        && summary.len() <= 300
                }
                Schedule::Event => true,
                Schedule::Dormant => true,
            }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Disable,
    Stop,
    Rollback,
}
#[derive(Clone)]
pub struct Pending {
    pub namespace: String,
    pub operation: &'static str,
    pub body: Value,
    draft_revision: u64,
}
#[derive(Clone, Default)]
pub struct Editor {
    pub text: String,
    revision: u64,
    pending: Option<Pending>,
    review: bool,
    pub notice: Option<&'static str>,
}
impl Editor {
    pub fn edit(&mut self, text: String) {
        self.text = text;
        self.revision = self
            .revision
            .checked_add(1)
            .expect("timer draft revision exhausted");
    }
    pub fn pending(&self) -> Option<&Pending> {
        self.pending.as_ref()
    }
    pub fn needs_review(&self) -> bool {
        self.review
    }
    pub fn prepare(
        &mut self,
        detail: &Detail,
        target: &ConversationId,
        action: Option<Action>,
        key: String,
    ) -> Result<Pending, &'static str> {
        if self.review {
            return Err("Review the current timer before another request.");
        }
        if let Some(pending) = &self.pending {
            if pending.namespace != detail.namespace {
                return Err("Request belongs to another timer.");
            }
            return Ok(pending.clone());
        }
        if !detail.valid_for(&detail.namespace)
            || target.0.is_nil()
            || key.is_empty()
            || key.len() > 128
            || key.chars().any(char::is_control)
        {
            return Err("Timer information or request identity unavailable.");
        }
        let (operation, body) = if let Some(action) = action {
            (
                "control",
                json!({"expected_revision":detail.revision,"request_key":key,"action":action}),
            )
        } else {
            if self.text.trim().is_empty() || self.text.len() > 32768 {
                return Err("Enter fresh instructions up to 32768 UTF-8 bytes.");
            }
            if detail.dormant_reason.is_some()
                || matches!(
                    detail.state,
                    State::Enabled | State::Stopped | State::RolledBack
                )
            {
                return Err("This timer cannot be enabled in its current state.");
            }
            (
                "enable",
                json!({"expected_revision":detail.revision,"request_key":key,"conversation_id":target,"text":self.text}),
            )
        };
        let pending = Pending {
            namespace: detail.namespace.clone(),
            operation,
            body,
            draft_revision: self.revision,
        };
        self.pending = Some(pending.clone());
        self.notice = Some("Timer change requested…");
        Ok(pending)
    }
    pub fn result(
        &mut self,
        pending: &Pending,
        status: u16,
        detail: Option<&Detail>,
    ) -> Result<(), &'static str> {
        if !self.pending.as_ref().is_some_and(|p| {
            p.namespace == pending.namespace
                && p.operation == pending.operation
                && p.body == pending.body
        }) {
            return Err("Timer request no longer selected.");
        }
        if status == 200
            && detail.is_some_and(|d| {
                d.valid_for(&pending.namespace)
                    && d.revision
                        >= pending.body["expected_revision"]
                            .as_i64()
                            .unwrap_or(i64::MAX)
            })
        {
            if pending.operation == "enable" && pending.draft_revision == self.revision {
                self.text.clear();
            }
            self.review = true;
            self.notice =
                Some("Timer change confirmed. Scheduling is separate from work execution.");
            return Ok(());
        }
        self.review = matches!(status, 400 | 404 | 409);
        self.notice = Some(match status {
            409 => {
                "Timer changed or request conflicted. Review current details before a new request."
            }
            400 | 404 => "Timer change refused. Review the timer and instructions.",
            401 | 403 => "Timer request refused. Sign in again.",
            _ => "Timer change not confirmed. Retry keeps the original request and instructions.",
        });
        Err("Timer change not confirmed.")
    }
    pub fn review(&mut self) {
        if self.review {
            self.pending = None;
            self.review = false;
            self.notice = None;
        }
    }
}
