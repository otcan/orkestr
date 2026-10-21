//! The calendar timer form: parse what the owner typed into the exact request
//! bodies, and render the rule in plain words for a live preview. Pure; the
//! server stays the authority on every rule (zone names, ranges, grants).
use crate::timers::{Listed, Schedule};
use orkestr_v2_contracts::{CalendarRule, ConversationId};
use serde_json::{json, Value};

pub const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/// "Until I resume" on the wire.
pub const FOREVER_MS: i64 = 4_102_444_800_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Runs on the calendar rule.
    Schedule,
    /// Runs only when a message or email arrives.
    Event,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleForm {
    pub kind: Kind,
    pub label: String,
    pub timezone: String,
    pub weekdays: [bool; 7],
    pub start: String,
    pub end: String,
    pub every_hours: String,
    pub minutes: String,
    pub instruction: String,
    pub silent: bool,
    pub digest_on: bool,
    pub digest_times: String,
    pub skip_dates: String,
    pub on_message: bool,
    pub on_email: bool,
    pub min_interval_s: String,
    /// Set when editing: the timer and the revisions the edit is based on.
    pub editing: Option<Editing>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Editing {
    pub namespace: String,
    pub revision: i64,
    pub policy_revision: i64,
    pub schedule_before: Option<Value>,
    /// An active pause survives an edit: the policy is a full replace.
    pub pause_until_ms: Option<i64>,
}

impl Default for RuleForm {
    fn default() -> Self {
        Self {
            kind: Kind::Schedule,
            label: String::new(),
            timezone: "Europe/Berlin".into(),
            weekdays: [true, true, true, true, true, false, false],
            start: "08:00".into(),
            end: "19:00".into(),
            every_hours: "1".into(),
            minutes: "0".into(),
            instruction: String::new(),
            silent: true,
            digest_on: false,
            digest_times: "09:00".into(),
            skip_dates: String::new(),
            on_message: false,
            on_email: false,
            min_interval_s: "60".into(),
            editing: None,
        }
    }
}

/// `HH:MM` to minutes of the day.
pub fn parse_clock(text: &str) -> Option<u16> {
    let (h, m) = text.trim().split_once(':')?;
    let (h, m) = (h.parse::<u16>().ok()?, m.parse::<u16>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}
pub fn clock(minutes: u16) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}
fn numbers(text: &str) -> Option<Vec<u8>> {
    let items: Vec<&str> = text
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .collect();
    if items.is_empty() {
        return None;
    }
    items
        .iter()
        .map(|p| p.trim_start_matches(':').parse().ok())
        .collect()
}
fn dates(text: &str) -> Vec<String> {
    text.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A validated form: request bodies and the preview line.
#[derive(Debug, Clone, PartialEq)]
pub struct Built {
    pub schedule: Value,
    pub policy: Value,
    pub summary: String,
}

impl RuleForm {
    pub fn rule(&self) -> Result<CalendarRule, String> {
        let weekdays = (1u8..=7)
            .filter(|d| self.weekdays[usize::from(*d - 1)])
            .collect();
        let start = parse_clock(&self.start).ok_or("Start must be a time like 08:00.")?;
        let end = parse_clock(&self.end).ok_or("End must be a time like 19:00.")?;
        let minutes =
            numbers(&self.minutes).ok_or("Minutes past the hour, for example 0 or 0, 30.")?;
        let every_hours = self
            .every_hours
            .trim()
            .parse::<u8>()
            .map_err(|_| "Hours between runs must be a number from 1 to 24.".to_owned())?;
        if self.timezone.trim().is_empty() {
            return Err("Enter a time zone such as Europe/Berlin.".into());
        }
        CalendarRule {
            timezone: self.timezone.trim().to_owned(),
            weekdays,
            start_minute: start,
            end_minute: end,
            every_hours,
            minutes,
        }
        .normalized()
        .map_err(|m| format!("Schedule: {m}."))
    }

    fn trigger(&self) -> Result<Option<Value>, String> {
        let mut sources = Vec::new();
        if self.on_message {
            sources.push("message");
        }
        if self.on_email {
            sources.push("email");
        }
        if sources.is_empty() {
            return if self.kind == Kind::Event {
                Err("Choose what starts this timer: a message, an email, or both.".into())
            } else {
                Ok(None)
            };
        }
        let interval = self
            .min_interval_s
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|v| *v <= 86_400)
            .ok_or("Minimum seconds between event runs must be 0 to 86400.")?;
        Ok(Some(
            json!({"sources": sources, "min_interval_s": interval}),
        ))
    }

    fn digest(&self, zone: &str) -> Result<Option<Value>, String> {
        if !self.digest_on {
            return Ok(None);
        }
        let mut minutes = Vec::new();
        for part in self
            .digest_times
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|p| !p.is_empty())
        {
            minutes.push(parse_clock(part).ok_or("Digest times look like 09:00 or 09:00, 18:00.")?);
        }
        if minutes.is_empty() || minutes.len() > 24 {
            return Err("Enter one to 24 digest times such as 09:00.".into());
        }
        Ok(Some(json!({"timezone": zone, "minutes": minutes})))
    }

    /// The `policy` object shared by create and edit.
    pub fn policy(&self, zone: &str) -> Result<Value, String> {
        Ok(json!({
            "silent_mode": if self.silent { "unless_changed" } else { "off" },
            "pause_until_ms": self.editing.as_ref().and_then(|e| e.pause_until_ms),
            "skip_dates": dates(&self.skip_dates),
            "skip_timezone": if self.kind == Kind::Event { Some(zone) } else { None },
            "digest": self.digest(zone)?,
            "trigger": self.trigger()?,
        }))
    }

    pub fn build(&self) -> Result<Built, String> {
        match self.kind {
            Kind::Schedule => {
                let rule = self.rule()?;
                Ok(Built {
                    schedule: json!({"kind":"calendar","timezone":rule.timezone,"weekdays":rule.weekdays,
                        "start_minute":rule.start_minute,"end_minute":rule.end_minute,
                        "every_hours":rule.every_hours,"minutes":rule.minutes}),
                    policy: self.policy(&rule.timezone)?,
                    summary: rule.describe(),
                })
            }
            Kind::Event => {
                let zone = self.timezone.trim();
                if zone.is_empty() {
                    return Err("Enter a time zone such as Europe/Berlin.".into());
                }
                Ok(Built {
                    schedule: json!({"kind":"event"}),
                    policy: self.policy(zone)?,
                    summary: self.event_summary(),
                })
            }
        }
    }

    pub fn event_summary(&self) -> String {
        match (self.on_message, self.on_email) {
            (true, true) => "When a new message or email arrives".into(),
            (true, false) => "When a new message arrives".into(),
            (false, true) => "When a new email arrives".into(),
            (false, false) => "When something arrives".into(),
        }
    }

    /// Body of `POST /api/v2/timers/calendar`. `text` is required to run it.
    pub fn create_body(
        &self,
        namespace: &str,
        conversation: &ConversationId,
    ) -> Result<Value, String> {
        if self.label.trim().is_empty() || self.label.len() > 200 {
            return Err("Give the timer a name.".into());
        }
        if self.instruction.trim().is_empty() || self.instruction.len() > 32768 {
            return Err("Enter the instructions each run should follow.".into());
        }
        let built = self.build()?;
        Ok(json!({
            "namespace": namespace, "conversation_id": conversation, "label": self.label.trim(),
            "schedule": built.schedule, "policy": built.policy, "text": self.instruction,
        }))
    }

    /// Bodies for an edit: the schedule (only when it changed) and the policy.
    pub fn edit_bodies(&self) -> Result<(Option<Value>, Value), String> {
        let editing = self.editing.as_ref().ok_or("Nothing is being edited.")?;
        let built = self.build()?;
        let schedule = (editing.schedule_before.as_ref() != Some(&built.schedule))
            .then(|| json!({"expected_revision": editing.revision, "schedule": built.schedule}));
        let policy = json!({"expected_revision": editing.policy_revision, "policy": built.policy});
        Ok((schedule, policy))
    }

    /// A form pre-filled from an existing timer.
    pub fn from_listed(row: &Listed) -> Self {
        let mut form = Self {
            label: row.label.clone().unwrap_or_default(),
            ..Self::default()
        };
        let mut before = None;
        match &row.detail.schedule {
            Schedule::Calendar {
                timezone,
                weekdays,
                start_minute,
                end_minute,
                every_hours,
                minutes,
                ..
            } => {
                form.timezone = timezone.clone();
                form.weekdays = std::array::from_fn(|i| {
                    weekdays.is_empty() || weekdays.contains(&(i as u8 + 1))
                });
                form.start = clock(*start_minute);
                form.end = clock(*end_minute);
                form.every_hours = every_hours.to_string();
                form.minutes = minutes
                    .iter()
                    .map(u8::to_string)
                    .collect::<Vec<_>>()
                    .join(", ");
                before = Some(
                    json!({"kind":"calendar","timezone":timezone,"weekdays":weekdays,
                    "start_minute":start_minute,"end_minute":end_minute,"every_hours":every_hours,"minutes":minutes}),
                );
            }
            Schedule::Event => {
                form.kind = Kind::Event;
                before = Some(json!({"kind":"event"}));
            }
            _ => {}
        }
        form.silent = false;
        let mut policy_revision = 0;
        if let Some(policy) = &row.policy {
            policy_revision = policy.revision;
            form.silent = policy.silent_mode == "unless_changed";
            form.skip_dates = policy.skip_dates.join(", ");
            if let Some(zone) = &policy.skip_timezone {
                if form.kind == Kind::Event {
                    form.timezone = zone.clone();
                }
            }
            if let Some(digest) = &policy.digest {
                form.digest_on = true;
                form.digest_times = digest
                    .minutes
                    .iter()
                    .map(|m| clock(*m))
                    .collect::<Vec<_>>()
                    .join(", ");
            }
            if let Some(trigger) = &policy.trigger {
                form.on_message = trigger.sources.iter().any(|s| s == "message");
                form.on_email = trigger.sources.iter().any(|s| s == "email");
                form.min_interval_s = trigger.min_interval_s.to_string();
            }
        }
        form.editing = Some(Editing {
            namespace: row.detail.namespace.clone(),
            revision: row.detail.revision,
            policy_revision,
            schedule_before: before,
            pause_until_ms: row.policy.as_ref().and_then(|p| p.pause_until_ms),
        });
        form
    }
}

/// Wire body for pausing until an instant (`None` resumes).
pub fn pause_body(until_ms: Option<i64>) -> Value {
    json!({"until_ms": until_ms})
}
