//! Input correlation on a fresh reader for an accepted Claude native session.
//! Identity is derived from the consumed message, never supplied by a browser.
use crate::ports::Blocker;
use orkestr_v2_store_sqlite::ConsumedProviderDispatch;
use serde_json::{json, Value};

pub(super) struct ClaudeInputCorrelation(Option<String>);
impl ClaudeInputCorrelation {
    pub(super) fn for_dispatch(cap: &ConsumedProviderDispatch, resumed: bool) -> Self {
        Self(resumed.then(|| cap.message_id().to_string()))
    }

    pub(super) fn frame(&self, cap: &ConsumedProviderDispatch) -> Value {
        let mut frame = json!({"type":"user",
            "session_id":cap.provider().binding.native_session_id,
            "parent_tool_use_id":null,
            "message":{"role":"user","content":cap.text()}});
        if let Some(input) = &self.0 {
            frame["uuid"] = json!(input);
        }
        frame
    }

    pub(super) fn verify(&self, frame: &Value) -> Result<(), Blocker> {
        let Some(input) = &self.0 else {
            return Ok(());
        };
        if matches!(
            frame.get("type").and_then(Value::as_str),
            Some("assistant" | "result")
        ) && (frame.get("user_message_uuid").and_then(Value::as_str) != Some(input)
            || frame
                .get("user_message_uuids")
                .is_some_and(|ids| ids != &json!([input])))
        {
            return Err(Blocker::StaleLease);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const INPUT: &str = "11111111-1111-4111-8111-111111111111";
    const PRIOR: &str = "22222222-2222-4222-8222-222222222222";

    #[test]
    fn fresh_reader_refuses_missing_prior_or_mixed_input_identity() {
        let correlation = ClaudeInputCorrelation(Some(INPUT.into()));
        for kind in ["assistant", "result"] {
            assert_eq!(
                correlation.verify(&json!({"type":kind})),
                Err(Blocker::StaleLease)
            );
            assert_eq!(
                correlation.verify(&json!({"type":kind,"user_message_uuid":PRIOR})),
                Err(Blocker::StaleLease)
            );
            assert_eq!(correlation.verify(&json!({"type":kind,"user_message_uuid":INPUT,"user_message_uuids":[INPUT,PRIOR]})), Err(Blocker::StaleLease));
            assert_eq!(
                correlation.verify(
                    &json!({"type":kind,"user_message_uuid":INPUT,"user_message_uuids":null})
                ),
                Err(Blocker::StaleLease)
            );
            assert!(correlation
                .verify(&json!({"type":kind,"user_message_uuid":INPUT}))
                .is_ok());
            assert!(correlation
                .verify(
                    &json!({"type":kind,"user_message_uuid":INPUT,"user_message_uuids":[INPUT]})
                )
                .is_ok());
        }
    }

    #[test]
    fn metadata_still_requires_the_separate_native_init_and_bounded_parser() {
        let correlation = ClaudeInputCorrelation(Some(INPUT.into()));
        assert!(correlation
            .verify(&json!({"type":"system","subtype":"init"}))
            .is_ok());
        assert!(ClaudeInputCorrelation(None)
            .verify(&json!({"type":"assistant"}))
            .is_ok());
    }
}
