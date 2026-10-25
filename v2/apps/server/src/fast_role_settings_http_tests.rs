use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::json;

#[tokio::test]
async fn fast_model_is_separate_idempotent_and_owner_scoped() {
    let case = case().await;
    let auth = case.auth();
    let path = case.path("/fast/settings");
    let (status, initial) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(initial["revision"], 0);
    assert!(initial["model"].is_null());
    let (_, deep_before) = send(&case.state, "GET", &case.path("/settings"), &[&auth], "").await;
    let request = json!({"expected_revision":0,"model":"gpt-6-luna","reasoning_effort":"low"});
    let (status, selected) = send(&case.state, "PUT", &path, &[&auth], &request.to_string()).await;
    assert_eq!(status, 200);
    assert_eq!(selected["revision"], 1);
    assert_eq!(selected["model"], "gpt-6-luna");
    let (status, replayed) = send(&case.state, "PUT", &path, &[&auth], &request.to_string()).await;
    assert_eq!(status, 200);
    assert_eq!(selected, replayed);
    let (_, deep_after) = send(&case.state, "GET", &case.path("/settings"), &[&auth], "").await;
    assert_eq!(
        deep_before, deep_after,
        "Fast never changes Deep settings or provider generation"
    );
    let stale = json!({"expected_revision":0,"model":"gpt-6.1-sol","reasoning_effort":"low"});
    let (status, value) = send(&case.state, "PUT", &path, &[&auth], &stale.to_string()).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("fast_settings_revision_mismatch"))
    );
    let (status, _) = send(&case.state, "GET", &path, &[], "").await;
    assert_eq!(status, 401);
    let other = format!("/api/v2/conversations/{}/fast/settings", Uuid::new_v4());
    let (status, _) = send(&case.state, "PUT", &other, &[&auth], &request.to_string()).await;
    assert_eq!(status, 404);
    for bad in [
        json!({"expected_revision":1,"model":"bad/model"}),
        json!({"expected_revision":1,"model":"gpt-6-luna","reasoning_effort":"invalid"}),
        json!({"expected_revision":1,"provider":"claude","model":"gpt-6-luna"}),
    ] {
        let (status, _) = send(&case.state, "PUT", &path, &[&auth], &bad.to_string()).await;
        assert_eq!(status, 400);
    }
    let reset = json!({"expected_revision":1,"model":null,"reasoning_effort":null});
    let (status, value) = send(&case.state, "PUT", &path, &[&auth], &reset.to_string()).await;
    assert_eq!(status, 200);
    assert_eq!(value["revision"], 2);
    assert!(value["model"].is_null());
    case.finish().await;
}

#[tokio::test]
async fn codex_fast_override_refuses_a_claude_conversation_without_changing_it() {
    let mut case = case().await;
    case.state = case.state.clone().with_claude_turns();
    let auth = case.auth();
    let (_, deep) = send(
        &case.state,
        "PUT",
        &case.path("/settings"),
        &[&auth],
        &json!({"expected_revision":0,"provider":"claude","honor_no_reply":true}).to_string(),
    )
    .await;
    assert_eq!(deep["provider"], "claude");
    let request = json!({"expected_revision":0,"model":"gpt-6-luna","reasoning_effort":"low"});
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/fast/settings"),
        &[&auth],
        &request.to_string(),
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("fast_codex_settings_require_codex"))
    );
    let (_, after) = send(&case.state, "GET", &case.path("/settings"), &[&auth], "").await;
    assert_eq!(after, deep);
    case.finish().await;
}
