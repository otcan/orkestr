//! Explicit owner intent after durable intake; never activates execution locally.
use orkestr_v2_contracts::{ExecutionWindowAdmission, ExecutionWindowRequest};

#[derive(Default)]
pub struct WindowIntent {
    generation: u64,
    pending: Option<ExecutionWindowRequest>,
    refused: bool,
}
impl WindowIntent {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// Owner/session or configured conversation changes invalidate every callback.
    pub fn clear_scope(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("scope generation exhausted");
        self.pending = None;
        self.refused = false;
    }
    pub fn pending(&self) -> Option<&ExecutionWindowRequest> {
        self.pending.as_ref()
    }
    /// An uncertain request must be retried verbatim, even after edits or polling.
    pub fn prepare(&mut self, request: ExecutionWindowRequest) -> Option<ExecutionWindowRequest> {
        if let Some(original) = &self.pending {
            return Some(original.clone());
        }
        if !request.is_valid() {
            return None;
        }
        self.pending = Some(request.clone());
        Some(request)
    }
    /// A receipt is historical admission evidence, never current activation status.
    pub fn receipt_matches(&self, generation: u64, receipt: &ExecutionWindowAdmission) -> bool {
        generation == self.generation
            && self.pending.as_ref().is_some_and(|request| {
                (if request.window_id.is_some() {
                    Some(request.expected_generation)
                } else {
                    request.expected_generation.checked_add(1)
                }) == Some(receipt.status.generation)
                    && request.predecessor_window_id
                        == receipt
                            .status
                            .predecessor_window_id
                            .filter(|_| request.window_id.is_none())
                    && request.request_key == receipt.request_key
                    && request.input_message_id == receipt.input_message_id
                    && request.input_event_id == receipt.input_event_id
                    && request.input_request_key == receipt.input_request_key
                    && request
                        .window_id
                        .is_none_or(|id| id == receipt.status.window_id)
            })
    }
    /// A definitive refusal needs explicit owner review before creating a new tuple.
    pub fn review_refusal(&mut self, generation: u64) -> bool {
        if generation != self.generation {
            return false;
        }
        self.clear_scope();
        true
    }
}

