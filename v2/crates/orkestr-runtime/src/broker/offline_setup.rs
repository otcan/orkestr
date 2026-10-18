//! Fixed server-selected Worker profile; no caller tool schemas.
use super::*;
pub(crate) fn advertisement() -> Value {
    json!({"type":"function","name":"orkestr_offline_python","description":"Run bounded offline Python without host files or network.","inputSchema":{"type":"object","properties":{"source":{"type":"string","maxLength":32768}},"required":["source"],"additionalProperties":false}})
}
pub(crate) fn enable(frame: &mut Value) {
    match frame["method"].as_str() {
        Some("initialize") => frame["params"]["capabilities"]["experimentalApi"] = json!(true),
        Some("thread/start") => frame["params"]["dynamicTools"] = json!([advertisement()]),
        _ => {}
    }
}
