//! Real cookie/CSRF guards; no native controller or provider is installed here.
use super::*;
use crate::held_inputs::tests::fixture::{headers, state, Temporary, AUTHORITY, COOKIE};
use orkestr_v2_contracts::ProviderHandoffRequest;
use sha2::{Digest, Sha256};

fn authorized() -> HeaderMap {
    let mut h = headers(Some(COOKIE), AUTHORITY);
    h.insert("origin", format!("http://{AUTHORITY}").parse().unwrap());
    let csrf = format!(
        "{:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{COOKIE}").as_bytes())
    );
    h.insert("x-orkestr-csrf", csrf.parse().unwrap());
    h
}

#[tokio::test]
async fn provider_handoff_http_requires_browser_origin_csrf_and_allowed_model_without_execution() {
    let root =
        Temporary(std::env::temp_dir().join(format!("provider-handoff-http-{}", Uuid::new_v4())));
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
    let state = state(store);
    let request = ProviderHandoffRequest {
        request_key: "synthetic:handoff".into(),
        window_id: Uuid::from_u128(1),
        generation: 1,
        expected_settings_revision: 0,
        target_provider: orkestr_v2_contracts::ConversationProvider::Claude,
        model: Some("opus".into()),
        reasoning_effort: Some("high".into()),
        acknowledge_new_native_session: true,
        history_summary: "Synthetic reviewed context only; no actions to replay.".into(),
    };
    let mut variants = vec![(headers(None, AUTHORITY), StatusCode::UNAUTHORIZED)];
    for (key, value) in [
        ("host", "foreign.invalid"),
        ("origin", "http://foreign.invalid"),
        ("x-orkestr-csrf", "wrong"),
    ] {
        let mut h = authorized();
        h.insert(key, value.parse().unwrap());
        variants.push((h, StatusCode::FORBIDDEN));
    }
    let mut machine = authorized();
    machine.insert("authorization", "Bearer synthetic-machine".parse().unwrap());
    variants.push((machine, StatusCode::UNAUTHORIZED));
    for (h, expected) in variants {
        let response = window_http::handoff_provider(
            State(state.clone()),
            h,
            axum::extract::Path(conversation.to_string()),
            Ok(Json(request.clone())),
        )
        .await
        .unwrap_or_else(IntoResponse::into_response);
        assert_eq!(response.status(), expected);
    }
    let mut denied = request.clone();
    denied.model = Some("fable".into());
    let response = window_http::handoff_provider(
        State(state.clone()),
        authorized(),
        axum::extract::Path(conversation.to_string()),
        Ok(Json(denied)),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = window_http::handoff_provider(
        State(state.clone()),
        authorized(),
        axum::extract::Path(conversation.to_string()),
        Ok(Json(request)),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    assert_eq!(
        response.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "No controller means no handoff authority"
    );
    assert!(state
        .store
        .execution_window_status_authenticated(&format!("browser:{COOKIE}"), &conversation)
        .await
        .unwrap()
        .is_none());
    assert!(state
        .store
        .provider_handoff_receipt_authenticated(
            &format!("browser:{COOKIE}"),
            &conversation,
            "synthetic:handoff"
        )
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        state
            .store
            .conversation_settings(&format!("browser:{COOKIE}"), &owner, &conversation)
            .await
            .unwrap()
            .revision,
        0
    );
}
