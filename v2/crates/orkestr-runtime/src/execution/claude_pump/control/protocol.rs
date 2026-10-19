//! Correlated interrupted terminal evidence. This type issues no Core event.
use crate::{
    broker::claude::control::{canonical_uuid, REQUEST},
    ports::Blocker,
};
use serde_json::{json, Value};

pub(super) struct StopEvidence {
    native: String,
    input: String,
    acknowledged: bool,
    terminal: Option<String>,
    poisoned: bool,
}

impl StopEvidence {
    pub(super) fn new(native: &str, input: &str) -> Result<Self, Blocker> {
        if !canonical_uuid(native) || !canonical_uuid(input) || native == input {
            return Err(Blocker::Protocol);
        }
        Ok(Self {
            native: native.into(),
            input: input.into(),
            acknowledged: false,
            terminal: None,
            poisoned: false,
        })
    }
    pub(super) fn acknowledged(&self) -> bool {
        self.acknowledged
    }
    pub(super) fn terminal_seen(&self) -> bool {
        self.terminal.is_some()
    }
    pub(super) fn confirmed(&self) -> bool {
        !self.poisoned && self.acknowledged && self.terminal.is_some()
    }
    /// Only the closed broker projection arrives here. Raw errors and provider
    /// content are never retained. Either ACK/terminal ordering is supported.
    pub(super) fn receive(&mut self, frame: &Value) -> Result<(), Blocker> {
        if self.poisoned {
            return Err(Blocker::Protocol);
        }
        let result = self.decode(frame);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn decode(&mut self, frame: &Value) -> Result<(), Blocker> {
        if frame.get("type").and_then(Value::as_str) == Some("control_response") {
            let expected = json!({"type":"control_response","response":{
                "subtype":"success","request_id":REQUEST,"response":{"turn":"stopped"}}});
            if self.acknowledged || frame != &expected {
                return Err(Blocker::Protocol);
            }
            self.acknowledged = true;
            return Ok(());
        }
        let fields = frame.as_object().ok_or(Blocker::Protocol)?;
        if self.terminal.is_some()
            || fields.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "type"
                        | "session_id"
                        | "uuid"
                        | "user_message_uuid"
                        | "user_message_uuids"
                        | "subtype"
                        | "is_error"
                        | "terminal_reason"
                )
            })
            || fields.len()
                != if fields.contains_key("user_message_uuids") {
                    8
                } else {
                    7
                }
            || frame.get("type").and_then(Value::as_str) != Some("result")
            || frame.get("session_id").and_then(Value::as_str) != Some(&self.native)
            || frame.get("user_message_uuid").and_then(Value::as_str) != Some(&self.input)
            || frame
                .get("user_message_uuids")
                .is_some_and(|ids| ids != &json!([self.input]))
            || frame.get("subtype").and_then(Value::as_str) != Some("error_during_execution")
            || frame.get("is_error") != Some(&Value::Bool(true))
            || frame.get("terminal_reason").and_then(Value::as_str) != Some("aborted_streaming")
        {
            return Err(Blocker::Protocol);
        }
        let id = frame
            .get("uuid")
            .and_then(Value::as_str)
            .ok_or(Blocker::Protocol)?;
        if !canonical_uuid(id) || id == self.native || id == self.input {
            return Err(Blocker::Protocol);
        }
        self.terminal = Some(id.into());
        Ok(())
    }
}

#[cfg(test)]
mod tests;
