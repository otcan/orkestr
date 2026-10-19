use super::*;
use axum::{body::to_bytes, http::Uri};

struct Temporary(std::path::PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn fixture() -> (Temporary, AppState, ConversationId, String) {
    let temp =
        Temporary(std::env::temp_dir().join(format!("accepted-results-http-{}", Uuid::new_v4())));
    std::fs::create_dir(&temp.0).unwrap();
    let store = Store::open(&temp.0.join("core.sqlite3")).await.unwrap();
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
    let token = "a".repeat(64);
    store
        .save_session(&format!("browser:{token}"), &owner)
        .await
        .unwrap();
    let state = AppState::new(store, "b".repeat(64), "http://127.0.0.1:19880".into()).unwrap();
    (temp, state, conversation, token)
}

async fn request(
    state: &AppState,
    id: &str,
    query: &str,
    token: Option<&str>,
    host: &str,
) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert("host", host.parse().unwrap());
    if let Some(token) = token {
        headers.insert(
            "cookie",
            format!("orkestr_v2_session={token}").parse().unwrap(),
        );
    }
    let uri: Uri = format!("/results/{id}{query}").parse().unwrap();
    read(
        State(state.clone()),
        headers,
        Path(id.to_owned()),
        Query::try_from_uri(&uri),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response)
}

#[tokio::test]
async fn reads_work_without_execution_and_require_current_browser_scope() {
    let (_temporary, state, conversation, token) = fixture().await;
    let id = conversation.to_string();
    assert_eq!(
        request(&state, &id, "", None, "127.0.0.1:19880")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&state, &id, "", Some(&token), "foreign.invalid")
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = request(&state, &id, "", Some(&token), "127.0.0.1:19880").await;
    assert_eq!(response.status(), StatusCode::OK);
    let value: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"conversation_id":conversation,"results":[],"next_after_sequence":null})
    );
    assert_eq!(
        request(
            &state,
            &Uuid::new_v4().to_string(),
            "",
            Some(&token),
            "127.0.0.1:19880"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    state
        .store
        .revoke_session(&format!("browser:{token}"))
        .await
        .unwrap();
    assert_eq!(
        request(&state, &id, "", Some(&token), "127.0.0.1:19880")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    state.store.close().await;
}

#[tokio::test]
async fn malformed_or_unbounded_queries_refuse_before_projection() {
    let (_temporary, state, conversation, token) = fixture().await;
    let id = conversation.to_string();
    for query in [
        "?after_sequence=-1",
        "?limit=0",
        "?limit=51",
        "?limit=65536",
        "?limit=1.5",
        "?after_sequence=bad",
        "?unknown=1",
        "?after_sequence=0&after_sequence=1",
    ] {
        assert_eq!(
            request(&state, &id, query, Some(&token), "127.0.0.1:19880")
                .await
                .status(),
            StatusCode::BAD_REQUEST,
            "{query}"
        );
    }
    for bad_id in ["invalid", "00000000-0000-0000-0000-000000000000"] {
        assert_eq!(
            request(&state, bad_id, "", Some(&token), "127.0.0.1:19880")
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(
            &state,
            &id,
            "?after_sequence=0&limit=50",
            Some(&token),
            "127.0.0.1:19880"
        )
        .await
        .status(),
        StatusCode::OK
    );
    state.store.close().await;
}
