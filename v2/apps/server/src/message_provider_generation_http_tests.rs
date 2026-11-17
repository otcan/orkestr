//! Real HTTP parsing, refusal mapping and receipt idempotency for guarded input.
use super::*;

#[tokio::test]
async fn guarded_message_http_refuses_changed_provider_without_committing_input() {
    let case = case().await;
    let auth = case.auth();
    let body = |generation: serde_json::Value| {
        serde_json::json!({"client_message_id":"synthetic:guarded-http","text":"Synthetic continuation",
            "expected_provider_generation":generation}).to_string()
    };
    let path = case.path("/messages");
    let (status, _) = send(&case.state, "POST", &path, &[], &body(0.into())).await;
    assert_eq!(status, 401);
    let (status, value) = send(&case.state, "POST", &path, &[&auth], &body(1.into())).await;
    assert_eq!(status, 409);
    assert_eq!(value["code"], "provider_generation_changed");
    for invalid in [serde_json::json!(-1), serde_json::json!(true)] {
        let (status, _) = send(&case.state, "POST", &path, &[&auth], &body(invalid)).await;
        assert_eq!(status, 400);
    }
    let (status, snapshot) = send(&case.state, "GET", &case.path(""), &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 0);
    assert_eq!(snapshot["last_sequence"], 0);
    let (status, first) = send(&case.state, "POST", &path, &[&auth], &body(0.into())).await;
    assert_eq!(status, 202);
    let (status, retry) = send(&case.state, "POST", &path, &[&auth], &body(0.into())).await;
    assert_eq!(status, 200);
    assert_eq!(first["message_id"], retry["message_id"]);
    let (status, snapshot) = send(&case.state, "GET", &case.path(""), &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 1);
    case.finish().await;
}

#[tokio::test]
async fn continuation_of_a_source_run_that_no_longer_continues_has_its_own_refusal() {
    let case = case().await;
    let auth = case.auth();
    // ORK-843: the provider generation matches; the source run does not.
    let body = serde_json::json!({"client_message_id":"synthetic:superseded-continuation",
        "text":"Synthetic late host result","expected_provider_generation":0,
        "continuation_source_run_id":Uuid::new_v4(),"author":"v1_agent"})
    .to_string();
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/messages"),
        &[&auth],
        &body,
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(value["code"], "source_superseded");
    let (status, snapshot) = send(&case.state, "GET", &case.path(""), &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 0);
    case.finish().await;
}
