//! Fixed server-selected Worker profile; no caller tool schemas.
use super::*;
pub(crate) fn advertisement() -> Value {
    json!({"type":"function","name":"orkestr_workspace_exec","description":"Run a bounded shell command in the approved project workspace, without network or account access.","inputSchema":{"type":"object","properties":{"command":{"type":"string","maxLength":32768}},"required":["command"],"additionalProperties":false}})
}
pub(crate) fn enable(frame: &mut Value) {
    match frame["method"].as_str() {
        Some("initialize") => frame["params"]["capabilities"]["experimentalApi"] = json!(true),
        Some("thread/start") => frame["params"]["dynamicTools"] = json!([advertisement()]),
        _ => {}
    }
}
