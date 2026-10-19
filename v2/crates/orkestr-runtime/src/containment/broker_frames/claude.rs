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
    let correlated = if let Some(input) = frame.get("uuid") {
        let input = input.as_str().ok_or(Error::InvalidFrame)?;
        // The consumed wrapper's message ID is the only permitted native input
        // UUID. This never authorizes caller-selected correlation or dispatch.
        if input != message_id
            || input.len() != 36
            || !input.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                }
            })
        {
            return Err(Error::InvalidFrame);
        }
        true
    } else {
        false
    };
    if frame.len() != if correlated { 5 } else { 4 }
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
    #[test]
    fn resumed_input_uuid_is_exact_consumed_message_identity() {
        let input = "11111111-1111-4111-8111-111111111111";
        let value = json!({"params":{"owned_handle":"synthetic","message_id":input,
            "frame":{"type":"user","session_id":"22222222-2222-4222-8222-222222222222",
            "parent_tool_use_id":null,"uuid":input,"message":{"role":"user","content":"synthetic"}}}});
        assert!(validate(&value).is_ok());
        for changed in [
            json!(null),
            json!("message:1"),
            json!("33333333-3333-4333-8333-333333333333"),
        ] {
            let mut denied = value.clone();
            denied["params"]["frame"]["uuid"] = changed;
            assert_eq!(validate(&denied), Err(Error::InvalidFrame));
        }
        let mut denied = value;
        denied["params"]["frame"]["resume"] = json!(true);
        assert_eq!(validate(&denied), Err(Error::InvalidFrame));
    }
}
