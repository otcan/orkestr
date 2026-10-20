//! Fixed server-selected Worker profile; no caller tool schemas.
use super::*;
pub(crate) fn advertisement(trusted: bool) -> Value {
    if trusted {
        return json!({"type":"function","name":"orkestr_workspace_exec","description":TRUSTED_DESCRIPTION,"inputSchema":{"type":"object","properties":{"command":{"type":"string","maxLength":32768},"background":{"type":"boolean"},"job":{"type":"string","maxLength":64},"action":{"type":"string","enum":["status","wait","cancel"]}},"additionalProperties":false}});
    }
    json!({"type":"function","name":"orkestr_workspace_exec","description":"Run a bounded shell command in the approved project workspace, without network or account access.","inputSchema":{"type":"object","properties":{"command":{"type":"string","maxLength":32768}},"required":["command"],"additionalProperties":false}})
}
/// Byte-identical to the provider broker's trusted advertisement.
pub(crate) const TRUSTED_DESCRIPTION: &str = "Run a shell command in the approved project workspace under the operator's trusted profile (host toolchains; network and credentials only as configured). Pass {command} for a short command; its output returns directly. For long builds or tests pass {command, background:true}; the result names a job. Then pass {job, action:\"wait\"} (waits briefly), {job, action:\"status\"} or {job, action:\"cancel\"}. Redirect large output to a workspace file and read it with later commands.";
pub(crate) fn enable(frame: &mut Value, trusted: bool) {
    match frame["method"].as_str() {
        Some("initialize") => frame["params"]["capabilities"]["experimentalApi"] = json!(true),
        Some("thread/start") => frame["params"]["dynamicTools"] = json!([advertisement(trusted)]),
        _ => {}
    }
}
