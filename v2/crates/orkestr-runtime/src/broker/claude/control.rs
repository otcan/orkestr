//! One control on the already-written Claude input. Framing is not authority.
use super::{Blocker, ClaudeChannel, Value};
use std::sync::Arc;

pub(crate) const REQUEST: &str = "interrupt:4";

pub(crate) fn interrupt(input: &str) -> Value {
    serde_json::json!({"type":"control_request","request_id":REQUEST,
        "request":{"subtype":"interrupt","cancel_queued":false,
        "for_user_message_uuids":[input]}})
}

pub(crate) enum ControlFrame {
    Prepared,
    Native(Value),
}

/// Consumes the original channel; neither a caller handle nor a JSON field can
/// construct the lineage. A second control or a failed write cannot reset it.
pub(crate) struct ClaudeControl {
    channel: ClaudeChannel,
    input: String,
    requested: bool,
    prepared: bool,
    writing: bool,
    written: bool,
}

impl ClaudeChannel {
    pub(crate) fn into_control(self, input: &str) -> Result<ClaudeControl, Blocker> {
        if self.poisoned
            || !self.initialized
            || !self.system_seen
            || !self.written
            || !canonical_uuid(input)
        {
            return Err(Blocker::Protocol);
        }
        Ok(ClaudeControl {
            channel: self,
            input: input.into(),
            requested: false,
            prepared: false,
            writing: false,
            written: false,
        })
    }
}

pub(crate) fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value != "00000000-0000-0000-0000-000000000000"
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

impl ClaudeControl {
    pub(crate) fn request(&mut self) -> Result<(Arc<()>, Vec<u8>), Blocker> {
        if self.channel.poisoned || self.requested {
            return Err(Blocker::Protocol);
        }
        // Burn before enqueue. Uncertain acceptance must never permit replay.
        self.requested = true;
        let bytes = serde_json::json!({"id":4,"method":"CancelExecution","params":{
            "owned_handle":self.channel.handle,"frame":interrupt(&self.input)}})
        .to_string()
        .into_bytes();
        Ok((self.channel.lineage.clone(), bytes))
    }

    pub(crate) fn begin_write(&mut self) -> Result<Vec<u8>, Blocker> {
        if self.channel.poisoned || !self.prepared || self.writing || self.written {
            return Err(Blocker::Protocol);
        }
        self.writing = true;
        let mut bytes = interrupt(&self.input).to_string().into_bytes();
        bytes.push(b'\n');
        Ok(bytes)
    }

    pub(crate) fn finish_write(&mut self) -> Result<(), Blocker> {
        if self.channel.poisoned || !self.writing || self.written {
            return Err(Blocker::Protocol);
        }
        self.written = true;
        Ok(())
    }

    pub(crate) fn receive(&mut self, bytes: &[u8]) -> Result<ControlFrame, Blocker> {
        if self.channel.poisoned {
            return Err(Blocker::Protocol);
        }
        let result = self.decode(bytes);
        if result.is_err() {
            self.channel.poisoned = true;
        }
        result
    }

    fn decode(&mut self, bytes: &[u8]) -> Result<ControlFrame, Blocker> {
        if !self.requested || bytes.is_empty() || bytes.len() > 65536 {
            return Err(Blocker::Protocol);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| Blocker::Protocol)?;
        crate::claude_rpc::unique_keys(text)?;
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Blocker::Protocol)?;
        let outer = value.as_object().ok_or(Blocker::Protocol)?;
        let params = value
            .get("params")
            .and_then(Value::as_object)
            .ok_or(Blocker::Protocol)?;
        if outer.len() != 2
            || params.get("owned_handle").and_then(Value::as_str) != Some(&self.channel.handle)
        {
            return Err(Blocker::Protocol);
        }
        match value.get("method").and_then(Value::as_str) {
            Some("BrokerPrepared")
                if params.len() == 2
                    && params.get("request_id").and_then(Value::as_u64) == Some(4)
                    && !self.prepared =>
            {
                self.prepared = true;
                Ok(ControlFrame::Prepared)
            }
            Some("BrokerOutput") if params.len() == 3 => {
                let frame = params.get("frame").ok_or(Blocker::Protocol)?;
                let control = frame.get("type").and_then(Value::as_str) == Some("control_response");
                let expected = if control { 4 } else { 3 };
                if params.get("request_id").and_then(Value::as_u64) != Some(expected)
                    || (control && !self.written)
                    || (!control
                        && frame.get("session_id").and_then(Value::as_str)
                            != Some(&self.channel.native))
                {
                    return Err(Blocker::Protocol);
                }
                // Prior output may already be buffered while control preparation
                // is pending. Only control ACK requires this control's full write.
                Ok(ControlFrame::Native(frame.clone()))
            }
            _ => Err(Blocker::Protocol),
        }
    }
}

#[cfg(test)]
mod tests;
