use super::*;

// Marker injection is fixture-only; production obtains it from TrustedLauncher.
fn fixture_broker(case: &mut Case) -> crate::broker::channel::BrokerChannel {
    let child = case.child.as_mut().unwrap();
    child.broker_launcher = true;
    child.process.broker_launcher.store(true, Ordering::Release);
    let mut open = child.open_broker_metadata().unwrap();
    child.flush_stdin().unwrap();
    let request: serde_json::Value = serde_json::from_slice(&metadata_frame(child)).unwrap();
    let reply = json!({"id":1,"result":{"protocol":crate::broker::PROTOCOL,
        "identity":request["params"]["identity"],"metadata_only":true,
        "owned_handle":"synthetic_owned"}});
    open.receive(reply.to_string().as_bytes())
        .unwrap()
        .into_channel()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_broker_setup_uses_real_metadata_fence() {
    let mut case = Case::new().await;
    let mut channel = fixture_broker(&mut case);
    let child = case.child.as_ref().unwrap();
    let request = channel
        .metadata(serde_json::from_slice(&setup_frame()).unwrap())
        .unwrap();
    child.enqueue_broker_metadata(request).unwrap();
    child.flush_stdin().unwrap();
    let frame: serde_json::Value = serde_json::from_slice(&metadata_frame(child)).unwrap();
    assert_eq!(frame["method"], "BrokerMetadata");
    assert_eq!(frame["params"]["frame"]["method"], "account/read");
    assert!(child
        .enqueue_metadata(frame.to_string().as_bytes())
        .is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_broker_setup_cannot_cross_owned_child_lineage() {
    let mut first = Case::new().await;
    let mut second = Case::new().await;
    let mut channel = fixture_broker(&mut first);
    let _ = fixture_broker(&mut second);
    let request = channel
        .metadata(serde_json::from_slice(&setup_frame()).unwrap())
        .unwrap();
    assert_eq!(
        second
            .child
            .as_ref()
            .unwrap()
            .enqueue_broker_metadata(request),
        Err(Error::WrongScope)
    );
    assert_eq!(
        second.child.as_ref().unwrap().flush_stdin(),
        Err(Error::Revoked)
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_broker_setup_revoked_before_enqueue_never_queues() {
    let mut case = Case::new().await;
    let mut channel = fixture_broker(&mut case);
    let request = channel
        .metadata(serde_json::from_slice(&setup_frame()).unwrap())
        .unwrap();
    case.authority.revoke().unwrap();
    assert!(case
        .child
        .as_ref()
        .unwrap()
        .enqueue_broker_metadata(request)
        .is_err());
    assert_eq!(
        case.child.as_ref().unwrap().flush_stdin(),
        Err(Error::Revoked)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_codex_create_session_passes_sealed_setup_only_when_pinned() {
    for provider in [Some("openai"), Some("external"), None] {
        let mut case = Case::new().await;
        let mut channel = fixture_broker(&mut case);
        let child = case.child.as_ref().unwrap();
        let mut rpc = crate::codex_rpc::CodexRpc::default();
        let init = rpc.initialize().unwrap();
        rpc.receive(
            &json!({"id":init["id"],"result":{"userAgent":"synthetic",
            "platformFamily":"unix","platformOs":"linux","codexHome":"broker-private"}})
            .to_string(),
        )
        .unwrap();
        let account = rpc.account_read().unwrap();
        rpc.receive(
            &json!({"id":account["id"],"result":{"requiresOpenaiAuth":true,
            "account":{"type":"chatgpt"}}})
            .to_string(),
        )
        .unwrap();
        let mut frame = rpc.create_session(&child.process.workspace).unwrap();
        assert_eq!(frame["params"]["modelProvider"], "openai");
        match provider {
            Some(provider) => frame["params"]["modelProvider"] = json!(provider),
            None => {
                frame["params"]
                    .as_object_mut()
                    .unwrap()
                    .remove("modelProvider");
            }
        }
        let request = channel.metadata(frame).unwrap();
        let submitted = child.enqueue_broker_metadata(request);
        if provider == Some("openai") {
            submitted.unwrap();
            child.flush_stdin().unwrap();
            let sent: serde_json::Value = serde_json::from_slice(&metadata_frame(child)).unwrap();
            assert_eq!(sent["params"]["frame"]["params"]["modelProvider"], "openai");
        } else {
            assert_eq!(submitted, Err(Error::InvalidFrame));
            assert_eq!(child.flush_stdin(), Err(Error::Revoked));
        }
    }
}
