//! Pending wire correlation only; no tool admission or result-write authority.
//! Routing remains disabled until the trusted profile and delivery fence compose.
use crate::ports::Blocker;
use orkestr_v2_store_sqlite::WorkspaceExecNativeRequestId;
use serde_json::Value;
use std::sync::Arc;

/// Created only by the owned broker decoder, never by browser/tool-result JSON.
/// No Clone/Debug/serialization: callers borrow one outstanding call.
pub struct PendingWorkspaceExecCall {
    request_id: WorkspaceExecNativeRequestId,
    call_id: String,
    thread_id: String,
    turn_id: String,
    source: String,
    lineage: Arc<()>,
}
impl PendingWorkspaceExecCall {
    pub fn request_id(&self) -> &WorkspaceExecNativeRequestId {
        &self.request_id
    }
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }
    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }
    pub fn command(&self) -> &str {
        &self.source
    }
    pub fn source(&self) -> &str {
        &self.source
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
        if frame["method"] != "item/tool/call" || !identifier(native) || !identifier(turn) {
            return Err(Blocker::Protocol);
        }
        let request_id = match &frame["id"] {
            Value::String(s) => WorkspaceExecNativeRequestId::Text(s.clone()),
            Value::Number(n) => {
                WorkspaceExecNativeRequestId::Integer(n.as_u64().ok_or(Blocker::Protocol)?)
            }
            _ => return Err(Blocker::Protocol),
        };
        if !request_id.is_valid() {
            return Err(Blocker::Protocol);
        }
        let params = &frame["params"];
        let mut fields = vec!["arguments", "callId", "threadId", "turnId", "tool"];
        if params.get("namespace").is_some() {
            fields.push("namespace");
        }
        exact(params, &fields)?;
        if params.get("namespace").is_some_and(|v| !v.is_null())
            || params["threadId"] != native
            || params["turnId"] != turn
            || params["tool"] != "orkestr_workspace_exec"
        {
            return Err(Blocker::Protocol);
        }
        let call_id = params["callId"].as_str().ok_or(Blocker::Protocol)?;
        if !identifier(call_id) || call_id.len() > 128 {
            return Err(Blocker::Protocol);
        }
        exact(&params["arguments"], &["command"])?;
        let source = params["arguments"]["command"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 32768 && !s.contains('\0'))
            .ok_or(Blocker::Protocol)?;
        Ok(Self {
            request_id,
            call_id: call_id.into(),
            thread_id: native.into(),
            turn_id: turn.into(),
            source: source.into(),
            lineage,
        })
    }
}
fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
}
fn exact(value: &Value, fields: &[&str]) -> Result<(), Blocker> {
    let object = value.as_object().ok_or(Blocker::Protocol)?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err(Blocker::Protocol);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn frame() -> Value {
        json!({"id":"native:1","method":"item/tool/call","params":{
            "arguments":{"command":"print(1)"},"callId":"call:1",
            "threadId":"native","turnId":"turn:1","tool":"orkestr_workspace_exec"}})
    }
    fn decode(value: &Value) -> Result<PendingWorkspaceExecCall, Blocker> {
        PendingWorkspaceExecCall::decode(value, "native", "turn:1", Arc::new(()))
    }
    #[test]
    fn exact_owned_call_retains_kind_source_and_unforgeable_local_lineage() {
        let lineage = Arc::new(());
        let mut value = frame();
        let pending =
            PendingWorkspaceExecCall::decode(&value, "native", "turn:1", lineage.clone()).unwrap();
        assert!(pending.request_id() == &WorkspaceExecNativeRequestId::Text("native:1".into()));
        assert_eq!(pending.call_id(), "call:1");
        assert_eq!(pending.thread_id(), "native");
        assert_eq!(pending.turn_id(), "turn:1");
        assert_eq!(pending.source(), "print(1)");
        assert!(pending.matches_lineage(&lineage));
        assert!(!pending.matches_lineage(&Arc::new(())));
        value["id"] = json!(1);
        let integer = decode(&value).unwrap();
        assert!(integer.request_id() == &WorkspaceExecNativeRequestId::Integer(1));
        value["params"]["namespace"] = Value::Null;
        assert!(decode(&value).is_ok());
    }
    #[test]
    fn foreign_identity_tools_and_extra_claims_refuse() {
        for (pointer, replacement) in [
            ("/params/threadId", json!("foreign")),
            ("/params/turnId", json!("foreign")),
            ("/params/tool", json!("shell")),
            ("/params/callId", json!("bad\n")),
        ] {
            let mut value = frame();
            *value.pointer_mut(pointer).unwrap() = replacement;
            assert!(decode(&value).is_err());
        }
        for field in ["namespace", "owner", "run", "environment", "path"] {
            let mut value = frame();
            value["params"][field] = json!("forged");
            assert!(decode(&value).is_err());
        }
        let mut value = frame();
        value["params"]["arguments"]["environment"] = json!("shell");
        assert!(decode(&value).is_err());
    }
    #[test]
    fn native_id_and_utf8_source_bounds_match_core() {
        for id in [
            json!(0),
            json!(9007199254740992_u64),
            json!(-1),
            json!(1.5),
            Value::Null,
            json!(true),
            json!(""),
            json!("bad\n"),
            json!("x".repeat(129)),
        ] {
            let mut value = frame();
            value["id"] = id;
            assert!(decode(&value).is_err());
        }
        for source in [String::new(), "\0".into(), "é".repeat(16385)] {
            let mut value = frame();
            value["params"]["arguments"]["command"] = json!(source);
            assert!(decode(&value).is_err());
        }
        let mut value = frame();
        value["params"]["arguments"]["command"] = json!("é".repeat(16384));
        assert!(decode(&value).is_ok());
    }
}
