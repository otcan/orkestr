//! Bounded Claude Code stream-JSON observations for one owned print invocation.
//! No process launch, account check, input serialization, or execution authority.
use crate::ports::Blocker;
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_STRING_BYTES: usize = 8 * 1024;
const MAX_KEY_BYTES: usize = 128;
const MAX_DEPTH: usize = 16;
const MAX_COLLECTION: usize = 128;
const MAX_NODES: usize = 2048;

/// Metadata only: never a canonical run transition or a payload-store reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeObservation {
    /// Session metadata, not proof of authentication or dispatch acknowledgement.
    Initialized,
    /// Bounded assistant content or a tool-result message was observed.
    Progress,
    /// A provider result that still requires independent application acceptance.
    CompletedProposal,
    /// Explicit provider error; only `terminal_result_seen` proves a result frame.
    Failed,
}

/// One parser per owned invocation, with a distinct native session per role.
/// The local request key is supplied by the owner, not echoed by Claude. Neither
/// native identifiers nor raw content are retained in Debug, errors or outputs.
/// This object cannot grant dispatch authority or enforce global session uniqueness.
pub struct ClaudeRpc {
    session: String,
    request_key: String,
    initialized: bool,
    terminal: bool,
    poisoned: bool,
    failure_seen: bool,
    telemetry_ids: HashSet<String>,
}

impl ClaudeRpc {
    pub fn new(native_session: &str, local_request_key: &str) -> Result<Self, Blocker> {
        if !uuid(native_session)
            || local_request_key.is_empty()
            || local_request_key.len() > MAX_KEY_BYTES
            || !local_request_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        {
            return Err(Blocker::Protocol);
        }
        Ok(Self {
            session: native_session.to_ascii_lowercase(),
            request_key: local_request_key.to_owned(),
            initialized: false,
            terminal: false,
            poisoned: false,
            failure_seen: false,
            telemetry_ids: HashSet::new(),
        })
    }

