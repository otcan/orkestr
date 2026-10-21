//! Form state for managing a linked V1 chat (V1 web UI parity): timers and
//! WhatsApp options. A timer create keeps its request id until the server
//! answers, so a retry never adds a second timer.
use orkestr_v2_contracts::{V1Timer, V1TimerInput, V1WhatsAppOptions, V1WhatsAppOptionsUpdate};

#[derive(Clone, PartialEq)]
pub struct TimerForm {
    /// `Some(id)` edits that timer; `None` creates a new one.
    pub editing: Option<String>,
    pub label: String,
    pub cadence: String,
    pub time: String,
    pub every: String,
    pub run_at: String,
    pub timezone: String,
    pub prompt: String,
    pub pending: Option<V1TimerInput>,
}
impl Default for TimerForm {
    fn default() -> Self {
        Self {
            editing: None,
            label: String::new(),
            cadence: "daily".into(),
            time: "09:00".into(),
            every: "1h".into(),
            run_at: String::new(),
            timezone: "Europe/Berlin".into(),
            prompt: String::new(),
            pending: None,
        }
    }
}

fn optional(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

impl TimerForm {
    pub fn edit(timer: &V1Timer) -> Self {
        Self {
            editing: Some(timer.id.clone()),
            label: timer.label.clone().unwrap_or_default(),
            cadence: timer.cadence.clone().unwrap_or_else(|| "daily".into()),
            time: timer.time.clone().unwrap_or_default(),
            every: timer.every.clone().unwrap_or_default(),
            run_at: timer.run_at.clone().unwrap_or_default(),
            timezone: timer.timezone.clone().unwrap_or_default(),
            prompt: timer.prompt.clone().unwrap_or_default(),
            pending: None,
        }
    }
    pub fn prepare(&mut self, key: String) -> Result<V1TimerInput, &'static str> {
        if let Some(pending) = &self.pending {
            return Ok(pending.clone());
        }
        let cadence = self.cadence.trim().to_owned();
        let input = V1TimerInput {
            client_request_id: key,
            label: self.label.trim().to_owned(),
            time: matches!(cadence.as_str(), "daily" | "weekly")
                .then(|| optional(&self.time))
                .flatten(),
            every: (cadence == "interval")
                .then(|| optional(&self.every))
                .flatten(),
            run_at: (cadence == "once")
                .then(|| optional(&self.run_at))
                .flatten(),
            timezone: optional(&self.timezone),
            prompt: self.prompt.clone(),
            cadence,
        };
        if !input.is_valid() {
            return Err("Check the label, the schedule (HH:MM, an interval like 30m or 2h, or an ISO time) and the prompt.");
        }
        self.pending = Some(input.clone());
        Ok(input)
    }
}

/// WhatsApp options as edited; participants are typed one per line or comma.
pub fn options_update(
    options: &V1WhatsAppOptions,
    reply_prefix: &str,
    participants: &str,
) -> Result<V1WhatsAppOptionsUpdate, &'static str> {
    let mut ids: Vec<String> = Vec::new();
    for id in participants
        .split([',', '\n', ' '])
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !ids.iter().any(|x| x == id) {
            ids.push(id.to_owned());
        }
    }
    let update = V1WhatsAppOptionsUpdate {
        reply_prefix: optional(reply_prefix),
        suppress_updates: options.suppress_updates,
        suppress_debug_footer: options.suppress_debug_footer,
        additional_participants_enabled: options.additional_participants_enabled,
        additional_participant_ids: ids,
    };
    if update.is_valid() {
        Ok(update)
    } else {
        Err("Participants must be WhatsApp ids like 491700000000@c.us; the prefix at most 64 characters.")
    }
}

/// How a V1 timer's schedule reads.
pub fn schedule(timer: &V1Timer) -> String {
    let zone = timer
        .timezone
        .as_deref()
        .map(|z| format!(" {z}"))
        .unwrap_or_default();
    match timer.cadence.as_deref() {
        Some("daily") => format!("Daily at {}{zone}", timer.time.as_deref().unwrap_or("?")),
        Some("weekly") => format!("Weekly at {}{zone}", timer.time.as_deref().unwrap_or("?")),
        Some("interval") => format!("Every {}", timer.every.as_deref().unwrap_or("?")),
        Some("once") => format!("Once at {}", timer.run_at.as_deref().unwrap_or("?")),
        _ => "Custom schedule".into(),
    }
}
