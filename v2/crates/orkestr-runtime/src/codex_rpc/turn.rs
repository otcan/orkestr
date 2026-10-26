//! Correlated Codex 0.163 turn evidence. Parsing never grants process authority.
use crate::{ports::Blocker, ports::ProviderEvent};
use serde_json::Value;
use std::collections::VecDeque;
#[cfg(test)]
mod capacity_tests;
#[cfg(test)]
mod model_tests;
mod models;
mod text;
pub use text::ASYNC_QUESTION_PREFIX;

/// One fresh owned native thread and one submitted request, never a resumed
/// connection. Native identifiers and output are deliberately absent from Debug.
pub struct TurnStream {
    thread: String,
    request: u64,
    turn: Option<String>,
    acknowledged: bool,
    started: bool,
    terminal: Option<ProviderEvent>,
    events: VecDeque<ProviderEvent>,
    poisoned: bool,
    interrupt_claimed: bool,
    text: text::TurnText,
    models: models::Models,
    /// A capacity fallback retry of the same run: Core already holds Started.
    suppress_started: bool,
    /// A capacity/overload terminal withheld from Core until Runtime decides
    /// on the one fallback retry. `true`: the broker proved no side effect.
    capacity_hold: Option<bool>,
    /// The native turn produced its first model item or text.
    activity: bool,
    /// Runtime's own stall interrupt (never a Core stop) and its reply.
    watchdog: Option<u64>,
    watchdog_acked: bool,
    /// A terminal that arrived while the stall interrupt's reply was still
    /// outstanding: delivered once the reply frees the channel.
    deferred: Option<ProviderEvent>,
    /// A committed Core stop adopted this stream: no capacity hold, and an
    /// `interrupted` terminal is Stopped again.
    stop_adopted: bool,
    /// When `turn/started` arrived, for the stall watchdog.
    started_at: Option<std::time::Instant>,
}
impl TurnStream {
    /// Protocol correlation only. The process layer separately consumes Core's
    /// non-Clone dispatch before submitting the request represented here.
    pub fn new(thread: &str, request: u64) -> Result<Self, Blocker> {
        if thread.is_empty() || thread.len() > 512 || request == 0 {
            return Err(Blocker::Protocol);
        }
        Ok(Self {
            thread: thread.into(),
            request,
            turn: None,
            acknowledged: false,
            started: false,
            terminal: None,
            events: VecDeque::new(),
            poisoned: false,
            interrupt_claimed: false,
            text: text::TurnText::default(),
            models: Default::default(),
            suppress_started: false,
            capacity_hold: None,
            activity: false,
            watchdog: None,
            watchdog_acked: false,
            deferred: None,
            stop_adopted: false,
            started_at: None,
        })
    }
    /// When the native turn started (the stall watchdog's clock).
    pub(crate) fn started_at(&self) -> Option<std::time::Instant> {
        self.started_at
    }
    /// The outstanding stall interrupt: its request id and whether its reply
    /// has arrived. A Core stop adopts it instead of sending another.
    pub(crate) fn stall_interrupt(&self) -> Option<(u64, bool)> {
        self.watchdog.map(|request| (request, self.watchdog_acked))
    }
    /// Adopt this stream for a committed Core stop: a held capacity terminal
    /// is released as Stopped and no later terminal is ever held.
    pub(crate) fn adopt_stop(&mut self) -> Result<(), Blocker> {
        // The stopping reader correlates the stall interrupt's reply itself.
        self.stop_adopted = true;
        if let Some(event) = self.deferred.take() {
            return self.queue(event);
        }
        if self.capacity_hold.take().is_some() {
            self.terminal = Some(ProviderEvent::Stopped);
            return self.queue(ProviderEvent::Stopped);
        }
        Ok(())
    }
    /// Whether the turn is acknowledged, started, still silent and open.
    pub(crate) fn stalled_candidate(&self) -> bool {
        !self.poisoned
            && self.acknowledged
            && self.started
            && !self.activity
            && self.terminal.is_none()
            && self.events.is_empty()
            && !self.interrupt_claimed
            && !self.text.asked_question()
    }
    /// Runtime's stall interrupt for a silent turn (no Core stop). Its
    /// `interrupted` terminal becomes a held capacity terminal.
    pub(crate) fn claim_stall_interrupt(&mut self, request: u64) -> Result<Value, Blocker> {
        if !self.stalled_candidate() {
            return Err(Blocker::Protocol);
        }
        let frame = self.claim_interrupt(request)?;
        self.watchdog = Some(request);
        Ok(frame)
    }
    /// A stall interrupt was sent and its reply has not arrived yet.
    pub(crate) fn stall_reply_pending(&self) -> bool {
        self.watchdog.is_some() && !self.watchdog_acked
    }
    /// The same run's one capacity fallback turn on the same native thread.
    /// Only a held, side-effect-free capacity terminal permits it.
    pub(crate) fn fallback_retry(&self, request: u64) -> Result<Self, Blocker> {
        if self.poisoned
            || (self.interrupt_claimed && self.watchdog.is_none())
            || self.stall_reply_pending()
            || self.capacity_hold != Some(true)
            || request <= self.request
            || request >= (1_u64 << 53)
        {
            return Err(Blocker::Protocol);
        }
        let mut next = Self::new(&self.thread, request)?;
        next.suppress_started = true;
        Ok(next)
    }
    /// `Some(side_effect_free)` while a capacity terminal is withheld.
    pub(crate) fn capacity_held(&self) -> Option<bool> {
        self.capacity_hold
    }
    /// Deliver the withheld capacity terminal (closed `provider` class).
    pub(crate) fn release_capacity_hold(&mut self) -> Result<(), Blocker> {
        if self.capacity_hold.take().is_none() {
            return Err(Blocker::Protocol);
        }
        let event = self.terminal.clone().ok_or(Blocker::Protocol)?;
        self.queue(event)
    }
    pub(crate) fn request(&self) -> u64 {
        self.request
    }
    /// The model this turn is known to run on (native evidence), if any.
    pub(crate) fn current_model(&self) -> Option<&str> {
        self.models.current()
    }
    pub fn next_event(&mut self) -> Option<ProviderEvent> {
        if self.acknowledged {
            self.events.pop_front()
        } else {
            None
        }
    }
    pub(crate) fn report_model(&mut self, model: Option<&str>) {
        self.models.initialize(model);
    }
    pub(crate) fn take_model_observation(
        &mut self,
    ) -> Option<orkestr_v2_contracts::ExecutionModelObservation> {
        self.models.take()
    }
    pub(crate) fn renewal_quiescent(&self) -> bool {
        !self.poisoned
            && self.acknowledged
            && self.started
            && self.terminal.is_none()
            && self.events.is_empty()
            && !self.interrupt_claimed
    }
    pub fn terminal(&self) -> Option<&ProviderEvent> {
        self.terminal.as_ref()
    }
    /// Correlation only. The reuse adapter separately requires durable acceptance
    /// and a fresh consumed Core capability before transferring the owned child.
    pub(crate) fn completed_continuation(&self) -> Result<(String, u64), Blocker> {
        if self.poisoned
            || !self.acknowledged
            || (self.interrupt_claimed && !(self.watchdog.is_some() && self.watchdog_acked))
            || self.deferred.is_some()
            || !self.events.is_empty()
            || !matches!(self.terminal, Some(ProviderEvent::CompletedProposal { .. }))
        {
            return Err(Blocker::Protocol);
        }
        let next = self
            .request
            .checked_add(1)
            .filter(|next| *next < (1_u64 << 53))
            .ok_or(Blocker::Protocol)?;
        Ok((self.thread.clone(), next))
    }
    /// Protocol correlation only: the caller still needs issued cancellation
    /// authority around every actual write. Failure never permits retry.
    #[allow(
        dead_code,
        reason = "sealed cancellation transport is being integrated"
    )]
    pub(crate) fn claim_interrupt(&mut self, request: u64) -> Result<Value, Blocker> {
        if self.poisoned
            || !self.acknowledged
            || !self.started
            || self.terminal.is_some()
            || self.interrupt_claimed
            || request == 0
            || request == self.request
            || request >= (1_u64 << 53)
        {
            return Err(Blocker::Protocol);
        }
        let turn = self.turn.as_ref().ok_or(Blocker::Protocol)?;
        self.interrupt_claimed = true;
        Ok(serde_json::json!({"id":request,"method":"turn/interrupt",
            "params":{"threadId":self.thread,"turnId":turn}}))
    }
    pub fn finish(&mut self) -> Result<(), Blocker> {
        if self.poisoned || !self.acknowledged || self.terminal.is_none() {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        Ok(())
    }
    pub fn receive(&mut self, line: &str) -> Result<(), Blocker> {
        if self.poisoned {
            return Err(Blocker::Protocol);
        }
        let result = self.decode(line);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn turn_id(&mut self, id: &str) -> Result<(), Blocker> {
        if id.is_empty() || id.len() > 512 {
            return Err(Blocker::Protocol);
        }
        if self.turn.as_deref().is_some_and(|old| old != id) {
            return Err(Blocker::StaleLease);
        }
        self.turn = Some(id.into());
        Ok(())
    }
    fn queue(&mut self, event: ProviderEvent) -> Result<(), Blocker> {
        if self.events.len() >= 4 {
            return Err(Blocker::QueueFull);
        }
        self.events.push_back(event);
        Ok(())
    }
    fn decode(&mut self, line: &str) -> Result<(), Blocker> {
        if line.len() > 64 * 1024 {
            return Err(Blocker::Protocol);
        }
        let value: Value = serde_json::from_str(line).map_err(|_| Blocker::Protocol)?;
        if let Some(watchdog) = self
            .watchdog
            .filter(|_| !self.watchdog_acked && !self.stop_adopted)
        {
            if value.get("method").is_none()
                && value.get("id").and_then(Value::as_u64) == Some(watchdog)
            {
                // A late interrupt (the turn already ended) may be refused by
                // the native; either reply only frees the channel.
                if !(value.get("result") == Some(&serde_json::json!({}))
                    || value.get("error").is_some_and(Value::is_object))
                {
                    return Err(Blocker::Protocol);
                }
                self.watchdog_acked = true;
                if let Some(event) = self.deferred.take() {
                    self.queue(event)?;
                }
                return Ok(());
            }
        }
        if value.get("id").is_some() {
            // Requests from the server are never interpreted as replies or grants.
            if value.get("method").is_some()
                || value.get("id").and_then(Value::as_u64) != Some(self.request)
                || self.acknowledged
            {
                return Err(Blocker::Protocol);
            }
            if let Some(error) = value.get("error") {
                if error.get("code").and_then(Value::as_i64).is_none()
                    || error
                        .get("message")
                        .and_then(Value::as_str)
                        .is_none_or(|message| message.len() > 8192)
                {
                    return Err(Blocker::Protocol);
                }
                if value.get("result").is_some() || self.started || self.terminal.is_some() {
                    return Err(Blocker::Protocol);
                }
                self.acknowledged = true;
                self.terminal = Some(ProviderEvent::Failed);
                return self.queue(ProviderEvent::Failed);
            }
            let turn = value.pointer("/result/turn").ok_or(Blocker::Protocol)?;
            self.turn_id(text(turn, "id")?)?;
            if text(turn, "status")? != "inProgress" {
                return Err(Blocker::Protocol);
            }
            self.acknowledged = true;
            return Ok(());
        }
        let method = text(&value, "method")?;
        if method == "model/observed" {
            // Broker-normalized native settings evidence, scoped to the exact
            // owned request even when it arrives before turn/start's reply.
            // Optional metadata never creates turn, start or terminal evidence.
            if let Some(params) = value.get("params") {
                if self.terminal.is_none()
                    && !self.interrupt_claimed
                    && params.get("threadId").and_then(Value::as_str) == Some(self.thread.as_str())
                    && params.get("requestId").and_then(Value::as_u64) == Some(self.request)
                {
                    self.models
                        .confirm(params.get("model").and_then(Value::as_str));
                }
            }
            return Ok(());
        }
        if !matches!(
            method,
            "turn/started"
                | "turn/completed"
                | "item/agentMessage/delta"
                | "item/started"
                | "item/completed"
                | "model/rerouted"
                | "turn/activity"
        ) {
            return Ok(());
        }
        let params = value.get("params").ok_or(Blocker::Protocol)?;
        if text(params, "threadId")? != self.thread {
            return Err(Blocker::StaleLease);
        }
        if method == "turn/activity" {
            // Broker's closed marker: the first model item of this turn.
            self.turn_id(text(params, "turnId")?)?;
            if self.terminal.is_some() {
                return Err(Blocker::Protocol);
            }
            self.activity = true;
            return Ok(());
        }
        if method == "model/rerouted" {
            self.turn_id(text(params, "turnId")?)?;
            if self.terminal.is_some() {
                return Err(Blocker::Protocol);
            }
            return self.models.reroute(text(params, "toModel")?);
        }
        if matches!(
            method,
            "item/agentMessage/delta" | "item/started" | "item/completed"
        ) {
            self.turn_id(text(params, "turnId")?)?;
            if self.terminal.is_some() {
                return Err(Blocker::Protocol);
            }
            if method == "item/agentMessage/delta" || method == "item/started" {
                self.activity = true;
            }
            if let Some(snapshot) = self.text.receive(method, params)? {
                self.models.answered();
                self.queue(ProviderEvent::Progress(snapshot))?;
            }
            return Ok(());
        }
        let turn = params.get("turn").ok_or(Blocker::Protocol)?;
        self.turn_id(text(turn, "id")?)?;
        let status = text(turn, "status")?;
        if method == "turn/started" {
            if status != "inProgress" || self.terminal.is_some() {
                return Err(Blocker::Protocol);
            }
            if !self.started {
                if !self.suppress_started {
                    self.queue(ProviderEvent::Started)?;
                }
                self.started = true;
                self.started_at = Some(std::time::Instant::now());
            }
            return Ok(());
        }
        // Runtime's own stall interrupt ends a silent, overloaded turn.
        let capacity = (status == "failed" && capacity_error(turn)?)
            || (status == "interrupted" && self.watchdog.is_some() && !self.stop_adopted);
        let event = match status {
            "completed" => ProviderEvent::CompletedProposal { synthetic: false },
            // Capacity/overload is the provider's closed `provider` class.
            "failed" | "interrupted" if capacity => {
                ProviderEvent::FailedWith(orkestr_v2_contracts::ExecutionFailureClass::Provider)
            }
            "failed" => ProviderEvent::Failed,
            "interrupted" => ProviderEvent::Stopped,
            _ => return Err(Blocker::Protocol),
        };
        if let Some(original) = &self.terminal {
            return if original == &event {
                Ok(())
            } else {
                Err(Blocker::Protocol)
            };
        }
        if matches!(event, ProviderEvent::CompletedProposal { .. }) {
            if let Some(snapshot) = self.text.finish(turn)? {
                self.models.answered();
                self.queue(ProviderEvent::Progress(snapshot))?;
            }
        }
        if capacity && !self.stop_adopted {
            // Withheld: Runtime retries once on the fallback model or delivers
            // it. Only the broker's explicit `sideEffects: false` and no
            // delivered async question make the turn side-effect free.
            let clean =
                turn.get("sideEffects") == Some(&Value::Bool(false)) && !self.text.asked_question();
            self.terminal = Some(event);
            self.capacity_hold = Some(clean);
            return Ok(());
        }
        self.terminal = Some(event.clone());
        if self.stall_reply_pending() && !self.stop_adopted {
            self.deferred = Some(event);
            return Ok(());
        }
        self.queue(event)
    }
}
/// The broker's closed failure evidence: absent, or exactly `capacity`.
fn capacity_error(turn: &Value) -> Result<bool, Blocker> {
    match turn.get("error") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Object(error))
            if error.len() == 1
                && error.get("class").and_then(Value::as_str) == Some("capacity") =>
        {
            Ok(true)
        }
        Some(_) => Err(Blocker::Protocol),
    }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Blocker> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(Blocker::Protocol)
}

