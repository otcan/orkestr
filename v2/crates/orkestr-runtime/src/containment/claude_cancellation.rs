//! Claude-only control preparation. JSON never creates cancellation authority.
use super::{Error, ExecutionScope, OwnedChild};
use crate::execution::cancellation_fence::CancellationFence;
use serde_json::{json, Value};
use std::sync::Arc;

fn validate(bytes: &[u8], input: &str) -> Result<Vec<u8>, Error> {
    if bytes.len() > 65536
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
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::InvalidFrame)?;
    let handle = value
        .pointer("/params/owned_handle")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 256
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
        .ok_or(Error::InvalidFrame)?;
    let expected = json!({"id":4,"method":"CancelExecution","params":{"owned_handle":handle,
        "frame":{"type":"control_request","request_id":"interrupt:4","request":{
        "subtype":"interrupt","cancel_queued":false,"for_user_message_uuids":[input]}}}});
    if value != expected {
        return Err(Error::InvalidFrame);
    }
    serde_json::to_vec(&value).map_err(|_| Error::InvalidFrame)
}

impl OwnedChild {
    pub(crate) fn enqueue_claude_cancellation(
        &self,
        scope: &ExecutionScope,
        fence: &CancellationFence,
        lineage: &Arc<()>,
        input: &str,
        bytes: &[u8],
    ) -> Result<(), Error> {
        if !self
            .process
            .broker_launcher
            .load(std::sync::atomic::Ordering::Acquire)
            || !Arc::ptr_eq(lineage, &self.process.broker_lineage)
        {
            return Err(Error::WrongScope);
        }
        let canonical = validate(bytes, input)?;
        if canonical.len() > self.process.max_frame {
            return Err(Error::FrameTooLarge);
        }
        fence.dispatch(scope, || {
            let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
            self.shared.check(scope, &state)?;
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .framing
                .enqueue(&canonical)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const INPUT: &str = "11111111-1111-4111-8111-111111111111";
    fn frame() -> Value {
        json!({"id":4,"method":"CancelExecution","params":{"owned_handle":"synthetic",
        "frame":{"type":"control_request","request_id":"interrupt:4","request":{
        "subtype":"interrupt","cancel_queued":false,"for_user_message_uuids":[INPUT]}}}})
    }
    #[test]
    fn claude_interrupt_is_closed_and_exact_input_bound() {
        assert!(validate(&serde_json::to_vec(&frame()).unwrap(), INPUT).is_ok());
        for (pointer, replacement) in [
            ("/id", json!(5)),
            ("/params/frame/request_id", json!("interrupt:5")),
            ("/params/frame/request/cancel_queued", json!(true)),
            ("/params/frame/request/for_user_message_uuids", json!([])),
            (
                "/params/frame/request/for_user_message_uuids",
                json!([INPUT, INPUT]),
            ),
            ("/params/frame/request/subtype", json!("initialize")),
        ] {
            let mut denied = frame();
            *denied.pointer_mut(pointer).unwrap() = replacement;
            assert_eq!(
                validate(&serde_json::to_vec(&denied).unwrap(), INPUT),
                Err(Error::InvalidFrame)
            );
        }
        let mut extra = frame();
        extra["params"]["frame"]["request"]["authority"] = json!(true);
        assert!(validate(&serde_json::to_vec(&extra).unwrap(), INPUT).is_err());
        assert!(validate(
            &serde_json::to_vec(&frame()).unwrap(),
            "22222222-2222-4222-8222-222222222222"
        )
        .is_err());
    }
}
