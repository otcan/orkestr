//! Only the trusted Worker setup marker can admit this exact fixed profile.
use super::*;
pub(crate) fn metadata(frame: &[u8], workspace: &Path) -> Result<Vec<u8>, Error> {
    let original: Value = serde_json::from_slice(frame).map_err(|_| Error::InvalidFrame)?;
    outer(&original, "BrokerMetadata")?;
    let mut validation = original.clone();
    let inner = &mut validation["params"]["frame"];
    match inner["method"].as_str() {
        Some("initialize") => {
            if inner.pointer("/params/capabilities/experimentalApi") != Some(&Value::Bool(true)) {
                return Err(Error::InvalidFrame);
            }
            inner["params"]["capabilities"]["experimentalApi"] = Value::Bool(false);
        }
        Some("thread/start") => {
            let params = inner["params"].as_object_mut().ok_or(Error::InvalidFrame)?;
            if params.remove("dynamicTools")
                != Some(serde_json::json!([
                    crate::broker::workspace_setup::advertisement()
                ]))
            {
                return Err(Error::InvalidFrame);
            }
        }
        Some("initialized" | "account/read") => {}
        _ => return Err(Error::InvalidFrame),
    }
    super::metadata(
        &serde_json::to_vec(&validation).map_err(|_| Error::InvalidFrame)?,
        workspace,
    )?;
    serde_json::to_vec(&original).map_err(|_| Error::InvalidFrame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn envelope(frame: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"id":2,"method":"BrokerMetadata","params":{"owned_handle":"synthetic","frame":frame}})).unwrap()
    }
    #[test]
    fn fixed_worker_setup_accepts_only_exact_advertisement_and_experimental_flag() {
        let mut frame = crate::codex_rpc::CodexRpc::default().initialize().unwrap();
        let workspace = std::env::temp_dir();
        assert!(metadata(&envelope(frame.clone()), &workspace).is_err());
        crate::broker::workspace_setup::enable(&mut frame);
        assert!(metadata(&envelope(frame.clone()), &workspace).is_ok());
        frame["params"]["capabilities"]["other"] = json!(true);
        assert!(metadata(&envelope(frame), &workspace).is_err());
        let mut thread = json!({"id":3,"method":"thread/start","params":{"cwd":workspace,"approvalPolicy":"never","sandbox":"read-only","ephemeral":false,"modelProvider":"openai"}});
        crate::broker::workspace_setup::enable(&mut thread);
        assert!(metadata(&envelope(thread.clone()), &workspace).is_ok());
        thread["params"]["dynamicTools"][0]["name"] = json!("other");
        assert!(metadata(&envelope(thread), &workspace).is_err());
        assert!(metadata(
            &envelope(crate::broker::claude_initialize::frame()),
            &workspace
        )
        .is_err());
    }
}
