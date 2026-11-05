//! Sealed correlation from the owned native channel. It supplies no admission.
use crate::ports::Blocker;
use orkestr_v2_store_sqlite::DeskLoginNativeCall;
use serde_json::{json, Value};
use std::sync::Arc;
pub struct PendingDeskLoginCall {
    call: DeskLoginNativeCall,
    lineage: Arc<()>,
}
impl PendingDeskLoginCall {
    pub fn native_call(&self) -> DeskLoginNativeCall {
        self.call.clone()
    }
    pub(crate) fn matches_lineage(&self, lineage: &Arc<()>) -> bool {
        Arc::ptr_eq(&self.lineage, lineage)
    }
    pub(crate) fn decode(
        frame: &Value,
        native: &str,
        turn: &str,
        lineage: Arc<()>,
    ) -> Result<Self, Blocker> {
        exact(frame, &["id", "method", "params"])?;
        let p = &frame["params"];
        let mut fields = vec!["tool", "arguments", "callId", "threadId", "turnId"];
        if p.get("namespace").is_some() {
            fields.push("namespace");
        }
        exact(p, &fields)?;
        let request = &frame["id"];
        let valid = match request {
            Value::String(s) => !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control),
            Value::Number(n) => n.as_u64().is_some_and(|n| n < 1 << 53),
            _ => false,
        };
        if !valid
            || frame["method"] != "item/tool/call"
            || p["tool"] != "orkestr_desk_login"
            || p.get("namespace").is_some_and(|v| !v.is_null())
            || p["threadId"] != native
            || p["turnId"] != turn
        {
            return Err(Blocker::Protocol);
        }
        exact(&p["arguments"], &["operation_id"])?;
        let key = |v: &Value| {
            v.as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
                })
                .map(str::to_owned)
                .ok_or(Blocker::Protocol)
        };
        Ok(Self {
            call: DeskLoginNativeCall {
                request_id: request.clone(),
                call_id: key(&p["callId"])?,
                thread_id: native.into(),
                turn_id: turn.into(),
                operation_id: key(&p["arguments"]["operation_id"])?,
            },
            lineage,
        })
    }
}
fn exact(v: &Value, fields: &[&str]) -> Result<(), Blocker> {
    let v = v.as_object().ok_or(Blocker::Protocol)?;
    if v.len() != fields.len() || fields.iter().any(|k| !v.contains_key(*k)) {
        return Err(Blocker::Protocol);
    }
    Ok(())
}
pub(crate) fn advertisement() -> Value {
    json!({"type":"function","name":"orkestr_desk_login","description":"Request one operator-approved desk login by operation ID. No command, credential, path, conversation or environment is accepted.","inputSchema":{"type":"object","properties":{"operation_id":{"type":"string","maxLength":128}},"required":["operation_id"],"additionalProperties":false}})
}
pub(crate) fn enable(frame: &mut Value) {
    match frame["method"].as_str() {
        Some("initialize") => frame["params"]["capabilities"]["experimentalApi"] = json!(true),
        Some("thread/start") => frame["params"]["dynamicTools"] = json!([advertisement()]),
        _ => {}
    }
}
