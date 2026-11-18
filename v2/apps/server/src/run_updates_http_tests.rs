use super::*;
use axum::{body::to_bytes, http::Uri};

struct Temporary(std::path::PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn fixture() -> (Temporary, AppState, ConversationId, String) {
    let temp = Temporary(std::env::temp_dir().join(format!("run-updates-http-{}", Uuid::new_v4())));
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
    bearer: bool,
) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:19880".parse().unwrap());
    if let Some(token) = token {
        headers.insert(
            "cookie",
            format!("orkestr_v2_session={token}").parse().unwrap(),
        );
    }
    if bearer {
        headers.insert(
            "authorization",
            format!("Bearer {}", "c".repeat(64)).parse().unwrap(),
        );
    }
    let uri: Uri = format!("/updates/{id}{query}").parse().unwrap();
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
async fn updates_need_the_owner_browser_session_and_its_conversation() {
    let (_temporary, state, conversation, token) = fixture().await;
    let id = conversation.to_string();
    assert_eq!(
        request(&state, &id, "", None, false).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&state, &id, "", Some(&token), true).await.status(),
        StatusCode::UNAUTHORIZED,
        "a bearer beside the cookie is refused"
    );
    for query in ["", "?before_sequence=9223372036854775807&limit=100"] {
        let response = request(&state, &id, query, Some(&token), false).await;
        assert_eq!(response.status(), StatusCode::OK, "{query}");
        let value: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"conversation_id":conversation,"updates":[],"next_after_sequence":null})
        );
    }
    assert_eq!(
        request(&state, &Uuid::new_v4().to_string(), "", Some(&token), false)
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
        request(&state, &id, "", Some(&token), false).await.status(),
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
        "?limit=101",
        "?limit=65536",
        "?after_sequence=bad",
        "?before_sequence=0",
        "?before_sequence=5&after_sequence=1",
        "?unknown=1",
        "?after_sequence=0&after_sequence=1",
    ] {
        assert_eq!(
            request(&state, &id, query, Some(&token), false)
                .await
                .status(),
            StatusCode::BAD_REQUEST,
            "{query}"
        );
    }
    for bad_id in ["invalid", "00000000-0000-0000-0000-000000000000"] {
        assert_eq!(
            request(&state, bad_id, "", Some(&token), false)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(
            &state,
            &id,
            "?after_sequence=0&limit=100",
            Some(&token),
            false
        )
        .await
        .status(),
        StatusCode::OK
    );
    state.store.close().await;
}
