use orkestr_runtime::{
    codex_rpc::{CodexRpc, Readiness},
    ports::Blocker,
};

fn initialized(rpc: &mut CodexRpc) {
    assert_eq!(rpc.initialize().unwrap()["id"], 1);
    assert_eq!(rpc.receive(r#"{"id":1,"result":{"userAgent":"codex/0.163.0","platformFamily":"unix","platformOs":"linux","codexHome":"/synthetic/provider"}}"#).unwrap().unwrap()["method"], "initialized");
}
#[test]
fn protocol_readiness_is_distinct_from_subscription_and_turn_start() {
    let mut rpc = CodexRpc::default();
    assert_eq!(rpc.account_read(), Err(Blocker::Protocol));
    initialized(&mut rpc);
    assert_eq!(rpc.readiness(), Readiness::Initialized);
    let request = rpc.account_read().unwrap();
    assert_eq!(request["params"]["refreshToken"], false);
    rpc.receive(r#"{"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt"}}}"#)
        .unwrap();
    assert_eq!(rpc.readiness(), Readiness::Subscription);
    assert_eq!(rpc.initialize(), Err(Blocker::Protocol));
}
#[test]
fn wrong_id_errors_and_notifications_do_not_consume_pending_request() {
    let mut rpc = CodexRpc::default();
    rpc.initialize().unwrap();
    assert_eq!(rpc.initialize(), Err(Blocker::Busy));
    assert_eq!(
        rpc.receive(r#"{"method":"account/updated","params":{}}"#),
        Ok(None)
    );
    assert_eq!(
        rpc.receive(r#"{"id":9,"result":{}}"#),
        Err(Blocker::Protocol)
    );
    assert_eq!(
        rpc.receive(r#"{"id":1,"error":{"message":"redacted"}}"#),
        Err(Blocker::Protocol)
    );
    assert_eq!(rpc.readiness(), Readiness::Uninitialized);
    assert_eq!(rpc.initialize(), Err(Blocker::Busy));
}
#[test]
fn non_subscription_routes_are_refused_without_readiness_or_retry() {
    for account in [
        "null",
        r#"{"type":"apiKey"}"#,
        r#"{"type":"amazonBedrock"}"#,
    ] {
        let mut rpc = CodexRpc::default();
        initialized(&mut rpc);
        rpc.account_read().unwrap();
        assert_eq!(
            rpc.receive(&format!(
                r#"{{"id":2,"result":{{"requiresOpenaiAuth":true,"account":{account}}}}}"#
            )),
            Err(Blocker::Unsupported)
        );
        assert_eq!(rpc.readiness(), Readiness::Initialized);
        assert_eq!(rpc.account_read(), Err(Blocker::Busy));
    }
}
#[test]
fn malformed_and_oversized_replies_fail_closed() {
    let mut rpc = CodexRpc::default();
    rpc.initialize().unwrap();
    for frame in [
        "x".repeat(65537),
        r#"{"id":1,"result":{"userAgent":"x"}}"#.into(),
        "null".into(),
    ] {
        assert_eq!(rpc.receive(&frame), Err(Blocker::Protocol));
        assert_eq!(rpc.readiness(), Readiness::Uninitialized);
    }
}

#[test]
fn persistent_native_session_requires_authenticated_protocol_and_safe_policy() {
    let mut rpc = CodexRpc::default();
    assert_eq!(
        rpc.create_session(std::path::Path::new("/synthetic/workspace")),
        Err(Blocker::Protocol)
    );
    initialized(&mut rpc);
    rpc.account_read().unwrap();
    rpc.receive(r#"{"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt"}}}"#)
        .unwrap();
    assert_eq!(
        rpc.create_session(std::path::Path::new("relative")),
        Err(Blocker::Protocol)
    );
    let request = rpc
        .create_session(std::path::Path::new("/synthetic/workspace"))
        .unwrap();
    assert_eq!(request["method"], "thread/start");
    assert_eq!(request["params"]["ephemeral"], false);
    assert_eq!(rpc.native_session(), None);
    // Caller/provider policy broadening is refused, leaving readiness unconfirmed.
    assert_eq!(rpc.receive(r#"{"id":3,"result":{"cwd":"/synthetic/workspace","thread":{"id":"synthetic-thread","cwd":"/synthetic/workspace","ephemeral":false},"approvalPolicy":"never","sandbox":{"type":"dangerFullAccess"}}}"#), Err(Blocker::Protocol));
    assert_eq!(rpc.native_session(), None);
    for access in ["true", "\"false\""] {
        assert_eq!(rpc.receive(&format!(r#"{{"id":3,"result":{{"thread":{{"id":"synthetic-thread"}},"approvalPolicy":"never","sandbox":{{"type":"readOnly","networkAccess":{access}}}}}}}"#)), Err(Blocker::Protocol));
        assert_eq!(rpc.native_session(), None);
    }
    rpc.receive(r#"{"id":3,"result":{"cwd":"/synthetic/workspace","thread":{"id":"synthetic-thread","cwd":"/synthetic/workspace","ephemeral":false},"approvalPolicy":"never","sandbox":{"type":"readOnly"}}}"#).unwrap();
    assert_eq!(rpc.native_session(), Some("synthetic-thread"));
    assert_eq!(
        rpc.create_session(std::path::Path::new("/synthetic/workspace")),
        Err(Blocker::Protocol)
    );
}

#[test]
fn persistence_and_both_workspace_fields_are_required_before_confirmation() {
    use serde_json::json;
    let mut rpc = CodexRpc::default();
    initialized(&mut rpc);
    rpc.account_read().unwrap();
    rpc.receive(r#"{"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt"}}}"#)
        .unwrap();
    for path in [
        "/synthetic/../workspace",
        "/synthetic/./workspace",
        "/synthetic//workspace",
        "/synthetic/workspace/",
    ] {
        assert_eq!(
            rpc.create_session(std::path::Path::new(path)),
            Err(Blocker::Protocol)
        );
    }
    rpc.create_session(std::path::Path::new("/synthetic/workspace"))
        .unwrap();
    let valid = json!({"id":3,"result":{"cwd":"/synthetic/workspace","thread":{"id":"synthetic-thread","cwd":"/synthetic/workspace","ephemeral":false},"approvalPolicy":"never","sandbox":{"type":"readOnly"}}});
    for pointer in [
        "/result/thread/ephemeral",
        "/result/thread/cwd",
        "/result/cwd",
    ] {
        for replacement in [
            serde_json::Value::Null,
            json!(true),
            json!("false"),
            json!(42),
            json!("/synthetic/unrelated"),
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(pointer).unwrap() = replacement;
            assert_eq!(rpc.receive(&invalid.to_string()), Err(Blocker::Protocol));
            assert!(rpc.native_session().is_none());
        }
        let mut missing = valid.clone();
        if pointer == "/result/cwd" {
            missing["result"].as_object_mut().unwrap().remove("cwd");
        } else {
            missing["result"]["thread"]
                .as_object_mut()
                .unwrap()
                .remove(pointer.rsplit('/').next().unwrap());
        }
        assert_eq!(rpc.receive(&missing.to_string()), Err(Blocker::Protocol));
        assert!(rpc.native_session().is_none());
    }
    assert_eq!(rpc.receive(&valid.to_string()), Ok(None));
    assert_eq!(rpc.native_session(), Some("synthetic-thread"));
}