/// Authenticated owner lifetime; selection never discards another route's uncertainty.
#[derive(Default)]
pub struct WindowIntents {
    epoch: u64,
    entries: std::collections::BTreeMap<String, WindowIntent>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentTicket {
    route: String,
    epoch: u64,
    generation: u64,
}
impl WindowIntents {
    pub fn refused(&self, route: &str) -> bool {
        self.entries.get(route).is_some_and(|intent| intent.refused)
    }
    pub fn mark_refused(&mut self, route: &str, ticket: &IntentTicket) {
        if self.current(route, ticket) {
            self.entries.get_mut(route).expect("current entry").refused = true;
        }
    }
    pub fn clear_scope(&mut self) {
        self.epoch = self
            .epoch
            .checked_add(1)
            .expect("owner generation exhausted");
        self.entries.clear();
    }
    pub fn pending(&self, route: &str) -> Option<&ExecutionWindowRequest> {
        self.entries.get(route).and_then(WindowIntent::pending)
    }
    pub fn prepare(
        &mut self,
        route: &str,
        request: ExecutionWindowRequest,
    ) -> Option<ExecutionWindowRequest> {
        let id = serde_json::from_value::<orkestr_v2_contracts::ConversationId>(
            serde_json::Value::String(route.into()),
        )
        .ok()?;
        if id.0.is_nil() || (!self.entries.contains_key(route) && self.entries.len() >= 128) {
            return None;
        }
        self.entries
            .entry(route.into())
            .or_default()
            .prepare(request)
    }
    /// Uncertain window requests by conversation, for page-reload recovery.
    pub fn pending_requests(&self) -> impl Iterator<Item = (&str, &ExecutionWindowRequest)> {
        self.entries
            .iter()
            .filter_map(|(route, intent)| Some((route.as_str(), intent.pending()?)))
    }
    pub fn ticket(&self, route: &str) -> Option<IntentTicket> {
        let intent = self.entries.get(route)?;
        intent.pending()?;
        Some(IntentTicket {
            route: route.into(),
            epoch: self.epoch,
            generation: intent.generation(),
        })
    }
    pub fn current(&self, route: &str, ticket: &IntentTicket) -> bool {
        self.ticket(route).as_ref() == Some(ticket)
    }
    pub fn review_refusal(&mut self, route: &str, ticket: &IntentTicket) -> bool {
        if !self.current(route, ticket) {
            return false;
        }
        self.entries
            .get_mut(route)
            .is_some_and(|intent| intent.review_refusal(ticket.generation))
    }
    pub fn complete(
        &mut self,
        route: &str,
        ticket: &IntentTicket,
        receipt: &ExecutionWindowAdmission,
        saved: &mut crate::beta_inputs::SavedInputs,
    ) -> bool {
        if !self.current(route, ticket) || receipt.status.conversation_id.to_string() != route {
            return false;
        }
        let intent = self.entries.get(route).expect("current ticket owns entry");
        if !intent.receipt_matches(ticket.generation, receipt) {
            return false;
        }
        let request = intent
            .pending()
            .expect("current ticket owns request")
            .clone();
        saved.admitted_request(route, &request);
        self.review_refusal(route, ticket)
    }
}

impl WindowIntents {
    /// A durable queue receipt (HTTP 202) ends this Send: the server owns the
    /// intent and starts it when a work slot frees. It must name the exact
    /// pending request and input; anything else stays pending for retry.
    pub fn queued(
        &mut self,
        route: &str,
        ticket: &IntentTicket,
        queued: &orkestr_v2_contracts::ExecutionWindowQueued,
        saved: &mut crate::beta_inputs::SavedInputs,
    ) -> bool {
        if !self.current(route, ticket) || queued.conversation_id.to_string() != route {
            return false;
        }
        let request = self
            .entries
            .get(route)
            .and_then(WindowIntent::pending)
            .expect("current ticket owns request")
            .clone();
        if request.request_key != queued.request_key
            || request.input_message_id != queued.input_message_id
            || request.input_event_id != queued.input_event_id
            || request.input_request_key != queued.input_request_key
            || queued.state == orkestr_v2_contracts::QueuedWindowState::Withdrawn
        {
            return false;
        }
        saved.admitted_request(route, &request);
        self.review_refusal(route, ticket)
    }
}

/// Owner-facing wording for one queued intent; never claims work has started.
pub fn queued_notice(queued: &orkestr_v2_contracts::ExecutionWindowQueued) -> String {
    use orkestr_v2_contracts::QueuedWindowState;
    match (queued.state, queued.position) {
        (QueuedWindowState::Queued, Some(position)) => format!(
            "Waiting: the host is busy or earlier work is still running. This message starts automatically (position {position})."
        ),
        (QueuedWindowState::Queued, None) => {
            "Waiting: this message starts automatically when the host has room.".into()
        }
        (QueuedWindowState::Dispatched, _) => "Sent. Waiting for a reply.".into(),
        (QueuedWindowState::Withdrawn, _) => {
            "This queued message could not start. It is saved in history; send it again.".into()
        }
    }
}

pub fn valid_status(value: &orkestr_v2_contracts::ExecutionWindowStatus, id: &str) -> bool {
    value.conversation_id.to_string() == id
        && !value.window_id.is_nil()
        && value.generation > 0
        && value.generation < 9_007_199_254_740_992
        && value.limits == Default::default()
        && value.opened_at_ms >= 0
        && value
            .work_deadline_ms
            .checked_sub(value.opened_at_ms)
            .is_some_and(|work| (870_000..=14_370_000).contains(&work))
        && value.expires_at_ms.checked_sub(value.work_deadline_ms) == Some(30_000)
}

/// Plain-language work status for the window toolbar: what is happening, until
/// when, and why new work waits. Presentation only; it never admits work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowSummary {
    pub headline: String,
    pub host: Option<String>,
}