#[cfg(test)]
mod interrupt_tests {
    use super::*;

    fn active() -> TurnStream {
        let mut stream = TurnStream::new("thread-owned", 1).unwrap();
        stream.acknowledged = true;
        stream.started = true;
        stream.turn = Some("turn-owned".into());
        stream
    }

    #[test]
    fn interrupt_is_once_and_does_not_invent_terminal_evidence() {
        let mut stream = active();
        let frame = stream.claim_interrupt(2).unwrap();
        assert_eq!(
            frame,
            serde_json::json!({"id":2,"method":"turn/interrupt",
            "params":{"threadId":"thread-owned","turnId":"turn-owned"}})
        );
        assert_eq!(stream.claim_interrupt(3), Err(Blocker::Protocol));
        assert!(stream.terminal().is_none());
        assert!(stream.next_event().is_none());
    }

    #[test]
    fn incomplete_poisoned_or_terminal_turn_never_issues_interrupt() {
        for mutation in 0..8 {
            let mut stream = active();
            match mutation {
                0 => stream.acknowledged = false,
                1 => stream.started = false,
                2 => stream.turn = None,
                3 => stream.poisoned = true,
                4 => stream.terminal = Some(ProviderEvent::CompletedProposal { synthetic: false }),
                5 => stream.terminal = Some(ProviderEvent::Failed),
                6 => stream.terminal = Some(ProviderEvent::Lost),
                _ => stream.terminal = Some(ProviderEvent::Stopped),
            }
            let original = stream.terminal.clone();
            assert_eq!(stream.claim_interrupt(2), Err(Blocker::Protocol));
            assert_eq!(stream.terminal, original);
        }
        for request in [0, 1, 1_u64 << 53] {
            assert_eq!(active().claim_interrupt(request), Err(Blocker::Protocol));
        }
    }
}
