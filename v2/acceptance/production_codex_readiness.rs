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
        "thread":{"id":"synthetic-native-thread","ephemeral":ephemeral},
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
