use super::*;
use orkestr_v2_contracts::{ExecutionFailureClass, ExecutionModelSource};
use serde_json::json;

const NATIVE: &str = "11111111-1111-4111-8111-111111111111";
const INPUT: &str = "22222222-2222-4222-8222-222222222222";

#[test]
fn model_observations_report_native_values_without_terminal_authority() {
    let mut parser = ClaudeRpc::new(NATIVE, "request:1").unwrap();
    assert_eq!(parser.receive("request:1", &json!({"type":"system","subtype":"init","session_id":NATIVE,"model":"selected-model"}).to_string()).unwrap(), Some(ClaudeObservation::Initialized));
    let model = parser.take_model_observation().unwrap();
    assert_eq!(
        (model.source, model.model.as_str()),
        (ExecutionModelSource::Resolved, "selected-model")
    );
    assert!(!parser.terminal_result_seen());
    assert_eq!(parser.receive("request:1", &json!({"type":"assistant","session_id":NATIVE,"message":{"role":"assistant","model":"answer-model","content":[{"type":"text","text":"synthetic answer"}]}}).to_string()).unwrap(), Some(ClaudeObservation::Progress));
    let model = parser.take_model_observation().unwrap();
    assert_eq!(
        (model.source, model.model.as_str()),
        (ExecutionModelSource::Answer, "answer-model")
    );
    assert!(!parser.terminal_result_seen());
}

#[test]
fn policy_refusal_is_explicit_but_never_a_terminal_result_or_fallback_proposal() {
    let mut parser = ClaudeRpc::new(NATIVE, "request:1").unwrap();
    parser
        .receive(
            "request:1",
            &json!({"type":"system","subtype":"init","session_id":NATIVE,"model":"selected-model"})
                .to_string(),
        )
        .unwrap();
    parser.take_model_observation();
    let frame = json!({"type":"system","subtype":"provider_policy_refusal","session_id":NATIVE,"user_message_uuid":INPUT,"model":"selected-model"});
    assert_eq!(
        parser.receive("request:1", &frame.to_string()).unwrap(),
        Some(ClaudeObservation::PolicyRefusal)
    );
    assert_eq!(parser.failure_class(), Some(ExecutionFailureClass::Policy));
    assert!(!parser.terminal_result_seen());
    let fallback = json!({"type":"result","subtype":"success","session_id":NATIVE,"is_error":false,"result":"replacement answer"});
    assert_eq!(
        parser.receive("request:1", &fallback.to_string()),
        Err(Blocker::Protocol)
    );
    assert!(parser.finish("request:1").is_err());
}

#[test]
fn policy_refusal_without_native_initialization_is_not_accepted() {
    let mut parser = ClaudeRpc::new(NATIVE, "request:1").unwrap();
    let frame = json!({"type":"system","subtype":"provider_policy_refusal","session_id":NATIVE,"user_message_uuid":INPUT});
    assert_eq!(
        parser.receive("request:1", &frame.to_string()),
        Err(Blocker::Protocol)
    );
    assert_eq!(parser.failure_class(), None);
    assert!(!parser.terminal_result_seen());
}
