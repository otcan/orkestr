//! Correlated Codex 0.163 turn evidence. Parsing never grants process authority.
use crate::{ports::Blocker, ports::ProviderEvent};
use serde_json::Value;
use std::collections::VecDeque;

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
        })
    }
    pub fn next_event(&mut self) -> Option<ProviderEvent> {
        if self.acknowledged {
            self.events.pop_front()
        } else {
            None
        }
    }
    pub fn terminal(&self) -> Option<&ProviderEvent> {
        self.terminal.as_ref()
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
            "turn/started" | "turn/completed" | "item/agentMessage/delta"
        ) {
            return Ok(());
        }
        let params = value.get("params").ok_or(Blocker::Protocol)?;
        if text(params, "threadId")? != self.thread {
            return Err(Blocker::StaleLease);
        }
        if method == "item/agentMessage/delta" {
            self.turn_id(text(params, "turnId")?)?;
            if self.terminal.is_some() {
                return Err(Blocker::Protocol);
            }
            let delta = text(params, "delta")?;
            if delta.len() > 8192 {
                return Err(Blocker::Protocol);
            }
            return self.queue(ProviderEvent::Progress(delta.into()));
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
