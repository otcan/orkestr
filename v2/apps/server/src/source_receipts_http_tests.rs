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
