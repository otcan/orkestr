//! Private lineage and closed frame checks; bytes never issue Core authority.
use super::process::{validate_metadata, Process};
use super::Error;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

fn outer<'a>(value: &'a Value, method: &str) -> Result<&'a Value, Error> {
    let object = value.as_object().ok_or(Error::InvalidFrame)?;
    if object.len() != 3
        || value.get("method").and_then(Value::as_str) != Some(method)
        || !value
            .get("id")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0 && id < (1 << 53))
    {
        return Err(Error::InvalidFrame);
    }
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .ok_or(Error::InvalidFrame)?;
    if params.len() != 2
        || !params
            .get("owned_handle")
            .and_then(Value::as_str)
            .is_some_and(|handle| {
                !handle.is_empty()
                    && handle.len() <= 256
                    && handle
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
    {
        return Err(Error::InvalidFrame);
    }
    params.get("frame").ok_or(Error::InvalidFrame)
}

pub(super) fn metadata(frame: &[u8], workspace: &Path) -> Result<Vec<u8>, Error> {
    let value: Value = serde_json::from_slice(frame).map_err(|_| Error::InvalidFrame)?;
    let inner = outer(&value, "BrokerMetadata")?;
    let mut validation = inner.clone();
    if inner.get("method").and_then(Value::as_str) == Some("thread/start") {
        let params = validation
            .get_mut("params")
            .and_then(Value::as_object_mut)
            .ok_or(Error::InvalidFrame)?;
        if params
            .remove("modelProvider")
            .as_ref()
            .and_then(Value::as_str)
            != Some("openai")
        {
            return Err(Error::InvalidFrame);
        }
    }
    // Only the broker envelope adds the fixed provider field. The raw setup
    // whitelist remains unchanged; forward the original pinned envelope.
    validate_metadata(
        &serde_json::to_vec(&validation).map_err(|_| Error::InvalidFrame)?,
        workspace,
    )?;
    serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame)
}

fn committed_inner(value: &Value) -> Result<(), Error> {
    let object = value.as_object().ok_or(Error::InvalidFrame)?;
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .ok_or(Error::InvalidFrame)?;
    if object.len() != 3
        || value.get("method").and_then(Value::as_str) != Some("turn/start")
        || !value
            .get("id")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0)
        || params.len() != 3
        || !["threadId", "clientUserMessageId"].iter().all(|key| {
            params
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty() && text.len() <= 512)
        })
    {
        return Err(Error::InvalidFrame);
    }
    let input = params
        .get("input")
        .and_then(Value::as_array)
        .ok_or(Error::InvalidFrame)?;
    if input.len() != 1 {
        return Err(Error::InvalidFrame);
    }
    let item = input[0].as_object().ok_or(Error::InvalidFrame)?;
    if item.len() != 3
        || item.get("type").and_then(Value::as_str) != Some("text")
        || !item.get("text").is_some_and(Value::is_string)
        || item
            .get("text_elements")
            .and_then(Value::as_array)
            .is_none_or(|items| !items.is_empty())
    {
        return Err(Error::InvalidFrame);
    }
    Ok(())
}

pub(super) fn turn(
    frame: &[u8],
    lineage: Option<&Arc<()>>,
    process: &Arc<Process>,
) -> Result<Vec<u8>, Error> {
    let value: Value = serde_json::from_slice(frame).map_err(|_| Error::InvalidFrame)?;
    let inner = if process
        .broker_launcher
        .load(std::sync::atomic::Ordering::Acquire)
    {
        if !lineage.is_some_and(|token| Arc::ptr_eq(token, &process.broker_lineage)) {
            return Err(Error::WrongScope);
        }
        let inner = outer(&value, "CommitExecution")?;
        committed_inner(inner)?;
        inner
    } else {
        if lineage.is_some() {
            return Err(Error::WrongScope);
        }
        &value
    };
    if inner.get("method").and_then(Value::as_str) != Some("turn/start") {
        return Err(Error::InvalidFrame);
    }
    serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame)
}

