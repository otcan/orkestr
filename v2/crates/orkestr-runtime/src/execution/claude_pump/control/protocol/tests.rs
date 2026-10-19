use super::*;
const NATIVE: &str = "11111111-1111-4111-8111-111111111111";
const INPUT: &str = "22222222-2222-4222-8222-222222222222";
const RESULT: &str = "33333333-3333-4333-8333-333333333333";
fn ack() -> Value {
    json!({"type":"control_response","response":{"subtype":"success","request_id":REQUEST,"response":{"turn":"stopped"}}})
}
fn terminal() -> Value {
    json!({"type":"result","session_id":NATIVE,"user_message_uuid":INPUT,"uuid":RESULT,
        "subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"})
}

#[test]
fn claude_stop_requires_separate_ack_and_exact_terminal_in_either_order() {
    for terminal_first in [false, true] {
        let mut state = StopEvidence::new(NATIVE, INPUT).unwrap();
        let (first, second) = if terminal_first {
            (terminal(), ack())
        } else {
            (ack(), terminal())
        };
        state.receive(&first).unwrap();
        assert!(!state.confirmed());
        state.receive(&second).unwrap();
        assert!(state.confirmed());
    }
}

#[test]
fn claude_stop_ack_only_idle_spared_foreign_and_replay_never_confirm() {
    for changed in [json!("idle"), json!("spared"), json!(null), json!(true)] {
        let mut state = StopEvidence::new(NATIVE, INPUT).unwrap();
        let mut frame = ack();
        frame["response"]["response"]["turn"] = changed;
        assert!(state.receive(&frame).is_err());
        assert!(!state.confirmed());
    }
    for mutation in 0..3 {
        let mut state = StopEvidence::new(NATIVE, INPUT).unwrap();
        let mut frame = ack();
        match mutation {
            0 => frame["response"]["request_id"] = json!("interrupt:other"),
            1 => frame["response"]["account"] = json!({}),
            _ => {
                state.receive(&frame).unwrap();
            }
        }
        assert!(state.receive(&frame).is_err());
        assert!(state.receive(&terminal()).is_err());
        assert!(!state.confirmed());
    }
}

#[test]
fn claude_stop_terminal_closed_fields_prevent_false_success() {
    let variants = [
        ("session_id", json!(INPUT)),
        ("user_message_uuid", json!(RESULT)),
        ("uuid", json!(INPUT)),
        ("uuid", json!("not-a-uuid")),
        ("subtype", json!("success")),
        ("is_error", json!(false)),
        ("is_error", json!(1)),
        ("terminal_reason", json!("aborted_tools")),
        ("terminal_reason", json!(null)),
        ("result", json!("not evidence")),
        ("errors", json!(["not evidence"])),
        ("user_message_uuids", json!([INPUT, RESULT])),
        ("parent_tool_use_id", json!(RESULT)),
        ("sessionId", json!(NATIVE)),
    ];
    for (key, value) in variants {
        let mut state = StopEvidence::new(NATIVE, INPUT).unwrap();
        state.receive(&ack()).unwrap();
        let mut frame = terminal();
        frame[key] = value;
        assert!(state.receive(&frame).is_err(), "field {key}");
        assert!(!state.confirmed());
        assert!(state.receive(&terminal()).is_err());
    }
    for key in [
        "uuid",
        "session_id",
        "user_message_uuid",
        "subtype",
        "is_error",
        "terminal_reason",
    ] {
        let mut state = StopEvidence::new(NATIVE, INPUT).unwrap();
        let mut frame = terminal();
        frame.as_object_mut().unwrap().remove(key);
        assert!(state.receive(&frame).is_err());
        assert!(!state.confirmed());
    }
}

#[test]
fn claude_stop_second_terminal_cannot_replace_original_evidence() {
    for changed in [false, true] {
        let mut state = StopEvidence::new(NATIVE, INPUT).unwrap();
        state.receive(&terminal()).unwrap();
        let mut second = terminal();
        if changed {
            second["uuid"] = json!("44444444-4444-4444-8444-444444444444");
        }
        assert!(state.receive(&second).is_err());
        assert!(state.receive(&ack()).is_err());
        assert!(!state.confirmed());
    }
    let mut state = StopEvidence::new(NATIVE, INPUT).unwrap();
    let mut frame = terminal();
    frame["user_message_uuids"] = json!([INPUT]);
    state.receive(&frame).unwrap();
    state.receive(&ack()).unwrap();
    assert!(state.confirmed());
}
