//! Independent metadata-only refusal probes. No process, credential or inference.
use orkestr_runtime::{codex_rpc::CodexRpc, ports::Blocker};
use serde_json::{json, Value};

fn pending_thread() -> CodexRpc {
    let mut rpc = CodexRpc::default();
    rpc.initialize().unwrap();
    rpc.receive(
        &json!({"id":1,"result":{
            "userAgent":"synthetic-codex/0.163.0","platformFamily":"unix",
            "platformOs":"linux","codexHome":"/synthetic/provider"
        }})
        .to_string(),
    )
    .unwrap();
    rpc.account_read().unwrap();
    rpc.receive(
        &json!({"id":2,"result":{
            "requiresOpenaiAuth":true,"account":{
                "type":"chatgpt","email":null,"planType":"plus"
            }
        }})
        .to_string(),
    )
    .unwrap();
    let request = rpc
        .create_session(std::path::Path::new("/synthetic/authorized"))
        .unwrap();
    assert_eq!(request["params"]["ephemeral"], false);
    rpc
}

fn reply(ephemeral: bool, cwd: &str) -> Value {
    json!({"id":3,"result":{
        "thread":{"id":"synthetic-native-thread","ephemeral":ephemeral,"cwd":cwd},
        "cwd":cwd,"approvalPolicy":"never",
        "sandbox":{"type":"readOnly","networkAccess":false}
    }})
}

#[test]
fn ephemeral_thread_cannot_confirm_persistent_native_readiness() {
    let mut rpc = pending_thread();
    let result = rpc.receive(&reply(true, "/synthetic/authorized").to_string());
    assert_eq!(
        result,
        Err(Blocker::Protocol),
        "ephemeral native thread was accepted"
    );
    assert!(rpc.native_session().is_none());
}

#[test]
fn other_workspace_cannot_confirm_requested_native_readiness() {
    let mut rpc = pending_thread();
    let result = rpc.receive(&reply(false, "/synthetic/unrelated").to_string());
    assert_eq!(
        result,
        Err(Blocker::Protocol),
        "different native workspace was accepted"
    );
    assert!(rpc.native_session().is_none());
}

#[test]
fn persistent_same_workspace_control_publishes_only_after_reply() {
    let mut rpc = pending_thread();
    assert!(rpc.native_session().is_none());
    assert_eq!(
        rpc.receive(&reply(false, "/synthetic/authorized").to_string()),
        Ok(None)
    );
    assert_eq!(rpc.native_session(), Some("synthetic-native-thread"));
}

#[test]
fn each_workspace_and_persistence_field_is_independently_required() {
    for pointer in [
        "/result/cwd",
        "/result/thread/cwd",
        "/result/thread/ephemeral",
    ] {
        for replacement in [
            Value::Null,
            json!(42),
            json!(true),
            json!("false"),
            json!("/synthetic/unrelated"),
        ] {
            let mut rpc = pending_thread();
            let mut frame = reply(false, "/synthetic/authorized");
            *frame.pointer_mut(pointer).unwrap() = replacement;
            assert_eq!(
                rpc.receive(&frame.to_string()),
                Err(Blocker::Protocol),
                "{pointer}"
            );
            assert!(rpc.native_session().is_none());
        }
        let mut rpc = pending_thread();
        let mut frame = reply(false, "/synthetic/authorized");
        let (parent, field) = pointer.rsplit_once('/').unwrap();
        frame
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert_eq!(rpc.receive(&frame.to_string()), Err(Blocker::Protocol));
        assert!(rpc.native_session().is_none());
    }
}
