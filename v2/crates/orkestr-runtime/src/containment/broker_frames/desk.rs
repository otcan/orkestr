//! Exact trusted Deep setup profile; no caller-selected tool schema.
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
            if inner["params"]
                .as_object_mut()
                .ok_or(Error::InvalidFrame)?
                .remove("dynamicTools")
                != Some(serde_json::json!([
                    crate::broker::desk_tool::advertisement()
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
