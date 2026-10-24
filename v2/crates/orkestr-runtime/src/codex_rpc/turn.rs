//! Correlated Codex 0.163 turn evidence. Parsing never grants process authority.
use crate::{ports::Blocker, ports::ProviderEvent};
use serde_json::Value;
use std::collections::VecDeque;
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
        })
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
            || self.interrupt_claimed
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
        if !matches!(
            method,
            "turn/started"
                | "turn/completed"
                | "item/agentMessage/delta"
                | "item/started"
                | "item/completed"
                | "model/rerouted"
        ) {
            return Ok(());
        }
        let params = value.get("params").ok_or(Blocker::Protocol)?;
        if text(params, "threadId")? != self.thread {
            return Err(Blocker::StaleLease);
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
                self.queue(ProviderEvent::Started)?;
                self.started = true;
            }
            return Ok(());
        }
        let event = match status {
            "completed" => ProviderEvent::CompletedProposal { synthetic: false },
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
        self.queue(event.clone())?;
        self.terminal = Some(event);
        Ok(())
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
