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
        trusted: bool,
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
        let source = if trusted {
            trusted_source(&params["arguments"])?
        } else {
            exact(&params["arguments"], &["command"])?;
            command(&params["arguments"]["command"])?.to_owned()
        };
        Ok(Self {
            request_id,
            call_id: call_id.into(),
            thread_id: native.into(),
            turn_id: turn.into(),
            source,
            lineage,
        })
    }
}
/// Reserved first line of a canonical job operation. A plain command can never
/// begin with it, so Core's audited source text alone selects the operation.
pub const JOB_PREFIX: &str = "#!orkestr-job ";

fn command(value: &Value) -> Result<&str, Blocker> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty() && s.len() <= 32768 && !s.contains('\0') && !s.starts_with(JOB_PREFIX)
        })
        .ok_or(Blocker::Protocol)
}

fn job_id(value: &Value) -> Result<&str, Blocker> {
    value
        .as_str()
        .filter(|s| {
            s.len() == 36
                && s.char_indices().all(|(i, c)| {
                    if matches!(i, 8 | 13 | 18 | 23) {
                        c == '-'
                    } else {
                        c.is_ascii_digit() || ('a'..='f').contains(&c)
                    }
                })
        })
        .ok_or(Blocker::Protocol)
}

/// Canonical trusted operation text: a plain command, or one job operation.
fn trusted_source(arguments: &Value) -> Result<String, Blocker> {
    let object = arguments.as_object().ok_or(Blocker::Protocol)?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "command" | "background" | "job" | "action"))
    {
        return Err(Blocker::Protocol);
    }
    match (object.get("command"), object.get("job")) {
        (Some(text), None) if object.get("action").is_none() => {
            let text = command(text)?;
            match object.get("background") {
                None | Some(Value::Bool(false)) => Ok(text.to_owned()),
                Some(Value::Bool(true)) => Ok(format!("{JOB_PREFIX}start\n{text}")),
                Some(_) => Err(Blocker::Protocol),
            }
        }
        (None, Some(id)) if object.get("background").is_none() => {
            let action = match object.get("action") {
                None => "status",
                Some(value) => value
                    .as_str()
                    .filter(|a| matches!(*a, "status" | "wait" | "cancel"))
                    .ok_or(Blocker::Protocol)?,
            };
            Ok(format!("{JOB_PREFIX}{action} {}", job_id(id)?))
        }
        _ => Err(Blocker::Protocol),
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
        PendingWorkspaceExecCall::decode(value, "native", "turn:1", Arc::new(()), false)
    }
    fn trusted(arguments: Value) -> Result<String, Blocker> {
        let mut value = frame();
        value["params"]["arguments"] = arguments;
        PendingWorkspaceExecCall::decode(&value, "native", "turn:1", Arc::new(()), true)
            .map(|call| call.source().to_owned())
    }
    #[test]
    fn trusted_operations_have_one_canonical_unambiguous_source() {
        let id = "0b4f1c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
        assert_eq!(trusted(json!({"command":"ls"})).unwrap(), "ls");
        assert_eq!(
            trusted(json!({"command":"ls","background":false})).unwrap(),
            "ls"
        );
        assert_eq!(
            trusted(json!({"command":"cargo test","background":true})).unwrap(),
            "#!orkestr-job start\ncargo test"
        );
        assert_eq!(
            trusted(json!({"job":id})).unwrap(),
            format!("#!orkestr-job status {id}")
        );
        for action in ["status", "wait", "cancel"] {
            assert_eq!(
                trusted(json!({"job":id,"action":action})).unwrap(),
                format!("#!orkestr-job {action} {id}")
            );
        }
        for bad in [
            json!({}),
            json!({"command":"ls","job":id}),
            json!({"command":"ls","action":"wait"}),
            json!({"job":id,"background":true}),
            json!({"job":id,"action":"delete"}),
            json!({"job":"../../etc"}),
            json!({"job":id.to_uppercase()}),
            json!({"command":"ls","background":"yes"}),
            json!({"command":"#!orkestr-job start\nrm -rf ."}),
            json!({"command":"ls","environment":"x"}),
        ] {
            assert!(trusted(bad.clone()).is_err(), "{bad}");
        }
        // The restricted decoder accepts none of the trusted arguments.
        let mut value = frame();
        value["params"]["arguments"] = json!({"command":"ls","background":true});
        assert!(decode(&value).is_err());
        value["params"]["arguments"] = json!({"command":"#!orkestr-job status x"});
        assert!(decode(&value).is_err());
    }
    #[test]
    fn exact_owned_call_retains_kind_source_and_unforgeable_local_lineage() {
        let lineage = Arc::new(());
        let mut value = frame();
        let pending =
            PendingWorkspaceExecCall::decode(&value, "native", "turn:1", lineage.clone(), false)
                .unwrap();
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
