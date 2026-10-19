use super::*;
use serde_json::json;
const NATIVE: &str = "11111111-1111-4111-8111-111111111111";
const INPUT: &str = "22222222-2222-4222-8222-222222222222";

fn live() -> ClaudeChannel {
    ClaudeChannel {
        native: NATIVE.into(),
        handle: "owned".into(),
        lineage: Arc::new(()),
        initialized: true,
        system_seen: true,
        reserved: true,
        prepared: true,
        writing: true,
        written: true,
        poisoned: false,
    }
}
fn prepared() -> Vec<u8> {
    json!({"method":"BrokerPrepared","params":{"owned_handle":"owned","request_id":4}})
        .to_string()
        .into_bytes()
}
fn output(id: u64, frame: Value) -> Vec<u8> {
    json!({"method":"BrokerOutput","params":{"owned_handle":"owned","request_id":id,"frame":frame}})
        .to_string()
        .into_bytes()
}
fn ack() -> Value {
    json!({"type":"control_response","response":{"subtype":"success","request_id":REQUEST,"response":{"turn":"stopped"}}})
}

#[test]
fn claude_control_requires_initialized_same_live_input_and_one_preparation() {
    for missing in 0..4 {
        let mut channel = live();
        match missing {
            0 => channel.system_seen = false,
            1 => channel.written = false,
            2 => channel.initialized = false,
            _ => channel.poisoned = true,
        }
        assert!(channel.into_control(INPUT).is_err());
    }
    assert!(live().into_control("input:foreign").is_err());
    let mut channel = live().into_control(INPUT).unwrap();
    let (_, bytes) = channel.request().unwrap();
    let request: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(request["params"]["frame"], interrupt(INPUT));
    assert!(channel.request().is_err());
    assert!(channel.begin_write().is_err());
    assert!(matches!(
        channel.receive(&prepared()).unwrap(),
        ControlFrame::Prepared
    ));
    let native = channel.begin_write().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&native).unwrap(),
        interrupt(INPUT)
    );
    assert!(channel.begin_write().is_err());
    channel.finish_write().unwrap();
    assert!(matches!(
        channel.receive(&output(4, ack())).unwrap(),
        ControlFrame::Native(_)
    ));
    assert!(channel.finish_write().is_err());
}

#[test]
fn claude_control_drains_original_output_while_preparing_but_refuses_early_ack() {
    let mut channel = live().into_control(INPUT).unwrap();
    channel.request().unwrap();
    let prior = output(3, json!({"type":"assistant","session_id":NATIVE}));
    assert!(matches!(
        channel.receive(&prior).unwrap(),
        ControlFrame::Native(_)
    ));
    channel.receive(&prepared()).unwrap();
    channel.begin_write().unwrap();
    assert!(matches!(
        channel.receive(&prior).unwrap(),
        ControlFrame::Native(_)
    ));
    assert!(channel.receive(&output(4, ack())).is_err());
    assert!(channel.finish_write().is_err());
}

#[test]
fn claude_control_foreign_duplicate_and_alias_fields_poison_the_channel() {
    for mutation in 0..6 {
        let mut channel = live().into_control(INPUT).unwrap();
        channel.request().unwrap();
        let mut frame: Value = serde_json::from_slice(&prepared()).unwrap();
        match mutation {
            0 => frame["params"]["owned_handle"] = json!("foreign"),
            1 => frame["params"]["request_id"] = json!(3),
            2 => frame["params"]["authority"] = json!(true),
            3 => frame["extra"] = json!(null),
            4 => {
                channel.receive(&prepared()).unwrap();
            }
            _ => frame["method"] = json!("BrokerOutput"),
        }
        assert!(channel.receive(frame.to_string().as_bytes()).is_err());
        assert!(channel.receive(&prepared()).is_err());
    }
    let mut channel = live().into_control(INPUT).unwrap();
    channel.request().unwrap();
    assert!(channel.receive(br#"{"method":"BrokerPrepared","params":{"owned_handle":"foreign","owned_handle":"owned","request_id":4}}"#).is_err());
}

#[test]
fn claude_control_never_relabels_foreign_or_unrelated_output() {
    for (id, frame) in [
        (4, json!({"type":"assistant","session_id":NATIVE})),
        (3, json!({"type":"assistant","session_id":INPUT})),
        (3, ack()),
    ] {
        let mut channel = live().into_control(INPUT).unwrap();
        channel.request().unwrap();
        channel.receive(&prepared()).unwrap();
        channel.begin_write().unwrap();
        channel.finish_write().unwrap();
        assert!(channel.receive(&output(id, frame)).is_err());
    }
}
