use super::*;
use sha2::Digest;

#[tokio::test]
async fn source_receipt_http_auth_validation_legacy_and_absence_never_admit() {
    let case = case().await;
    let auth = case.auth();
    let path = case.path("/source-receipts/lookup");
    let query = serde_json::json!({"client_message_id":"synthetic:source-handoff", "text_sha256":format!("{:x}",sha2::Sha256::digest(b"Synthetic source decision")),
        "expected_provider_generation":0,"continuation_source_run_id":Uuid::new_v4(),"source_native_session_id":"synthetic-native","source_provider":"codex","author":"v1_agent"});
    let body = query.to_string();
    assert_eq!(send(&case.state, "POST", &path, &[], &body).await.0, 401);
    let (status, p) = send(&case.state, "POST", &path, &[&auth], &body).await;
    assert_eq!(status, 200);
    assert_eq!(p["admission_state"], "missing");
    assert_eq!(p["work_completed"], false);
    let input = serde_json::json!({"client_message_id":"synthetic:source-handoff","text":"Synthetic source decision","author":"v1_agent"});
    assert_eq!(
        send(
            &case.state,
            "POST",
            &case.path("/messages"),
            &[&auth],
            &input.to_string()
        )
        .await
        .0,
        202
    );
    let (status, p) = send(&case.state, "POST", &path, &[&auth], &body).await;
    assert_eq!(status, 200);
    assert_eq!(p["admission_state"], "legacy_unproven");
    assert!(p["admission"].is_null());
    let mut changed = query.clone();
    changed["text_sha256"] = "a".repeat(64).into();
    assert_eq!(
        send(&case.state, "POST", &path, &[&auth], &changed.to_string())
            .await
            .0,
        409
    );
    for bad in [serde_json::json!({"unexpected":true}), {
        let mut q = query.clone();
        q["expected_provider_generation"] = true.into();
        q
    }] {
        assert_eq!(
            send(&case.state, "POST", &path, &[&auth], &bad.to_string())
                .await
                .0,
            400
        );
    }
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    assert_eq!(
        send(&case.state, "POST", &path, &[&cookie], &body).await.0,
        403
    );
    let (status, session) = send(
        &case.state,
        "GET",
        "/api/v2/browser/session",
        &[&cookie],
        "",
    )
    .await;
    assert_eq!(status, 200);
    let csrf = format!(
        "x-orkestr-csrf: {}",
        session["csrf_token"].as_str().unwrap()
    );
    assert_eq!(
        send(
            &case.state,
            "POST",
            &path,
            &[&cookie, &csrf, "Origin: http://127.0.0.1:19882"],
            &body
        )
        .await
        .0,
        200
    );
    let foreign = format!(
        "/api/v2/conversations/{}/source-receipts/lookup",
        Uuid::new_v4()
    );
    assert_eq!(
        send(&case.state, "POST", &foreign, &[&auth], &body).await.0,
        404
    );
    let context = serde_json::json!({"source_run_id":query["continuation_source_run_id"],"source_message_id":Uuid::new_v4()});
    assert_eq!(
        send(
            &case.state,
            "POST",
            &case.path("/source-runs/lookup"),
            &[&auth],
            &context.to_string()
        )
        .await
        .0,
        404
    );
    let (status, history) = send(&case.state, "GET", &case.path(""), &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(history["messages"].as_array().unwrap().len(), 1);
    case.finish().await;
}

#[tokio::test]
async fn source_receipt_http_fresh_continuation_proves_actual_original_source_and_receipt() {
    use orkestr_v2_application::runtime::{
        NativeSessionConfirmation, ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
        RuntimeStore,
    };
    let case = case().await;
    let auth = case.auth();
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let handle = case
        .state
        .store
        .authorize_supervisor(
            &case.bearer,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-receipt".into(),
                supervisor_key: "synthetic-source".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let binding = handle
        .ensure_role_bindings(&owner, &case.conversation)
        .await
        .unwrap()
        .deep;
    let binding = handle
        .confirm_native_session(NativeSessionConfirmation {
            session_id: binding.session_id,
            expected_generation: binding.generation,
            native_session_id: "synthetic-source-native".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "synthetic-source-ready".into(),
        })
        .await
        .unwrap();
    let source = serde_json::json!({"client_message_id":"synthetic:original","text":"Synthetic original input","author":"v1_agent"});
    let (status, original) = send(
        &case.state,
        "POST",
        &case.path("/messages"),
        &[&auth],
        &source.to_string(),
    )
    .await;
    assert_eq!(status, 202);
    let claim = handle
        .claim_next(
            &owner,
            &case.conversation,
            &binding.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let run = handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "synthetic-source-run",
        )
        .await
        .unwrap()
        .provider
        .run
        .run_id;
    let context =
        serde_json::json!({"source_run_id":run,"source_message_id":original["message_id"]});
    let (status, context) = send(
        &case.state,
        "POST",
        &case.path("/source-runs/lookup"),
        &[&auth],
        &context.to_string(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(context["eligible_for_continuation"], true);
    assert_eq!(context["owner_id"], owner.to_string());
    assert_eq!(
        context["source_native_session_id"],
        "synthetic-source-native"
    );
    let decision = serde_json::json!({"client_message_id":"approval-handoff-synthetic","text":"Synthetic scoped decision",
        "author":"v1_agent","expected_provider_generation":0,"continuation_source_run_id":run});
    let (status, receipt) = send(
        &case.state,
        "POST",
        &case.path("/messages"),
        &[&auth],
        &decision.to_string(),
    )
    .await;
    assert_eq!(status, 202);
    let lookup = serde_json::json!({"client_message_id":decision["client_message_id"],
        "text_sha256":format!("{:x}",sha2::Sha256::digest(b"Synthetic scoped decision")),
        "expected_provider_generation":0,"continuation_source_run_id":run,"source_native_session_id":"synthetic-source-native",
        "source_provider":"codex","author":"v1_agent"});
    let (status, proof) = send(
        &case.state,
        "POST",
        &case.path("/source-receipts/lookup"),
        &[&auth],
        &lookup.to_string(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(proof["admission_state"], "admitted");
    assert_eq!(proof["business_state"], "unverified");
    assert_eq!(proof["admission"]["message_id"], receipt["message_id"]);
    assert_eq!(proof["admission"]["event_id"], receipt["event_id"]);
    assert_eq!(proof["admission"]["sequence"], receipt["sequence"]);
    assert_eq!(proof["admission"]["authentication_kind"], "machine");
    assert_eq!(proof["work_completed"], false);
    assert!(proof["run"].is_null());
    case.finish().await;
}
