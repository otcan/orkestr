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
    Once { due_ms: i64 },
    Interval { every_ms: i64 },
    UtcClock { weekly: bool, minute_of_day: u16 },
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
            && self
                .controller_hold
                .as_deref()
                .is_none_or(|hold| hold == "explicit_owner_rearm_required")
            && (!self.controller_armed
                || (self.state == State::Enabled && self.controller_hold.is_none()))
            && match self.schedule {
                Schedule::Once { due_ms } => due_ms > 0,
                Schedule::Interval { every_ms } => every_ms > 0,
                Schedule::UtcClock { minute_of_day, .. } => minute_of_day < 1440,
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
                || matches!(detail.state, State::Stopped | State::RolledBack)
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
