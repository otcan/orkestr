//! Private lineage and closed frame checks; bytes never issue Core authority.
use super::process::{validate_metadata, Process};
use super::Error;
mod claude;
pub(super) mod offline;
pub(super) mod workspace;
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
    if params.len()
        != if method == "CommitExecution" && params.contains_key("message_id") {
            3
        } else {
            2
        }
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
    if inner.get("type").and_then(Value::as_str) == Some("control_request") {
        if inner != &crate::broker::claude_initialize::frame() {
            return Err(Error::InvalidFrame);
        }
        return serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame);
    }
    let mut validation = inner.clone();
    if validation.get("method").and_then(Value::as_str) == Some("thread/resume") {
        let params = validation
            .get_mut("params")
            .and_then(Value::as_object_mut)
            .ok_or(Error::InvalidFrame)?;
        if params.len() != 6
            || params.remove("excludeTurns") != Some(Value::Bool(true))
            || !params
                .remove("threadId")
                .and_then(|id| id.as_str().map(str::to_owned))
                .is_some_and(|id| {
                    !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
                })
        {
            return Err(Error::InvalidFrame);
        }
        params.insert("ephemeral".into(), Value::Bool(false));
        validation["method"] = Value::String("thread/start".into());
    }
    if validation.get("method").and_then(Value::as_str) == Some("thread/start") {
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
        // Optional explicit thread model for a fresh thread only: a resume
        // already failed its exact parameter count above.
        if let Some(model) = params.remove("model") {
            if !model
                .as_str()
                .is_some_and(orkestr_v2_contracts::launch_model_valid)
            {
                return Err(Error::InvalidFrame);
            }
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

/// Optional owner-selected `model`/`effort` turn overrides; returns how many.
fn turn_overrides(params: &serde_json::Map<String, Value>) -> Result<usize, Error> {
    let mut count = 0;
    if let Some(model) = params.get("model") {
        let model = model.as_str().ok_or(Error::InvalidFrame)?;
        if !orkestr_v2_contracts::launch_model_valid(model) {
            return Err(Error::InvalidFrame);
        }
        count += 1;
    }
    if let Some(effort) = params.get("effort") {
        let effort = effort.as_str().ok_or(Error::InvalidFrame)?;
        if !orkestr_v2_contracts::CODEX_EFFORTS.contains(&effort) {
            return Err(Error::InvalidFrame);
        }
        count += 1;
    }
    Ok(count)
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
        || params.len() != 3 + turn_overrides(params)?
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
        if value["params"].get("message_id").is_some() {
            claude::validate(&value)?;
            return serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame);
        }
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
    fn committed_turn_accepts_only_valid_owner_overrides() {
        let base = json!({"id":4,"method":"turn/start","params":{"threadId":"synthetic-native",
            "clientUserMessageId":"m1","input":[{"type":"text","text":"hi","text_elements":[]}]}});
        assert!(committed_inner(&base).is_ok());
        let mut with = base.clone();
        with["params"]["model"] = json!("gpt-5.1-codex");
        with["params"]["effort"] = json!("xhigh");
        assert!(committed_inner(&with).is_ok());
        for (key, value) in [
            ("model", json!("openai")),
            ("model", json!("a b")),
            ("model", json!(5)),
            ("effort", json!("extreme")),
            ("sandboxPolicy", json!({"type":"dangerFullAccess"})),
            ("cwd", json!("/")),
        ] {
            let mut denied = base.clone();
            denied["params"][key] = value;
            assert!(committed_inner(&denied).is_err(), "{key}");
        }
    }
    #[test]
    fn claude_initialize_is_closed_and_broker_only() {
        let frame = crate::broker::claude_initialize::frame();
        let workspace = Path::new("/synthetic/workspace");
        assert!(metadata(&envelope("BrokerMetadata", frame.clone()), workspace).is_ok());
        assert!(validate_metadata(&serde_json::to_vec(&frame).unwrap(), workspace).is_err());
        for (pointer, value) in [
            ("/request/hooks", json!({})),
            ("/request/subtype", json!("interrupt")),
            ("/request_id", json!("foreign")),
            ("/request/input", json!("forbidden")),
        ] {
            let mut denied = frame.clone();
            if pointer == "/request/input" {
                denied["request"]["input"] = value;
            } else {
                *denied.pointer_mut(pointer).unwrap() = value;
            }
            assert!(metadata(&envelope("BrokerMetadata", denied), workspace).is_err());
        }
    }
    #[test]
    fn fresh_thread_may_name_only_a_valid_explicit_model() {
        let workspace = Path::new("/synthetic/workspace");
        let start = json!({"id":3,"method":"thread/start","params":{"cwd":"/synthetic/workspace","approvalPolicy":"never","sandbox":"read-only","ephemeral":false,"modelProvider":"openai"}});
        assert!(metadata(&envelope("BrokerMetadata", start.clone()), workspace).is_ok());
        let mut named = start.clone();
        named["params"]["model"] = json!("synthetic-fast-model");
        let original = envelope("BrokerMetadata", named.clone());
        assert_eq!(metadata(&original, workspace).unwrap(), original);
        for value in [json!("openai"), json!("a b"), json!(5), json!(null)] {
            let mut denied = start.clone();
            denied["params"]["model"] = value;
            assert!(metadata(&envelope("BrokerMetadata", denied), workspace).is_err());
        }
        let mut resume = json!({"id":3,"method":"thread/resume","params":{"excludeTurns":true,"threadId":"synthetic-native","cwd":"/synthetic/workspace","approvalPolicy":"never","sandbox":"read-only","modelProvider":"openai"}});
        resume["params"]["model"] = json!("synthetic-fast-model");
        assert!(
            metadata(&envelope("BrokerMetadata", resume), workspace).is_err(),
            "a resumed thread keeps its own native model"
        );
    }
    #[test]
    fn resume_is_broker_only_and_closed() {
        let frame = json!({"id":3,"method":"thread/resume","params":{"excludeTurns":true,"threadId":"synthetic-native","cwd":"/synthetic/workspace","approvalPolicy":"never","sandbox":"read-only","modelProvider":"openai"}});
        assert!(metadata(
            &envelope("BrokerMetadata", frame.clone()),
            Path::new("/synthetic/workspace")
        )
        .is_ok());
        assert!(validate_metadata(
            &serde_json::to_vec(&frame).unwrap(),
            Path::new("/synthetic/workspace")
        )
        .is_err());
        let mut missing = frame.clone();
        missing["params"]
            .as_object_mut()
            .unwrap()
            .remove("excludeTurns");
        assert!(metadata(
            &envelope("BrokerMetadata", missing),
            Path::new("/synthetic/workspace")
        )
        .is_err());
        let original = envelope("BrokerMetadata", frame.clone());
        assert_eq!(
            metadata(&original, Path::new("/synthetic/workspace")).unwrap(),
            original
        );
        for (key, value) in [
            ("excludeTurns", json!(false)),
            ("excludeTurns", json!(null)),
            ("excludeTurns", json!("true")),
            ("threadId", json!("")),
            ("modelProvider", json!("external")),
            ("ephemeral", json!(false)),
            ("input", json!([])),
        ] {
            let mut denied = frame.clone();
            denied["params"][key] = value;
            assert!(metadata(
                &envelope("BrokerMetadata", denied),
                Path::new("/synthetic/workspace")
            )
            .is_err());
        }
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
