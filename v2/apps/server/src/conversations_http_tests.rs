use super::*;
use axum::body::to_bytes;
use sha2::{Digest, Sha256};

async fn fixture() -> (std::path::PathBuf, AppState, HeaderMap) {
    let root = std::env::temp_dir().join(format!("conversation-http-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let cookie = "a".repeat(64);
    store
        .save_session(&format!("browser:{cookie}"), &owner)
        .await
        .unwrap();
    let state = AppState::new(store, "b".repeat(64), "http://127.0.0.1:19880".into()).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:19880".parse().unwrap());
    headers.insert("origin", "http://127.0.0.1:19880".parse().unwrap());
    headers.insert(
        "cookie",
        format!("orkestr_v2_session={cookie}").parse().unwrap(),
    );
    headers.insert(
        "x-orkestr-csrf",
        format!(
            "{:x}",
            Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{cookie}").as_bytes())
        )
        .parse()
        .unwrap(),
    );
    (root, state, headers)
}
fn request() -> ConversationInput {
    ConversationInput {
        client_request_id: "new-native-thread".into(),
        name: "Synthetic workbench".into(),
    }
}

#[tokio::test]
async fn current_browser_creates_lists_and_replays_native_thread_without_window() {
    let (root, state, headers) = fixture().await;
    let response = create(State(state.clone()), headers.clone(), Ok(Json(request())))
        .await
        .unwrap_or_else(|error| panic!("valid create refused: {}", error.2));
    assert_eq!(response.status(), StatusCode::CREATED);
    let created: ConversationSummary =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(created.name, "Synthetic workbench");
    assert_eq!(created.last_sequence, 0);
    assert_eq!(
        create(State(state.clone()), headers.clone(), Ok(Json(request())))
            .await
            .unwrap_or_else(|error| panic!("valid replay refused: {}", error.2))
            .status(),
        StatusCode::OK
    );
    let response = list(
        State(state.clone()),
        headers.clone(),
        Ok(Query(Page::default())),
    )
    .await
    .unwrap_or_else(|error| panic!("valid list refused: {}", error.2));
    let page: ConversationPage =
        serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
    assert_eq!(page.conversations.len(), 2);
    assert_eq!(
        page.conversations[1].conversation_id,
        created.conversation_id
    );
    assert!(state
        .store
        .execution_window_status_authenticated(
            &browser::credential(&headers)
                .unwrap_or_else(|error| panic!("valid browser credential refused: {}", error.2)),
            &created.conversation_id
        )
        .await
        .unwrap()
        .is_none());
    state.store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn conversation_creation_preserves_host_origin_csrf_and_browser_namespace() {
    let (root, state, headers) = fixture().await;
    for field in ["origin", "x-orkestr-csrf"] {
        let mut bad = headers.clone();
        bad.remove(field);
        assert_eq!(
            create(State(state.clone()), bad, Ok(Json(request())))
                .await
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let mut bad = headers.clone();
    bad.insert("host", "foreign.invalid".parse().unwrap());
    assert_eq!(
        list(State(state.clone()), bad, Ok(Query(Page::default())))
            .await
            .unwrap_err()
            .0,
        StatusCode::FORBIDDEN
    );
    let mut bad = headers.clone();
    bad.insert("authorization", "Bearer synthetic".parse().unwrap());
    assert_eq!(
        create(State(state.clone()), bad, Ok(Json(request())))
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    state
        .store
        .revoke_session(
            &browser::credential(&headers)
                .unwrap_or_else(|error| panic!("valid browser credential refused: {}", error.2)),
        )
        .await
        .unwrap();
    assert_eq!(
        create(State(state.clone()), headers, Ok(Json(request())))
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    state.store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
