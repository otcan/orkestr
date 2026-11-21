//! The owner read of a native-attach hold, the health feature, and the
//! provider handoff and native reset refusals while a hold is active. No
//! window runtime is installed here.
use super::*;
use crate::held_inputs::tests::fixture::{headers, state, Temporary, AUTHORITY, COOKIE};
use crate::native_attach::fixture::Holds;
use orkestr_v2_contracts::{
    ClaudeNativeResetRequest, ConversationProvider, ProviderHandoffRequest,
};
use orkestr_v2_store_sqlite::Store;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

async fn fixture() -> (Temporary, AppState, ConversationId) {
    let root =
        Temporary(std::env::temp_dir().join(format!("native-attach-http-{}", Uuid::new_v4())));
    std::fs::create_dir(&root.0).unwrap();
    let store = Store::open(&root.0.join("core.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store
        .save_session(&format!("browser:{COOKIE}"), &owner)
        .await
        .unwrap();
    (root, state(store), conversation)
}

/// The owner's browser with origin and CSRF, as the web app sends it.
fn authorized() -> HeaderMap {
    let mut h = headers(Some(COOKIE), AUTHORITY);
    h.insert("origin", format!("http://{AUTHORITY}").parse().unwrap());
    let csrf = Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{COOKIE}").as_bytes());
    h.insert("x-orkestr-csrf", format!("{csrf:x}").parse().unwrap());
    h
}

async fn body(result: Result<Response, Error>) -> (StatusCode, Value) {
    let response = result.unwrap_or_else(IntoResponse::into_response);
    let code = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
        .await
        .unwrap();
    (code, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn read(state: &AppState, id: &str, h: HeaderMap) -> (StatusCode, Value) {
    body(status(State(state.clone()), h, Path(id.to_owned())).await).await
}

#[tokio::test]
async fn the_owner_reads_a_hold_only_where_holds_are_configured() {
    let (_root, mut state, conversation) = fixture().await;
    let id = conversation.to_string();
    let owner = || headers(Some(COOKIE), AUTHORITY);
    let (code, value) = read(&state, &id, owner()).await;
    assert_eq!(
        (code, value["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("native_attach_unconfigured"))
    );
    assert_eq!(features(&state, &["base"]), vec!["base"]);
    let holds = Holds::new();
    state.native_attach = Some(holds.holds.clone());
    assert_eq!(
        features(&state, &["base"]),
        vec!["base", "native_attach_hold_v1"]
    );
    let (code, value) = read(&state, &id, owner()).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        value,
        json!({"conversation_id": id, "held": false, "provider": null,
            "native_session_id": null, "session_id": null, "acquired_at_ms": null,
            "expires_at_ms": null, "max_age_deadline_ms": null, "native_idle": true})
    );
    holds.hold(&conversation);
    let (code, value) = read(&state, &id, owner()).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(value["held"], json!(true));
    assert_eq!(value["provider"], json!("codex"));
    assert_eq!(
        value["native_session_id"],
        json!(Uuid::from_u128(0xa71e).to_string())
    );
    assert_eq!(
        value["session_id"],
        json!(Uuid::from_u128(0x5e55_1011).to_string())
    );
    let acquired = value["acquired_at_ms"].as_i64().unwrap();
    assert!(value["expires_at_ms"].as_i64().unwrap() > acquired);
    assert_eq!(
        value["max_age_deadline_ms"].as_i64(),
        Some(acquired + crate::native_attach::MAX_HOLD_AGE_MS)
    );
    // No window was ever opened: nothing of V2 runs this native session.
    assert_eq!(value["native_idle"], json!(true));
    // Owner session required; the identifier must be a conversation.
    let (code, _) = read(&state, &id, headers(None, AUTHORITY)).await;
    assert_eq!(code, StatusCode::UNAUTHORIZED);
    let (code, _) = read(&state, "not-a-conversation", owner()).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    holds.release(&conversation);
    let (_, value) = read(&state, &id, owner()).await;
    assert_eq!(value["held"], json!(false));
}

#[tokio::test]
async fn health_and_the_router_serve_holds_only_when_configured() {
    use crate::conversation_resources_http::tests::{case, send};
    let case = case().await;
    let mut state = case.state.clone();
    let advertised = |health: &Value| {
        health["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|feature| feature == "native_attach_hold_v1")
    };
    let (code, health) = send(&state, "GET", "/api/v2/health", &[], "").await;
    assert_eq!(code, 200);
    assert!(!advertised(&health));
    let holds = Holds::new();
    state.native_attach = Some(holds.holds.clone());
    let (code, health) = send(&state, "GET", "/api/v2/health", &[], "").await;
    assert_eq!(code, 200);
    assert!(advertised(&health));
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let path = case.path("/native-attach");
    let (code, value) = send(&state, "GET", &path, &[&cookie], "").await;
    assert_eq!((code, value["held"].clone()), (200, json!(false)));
    case.finish().await;
}

async fn handoff(state: &AppState, id: &str) -> (StatusCode, Value) {
    let request = ProviderHandoffRequest {
        request_key: "synthetic:handoff".into(),
        window_id: Uuid::from_u128(1),
        generation: 1,
        expected_settings_revision: 0,
        target_provider: ConversationProvider::Claude,
        model: Some("opus".into()),
        reasoning_effort: Some("high".into()),
        acknowledge_new_native_session: true,
        history_summary: "Synthetic reviewed context only; no actions to replay.".into(),
    };
    body(
        crate::window_http::handoff_provider(
            State(state.clone()),
            authorized(),
            Path(id.to_owned()),
            Ok(Json(request)),
        )
        .await,
    )
    .await
}

async fn reset(state: &AppState, id: &str) -> (StatusCode, Value) {
    let request = ClaudeNativeResetRequest {
        request_key: "synthetic:reset".into(),
        window_id: Uuid::from_u128(1),
        generation: 1,
        acknowledge_native_history_loss: true,
    };
    body(
        crate::window_http::reset_native(
            State(state.clone()),
            authorized(),
            Path(id.to_owned()),
            Ok(Json(request)),
        )
        .await,
    )
    .await
}

#[tokio::test]
async fn handoff_and_native_reset_are_refused_while_held_and_not_after() {
    let (_root, mut state, conversation) = fixture().await;
    let id = conversation.to_string();
    let holds = Holds::new();
    state.native_attach = Some(holds.holds.clone());
    holds.hold(&conversation);
    for (code, value) in [handoff(&state, &id).await, reset(&state, &id).await] {
        assert_eq!(
            (code, value["code"].as_str()),
            (StatusCode::CONFLICT, Some("native_attach_held"))
        );
    }
    // Released: the ordinary answer (this test server has no window runtime).
    holds.release(&conversation);
    for (code, value) in [handoff(&state, &id).await, reset(&state, &id).await] {
        assert_eq!(
            (code, value["code"].as_str()),
            (StatusCode::SERVICE_UNAVAILABLE, Some("window_unavailable"))
        );
    }
}