const CLEANUP_MS: i64 = 30_000;

fn duration_label(ms: i64) -> String {
    let minutes = (ms + 59_999) / 60_000;
    if minutes >= 60 && minutes % 60 == 0 {
        format!("{} h", minutes / 60)
    } else if minutes >= 60 {
        format!("{} h {} min", minutes / 60, minutes % 60)
    } else {
        format!("{minutes} min")
    }
}

fn wait_reason(
    reason: orkestr_v2_contracts::HostBusyReason,
    host: &orkestr_v2_contracts::WindowHostAdmission,
) -> String {
    use orkestr_v2_contracts::HostBusyReason;
    match reason {
        HostBusyReason::CpuPressure => {
            format!("host busy, CPU pressure {}%", host.cpu_pressure_pct)
        }
        HostBusyReason::MemoryPressure => {
            format!("host busy, memory pressure {}%", host.memory_pressure_pct)
        }
        HostBusyReason::MemoryLow => format!(
            "host low on memory, {:.1} GiB free",
            host.memory_available_mib as f64 / 1024.0
        ),
    }
}

pub fn window_summary(
    status: Option<&orkestr_v2_contracts::ExecutionWindowStatus>,
    queue: Option<&orkestr_v2_contracts::ExecutionWindowQueue>,
    now_ms: i64,
) -> WindowSummary {
    use orkestr_v2_contracts::{ExecutionWindowState, QueuedWindowState};
    let host = queue.and_then(|q| q.host.as_ref()).filter(|h| h.is_valid());
    let headline = match status {
        Some(s) if s.state == ExecutionWindowState::Active => {
            let mut text = format!(
                "Working · until {}",
                crate::message_time::short(s.work_deadline_ms, now_ms)
            );
            text.push_str(" · extends automatically while work continues");
            if let Some(host) = host {
                let latest = s.opened_at_ms + host.max_window_ms - CLEANUP_MS;
                text.push_str(&format!(
                    ", up to {} ({} at the latest)",
                    duration_label(host.max_window_ms),
                    crate::message_time::short(latest, now_ms)
                ));
            }
            text
        }
        Some(s) if s.state == ExecutionWindowState::Opening => "Starting".into(),
        Some(s) if s.state == ExecutionWindowState::Retiring => "Finishing up".into(),
        Some(s) if s.state == ExecutionWindowState::ReconciliationRequired => {
            "Needs operator attention".into()
        }
        _ => "Idle · send a message to start work".into(),
    };
    let waiting: Vec<_> = queue
        .map(|q| {
            q.entries
                .iter()
                .filter(|e| e.state == QueuedWindowState::Queued)
                .collect()
        })
        .unwrap_or_default();
    let host_line = match host {
        Some(host) if !waiting.is_empty() => {
            // A queued timer waits on the background threshold, owner input
            // on the interactive one.
            let background = waiting
                .iter()
                .all(|e| e.input_request_key.starts_with("timer:"));
            let reason = if background {
                host.background_wait
            } else {
                host.interactive_wait
            };
            Some(match reason {
                Some(reason) => format!("Waiting: {}", wait_reason(reason, host)),
                None => format!(
                    "Waiting: {} message(s) here start when earlier work finishes",
                    waiting.len()
                ),
            })
        }
        Some(host) => Some(match host.interactive_wait {
            Some(reason) => format!("New work waits: {}", wait_reason(reason, host)),
            None => format!(
                "Host OK · CPU pressure {}% · {:.0} GiB free",
                host.cpu_pressure_pct,
                host.memory_available_mib as f64 / 1024.0
            ),
        }),
        None if !waiting.is_empty() => Some(format!(
            "Waiting: {} message(s) here start automatically",
            waiting.len()
        )),
        None => None,
    };
    WindowSummary {
        headline,
        host: host_line,
    }
}