pub(super) fn cancellation(
    bytes: &[u8],
    lineage: &Arc<()>,
    process: &Arc<Process>,
) -> Result<Vec<u8>, Error> {
    if !process
        .broker_launcher
        .load(std::sync::atomic::Ordering::Acquire)
        || !Arc::ptr_eq(lineage, &process.broker_lineage)
    {
        return Err(Error::WrongScope);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::InvalidFrame)?;
    let frame = outer(&value, "CancelExecution")?;
    let object = frame.as_object().ok_or(Error::InvalidFrame)?;
    let params = frame
        .get("params")
        .and_then(Value::as_object)
        .ok_or(Error::InvalidFrame)?;
    if object.len() != 3
        || frame.get("method").and_then(Value::as_str) != Some("turn/interrupt")
        || !frame
            .get("id")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0 && id < (1 << 53))
        || params.len() != 2
        || !["threadId", "turnId"].iter().all(|key| {
            params
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty() && text.len() <= 512)
        })
    {
        return Err(Error::InvalidFrame);
    }
    serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn envelope(method: &str, frame: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"id":2,"method":method,"params":{
            "owned_handle":"synthetic_owned","frame":frame}}))
        .unwrap()
    }
    #[test]
    fn setup_wrapper_reuses_closed_whitelist() {
        let allowed = envelope(
            "BrokerMetadata",
            json!({"id":1,"method":"account/read","params":{"refreshToken":false}}),
        );
        assert!(metadata(&allowed, Path::new("/synthetic/workspace")).is_ok());
        for method in ["turn/start", "exec", "OpenOwnedSession", "CommitExecution"] {
            let denied = envelope(
                "BrokerMetadata",
                json!({"id":1,"method":method,"params":{}}),
            );
            assert_eq!(
                metadata(&denied, Path::new("/synthetic/workspace")),
                Err(Error::InvalidFrame)
            );
        }
        assert_eq!(
            metadata(
                &envelope("CommitExecution", json!({"method":"initialized"})),
                Path::new("/synthetic/workspace")
            ),
            Err(Error::InvalidFrame)
        );
    }
    #[test]
    fn broker_thread_setup_requires_exact_openai_pin() {
        let mut frame = serde_json::json!({"id":3,"method":"thread/start","params":{"cwd":"/synthetic/workspace","approvalPolicy":"never","sandbox":"read-only","ephemeral":false,"modelProvider":"openai"}});
        assert!(metadata(
            &envelope("BrokerMetadata", frame.clone()),
            Path::new("/synthetic/workspace")
        )
        .is_ok());
        for provider in [
            Value::Null,
            Value::Bool(true),
            serde_json::json!("external"),
            serde_json::json!(""),
        ] {
            frame["params"]["modelProvider"] = provider;
            assert_eq!(
                metadata(
                    &envelope("BrokerMetadata", frame.clone()),
                    Path::new("/synthetic/workspace")
                ),
                Err(Error::InvalidFrame)
            );
        }
        frame["params"]
            .as_object_mut()
            .unwrap()
            .remove("modelProvider");
        assert_eq!(
            metadata(
                &envelope("BrokerMetadata", frame),
                Path::new("/synthetic/workspace")
            ),
            Err(Error::InvalidFrame)
        );
    }
    #[test]
    fn setup_wrapper_denies_foreign_paths_handles_and_extra_fields() {
        let allowed = envelope(
            "BrokerMetadata",
            json!({"id":1,"method":"account/read","params":{"refreshToken":false}}),
        );
        for handle in ["", "/synthetic/socket", "secret://fake"] {
            let mut value: Value = serde_json::from_slice(&allowed).unwrap();
            value["params"]["owned_handle"] = json!(handle);
            assert_eq!(
                metadata(
                    &serde_json::to_vec(&value).unwrap(),
                    Path::new("/synthetic/workspace")
                ),
                Err(Error::InvalidFrame)
            );
        }
        let mut value: Value = serde_json::from_slice(&allowed).unwrap();
        value["environment"] = json!({"TOKEN":"synthetic"});
        assert_eq!(
            metadata(
                &serde_json::to_vec(&value).unwrap(),
                Path::new("/synthetic/workspace")
            ),
            Err(Error::InvalidFrame)
        );
    }
}
