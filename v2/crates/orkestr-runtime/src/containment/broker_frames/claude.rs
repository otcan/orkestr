//! Closed Claude inference shape. This validates bytes, never issues authority.
use super::Error;
use serde_json::Value;

pub(super) fn validate(value: &Value) -> Result<(), Error> {
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .ok_or(Error::InvalidFrame)?;
    let message_id = params
        .get("message_id")
        .and_then(Value::as_str)
        .ok_or(Error::InvalidFrame)?;
    if params.len() != 3
        || message_id.is_empty()
        || message_id.len() > 256
        || !message_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:-.".contains(&b))
    {
        return Err(Error::InvalidFrame);
    }
    let frame = params
        .get("frame")
        .and_then(Value::as_object)
        .ok_or(Error::InvalidFrame)?;
    let session = frame
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or(Error::InvalidFrame)?;
    let message = frame
        .get("message")
        .and_then(Value::as_object)
        .ok_or(Error::InvalidFrame)?;
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .ok_or(Error::InvalidFrame)?;
    if frame.len() != 4
        || frame.get("type").and_then(Value::as_str) != Some("user")
        || frame.get("parent_tool_use_id") != Some(&Value::Null)
        || session.len() != 36
        || !session.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        || message.len() != 2
        || message.get("role").and_then(Value::as_str) != Some("user")
        || content.is_empty()
        || content.len() > 32768
    {
        return Err(Error::InvalidFrame);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn closed_user_only() {
        let value = json!({"params":{"owned_handle":"synthetic", "message_id":"message:1",
            "frame":{"type":"user","session_id":"11111111-1111-4111-8111-111111111111",
            "parent_tool_use_id":null,"message":{"role":"user","content":"synthetic"}}}});
        assert!(validate(&value).is_ok());
        for key in ["type", "session_id", "parent_tool_use_id", "message"] {
            let mut bad = value.clone();
            bad["params"]["frame"][key] = json!("foreign");
            assert_eq!(validate(&bad), Err(Error::InvalidFrame));
        }
        let mut bad = value;
        bad["params"]["environment"] = json!({});
        assert_eq!(validate(&bad), Err(Error::InvalidFrame));
    }
}
