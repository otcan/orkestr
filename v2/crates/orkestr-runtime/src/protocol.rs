//! Bounded, offline protocol decoding. These are candidate adapter boundaries,
//! not proof of authentication, subscription entitlement or live execution.
use crate::ports::{Blocker, ProviderEvent};
use serde_json::Value;
const MAX_FRAME: usize = 64 * 1024;
const MAX_PROGRESS: usize = 8 * 1024;

fn frame(line: &str) -> Result<Value, Blocker> {
    if line.len() > MAX_FRAME {
        return Err(Blocker::Protocol);
    }
    serde_json::from_str(line).map_err(|_| Blocker::Protocol)
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Blocker> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(Blocker::Protocol)
}

/// Ignores unrelated notifications, refuses wrong-thread/wrong-turn events.
/// Provider completion is a proposal; application evidence gates still apply.
pub fn codex_event(line: &str, thread: &str, turn: &str) -> Result<Option<ProviderEvent>, Blocker> {
    let value = frame(line)?;
    let method = text(&value, "method")?;
    if !matches!(
        method,
        "turn/started" | "turn/completed" | "item/agentMessage/delta"
    ) {
        return Ok(None);
    }
    let p = value.get("params").ok_or(Blocker::Protocol)?;
    if text(p, "threadId")? != thread {
        return Err(Blocker::StaleLease);
    }
    if method == "item/agentMessage/delta" {
        if text(p, "turnId")? != turn {
            return Err(Blocker::StaleLease);
        }
        if text(p, "delta")?.len() > MAX_PROGRESS {
            return Err(Blocker::Protocol);
        }
        // No payload store exists yet. Never fabricate a PayloadId or journal
        // raw provider text as metadata; the caller must surface this blocker.
        return Err(Blocker::PayloadUnavailable);
    }
    let t = p.get("turn").ok_or(Blocker::Protocol)?;
    if text(t, "id")? != turn {
        return Err(Blocker::StaleLease);
    }
    let status = text(t, "status")?;
    Ok(Some(match (method, status) {
        ("turn/started", "inProgress") => ProviderEvent::Started,
        ("turn/completed", "completed") => ProviderEvent::CompletedProposal { synthetic: false },
        ("turn/completed", "failed") => ProviderEvent::Failed,
        ("turn/completed", "interrupted") => ProviderEvent::Stopped,
        _ => return Err(Blocker::Protocol),
    }))
}

/// Claude stream-json candidate fixture decoder. Live protocol remains pending.
/// No generic text result is ever interpreted as canonical task success.
pub fn claude_event(line: &str, session: &str) -> Result<Option<ProviderEvent>, Blocker> {
    let value = frame(line)?;
    let kind = text(&value, "type")?;
    if !matches!(kind, "system" | "assistant" | "result") {
        return Ok(None);
    }
    if text(&value, "session_id")? != session {
        return Err(Blocker::StaleLease);
    }
    Ok(match kind {
        // Session metadata is not evidence that a durably admitted turn started.
        // The live adapter must correlate its own dispatch/turn acknowledgement.
        "system" if value.get("subtype").and_then(Value::as_str) == Some("init") => None,
        "assistant" => {
            // Bound candidate content without interpreting tools as commands.
            if value
                .get("message")
                .is_some_and(|message| message.to_string().len() > MAX_PROGRESS)
            {
                return Err(Blocker::Protocol);
            }
            None
        }
        "result" => {
            if value
                .get("result")
                .and_then(Value::as_str)
                .is_some_and(|text| text.len() > MAX_PROGRESS)
            {
                return Err(Blocker::Protocol);
            }
            let subtype = text(&value, "subtype")?;
            let error = value
                .get("is_error")
                .and_then(Value::as_bool)
                .ok_or(Blocker::Protocol)?;
            Some(if subtype == "success" && !error {
                ProviderEvent::CompletedProposal { synthetic: false }
            } else {
                ProviderEvent::Failed
            })
        }
        _ => None,
    })
}

/// Metadata handshake only; deliberately supplies no inference command.
pub fn codex_initialize() -> String {
    serde_json::json!({"id": 1, "method":"initialize", "params":{
        "clientInfo":{"name":"orkestr_v2_probe","title":"Orkestr v2 metadata probe","version":"0.0.1"},
        "capabilities":{"experimentalApi":false}
    }}).to_string()
}
