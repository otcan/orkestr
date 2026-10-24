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