    /// Accept one complete line without its newline delimiter. The owner must
    /// keep transport framing/truncated-EOF failures distinct from clean EOF.
    /// Any error quarantines this parser permanently; there is no retry/reset.
    pub fn receive(
        &mut self,
        local_request_key: &str,
        line: &str,
    ) -> Result<Option<ClaudeObservation>, Blocker> {
        let result = self.receive_inner(local_request_key, line);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    /// A result frame is not proof of child exit, successful cleanup, or task
    /// acceptance. A poisoned connection is unusable even if this returns true.
    pub fn terminal_result_seen(&self) -> bool {
        self.terminal
    }

    /// Clean EOF is valid only after a terminal result with no protocol error.
    /// Reconnect must not recreate an already-consumed dispatch grant.
    pub fn finish(&mut self, local_request_key: &str) -> Result<(), Blocker> {
        let result = if self.poisoned {
            Err(Blocker::Protocol)
        } else if local_request_key != self.request_key {
            Err(Blocker::StaleLease)
        } else if !self.terminal {
            Err(Blocker::Protocol)
        } else {
            Ok(())
        };
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    fn receive_inner(
        &mut self,
        local_request_key: &str,
        line: &str,
    ) -> Result<Option<ClaudeObservation>, Blocker> {
        if self.poisoned {
            return Err(Blocker::Protocol);
        }
        if local_request_key != self.request_key {
            return Err(Blocker::StaleLease);
        }
        if line.is_empty()
            || line.len() > MAX_FRAME_BYTES
            || line.bytes().any(|b| matches!(b, b'\n' | b'\r' | 0))
        {
            return Err(Blocker::Protocol);
        }
        let value: Value = serde_json::from_str(line).map_err(|_| Blocker::Protocol)?;
        bounded(&value, 0, &mut 0)?;
        if !value.is_object() {
            return Err(Blocker::Protocol);
        }
        unique_keys(line)?;
        self.identity(text(&value, "session_id")?)?;
        // Legacy wrappers may repeat identity. Never accept a conflicting alias.
        for alias in [
            value.get("sessionId"),
            value.pointer("/message/session_id"),
            value.pointer("/message/sessionId"),
        ]
        .into_iter()
        .flatten()
        {
            self.identity(alias.as_str().ok_or(Blocker::Protocol)?)?;
        }
        let kind = text(&value, "type")?;
        // Closed sanitized housekeeping is permitted around the terminal frame;
        // it never changes initialization, result, or semantic progress state.
        if kind == "command_lifecycle"
            || (kind == "rate_limit_event" && value.get("uuid").is_some())
        {
            telemetry::accept(&value, &mut self.telemetry_ids)?;
            return Ok(None);
        }
        if self.terminal {
            return Err(Blocker::Protocol);
        }
        let nested = match value.get("parent_tool_use_id") {
            None | Some(Value::Null) => false,
            Some(Value::String(id)) if !id.is_empty() && id.len() <= MAX_KEY_BYTES => true,
            _ => return Err(Blocker::Protocol),
        };
        match text(&value, "type")? {
            "system" => {
                if text(&value, "subtype")? != "init" {
                    return Err(Blocker::Unsupported);
                }
                if self.initialized || self.failure_seen || nested {
                    return Err(Blocker::Protocol);
                }
                self.initialized = true;
                Ok(Some(ClaudeObservation::Initialized))
            }
            // Housekeeping is not evidence of semantic progress or dispatch.
            "rate_limit_event" => Ok(None),
            "assistant" | "user" => self.message(&value),
            "result" => self.result(&value, nested),
            _ => Err(Blocker::Unsupported),
        }
    }

    fn identity(&self, session: &str) -> Result<(), Blocker> {
        if !uuid(session) {
            Err(Blocker::Protocol)
        } else if !session.eq_ignore_ascii_case(&self.session) {
            Err(Blocker::StaleLease)
        } else {
            Ok(())
        }
    }

    fn message(&mut self, value: &Value) -> Result<Option<ClaudeObservation>, Blocker> {
        let kind = text(value, "type")?;
        let message = value
            .get("message")
            .filter(|m| m.is_object())
            .ok_or(Blocker::Protocol)?;
        if message
            .get("role")
            .is_some_and(|role| role.as_str() != Some(kind))
        {
            return Err(Blocker::Protocol);
        }
        let content = message
            .get("content")
            .and_then(Value::as_array)
            .ok_or(Blocker::Protocol)?;
        let mut tool_result = false;
        for block in content {
            let block_type = text(block, "type")?;
            tool_result |= block_type == "tool_result";
        }
        if let Some(error) = value.get("error") {
            if kind != "assistant" || !error.as_str().is_some_and(|e| !e.is_empty()) {
                return Err(Blocker::Protocol);
            }
            // Some provider failures arrive as an assistant notice followed by
            // a result. Keep draining that result; never resurrect this as success.
            self.failure_seen = true;
            return Ok(Some(ClaudeObservation::Failed));
        }
        if !self.initialized {
            return Err(Blocker::Protocol);
        }
        if self.failure_seen || content.is_empty() || (kind == "user" && !tool_result) {
            return Ok(None);
        }
        // Content, including tool arguments and nested agent text, stays opaque.
        Ok(Some(ClaudeObservation::Progress))
    }

    fn result(
        &mut self,
        value: &Value,
        nested: bool,
    ) -> Result<Option<ClaudeObservation>, Blocker> {
        if nested {
            return Err(Blocker::Protocol);
        }
        let subtype = text(value, "subtype")?;
        let is_error = value
            .get("is_error")
            .and_then(Value::as_bool)
            .ok_or(Blocker::Protocol)?;
        if value.get("result").is_some_and(|r| !r.is_string()) {
            return Err(Blocker::Protocol);
        }
        let observation = if is_error {
            self.failure_seen = true;
            ClaudeObservation::Failed
        } else {
            if subtype != "success" {
                return Err(Blocker::Unsupported);
            }
            if !self.initialized
                || self.failure_seen
                || !value.get("result").is_some_and(Value::is_string)
            {
                return Err(Blocker::Protocol);
            }
            ClaudeObservation::CompletedProposal
        };
        self.terminal = true;
        Ok(Some(observation))
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Blocker> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= MAX_KEY_BYTES)
        .ok_or(Blocker::Protocol)
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

// Syntax was already checked by serde_json. Scan only object keys so duplicate
// fields cannot silently replace identity/result flags (including escaped keys).
fn unique_keys(line: &str) -> Result<(), Blocker> {
    let bytes = line.as_bytes();
    let mut objects: Vec<HashSet<String>> = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'{' => objects.push(HashSet::new()),
            b'}' => {
                objects.pop().ok_or(Blocker::Protocol)?;
            }
            b'"' => {
                let start = cursor;
                cursor += 1;
                while cursor < bytes.len() {
                    match bytes[cursor] {
                        b'\\' => cursor += 2,
                        b'"' => {
                            cursor += 1;
                            break;
                        }
                        _ => cursor += 1,
                    }
                }
                let end = cursor;
                while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
                    cursor += 1;
                }
                if bytes.get(cursor) == Some(&b':') {
                    let key: String =
                        serde_json::from_str(&line[start..end]).map_err(|_| Blocker::Protocol)?;
                    if !objects.last_mut().ok_or(Blocker::Protocol)?.insert(key) {
                        return Err(Blocker::Protocol);
                    }
                }
                continue;
            }
            _ => {}
        }
        cursor += 1;
    }
    Ok(())
}

fn bounded(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), Blocker> {
    *nodes += 1;
    if depth > MAX_DEPTH || *nodes > MAX_NODES {
        return Err(Blocker::Protocol);
    }
    match value {
        Value::String(s) if s.len() > MAX_STRING_BYTES => return Err(Blocker::Protocol),
        Value::Array(items) => {
            if items.len() > MAX_COLLECTION {
                return Err(Blocker::Protocol);
            }
            for item in items {
                bounded(item, depth + 1, nodes)?;
            }
        }
        Value::Object(fields) => {
            if fields.len() > MAX_COLLECTION || fields.keys().any(|k| k.len() > MAX_KEY_BYTES) {
                return Err(Blocker::Protocol);
            }
            for value in fields.values() {
                bounded(value, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
#[path = "claude_rpc/tests.rs"]
mod tests;

mod telemetry;
