//! Real ordinary Store authentication and scope; no fake discovery implementation.
use super::*;
use orkestr_v2_application::runtime::*;

fn query(value: &str) -> std::result::Result<Query<DiscoveryQuery>, QueryRejection> {
    Query::try_from_uri(&format!("http://localhost/workers{value}").parse().unwrap())
}

#[tokio::test]
async fn authenticated_query_and_context_boundaries() {
    let root = std::env::temp_dir().join(format!("worker-discovery-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("state.sqlite3")).await.unwrap();
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
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    store
        .save_session(&format!("browser:{token}"), &owner)
        .await
        .unwrap();
    let bound = store
        .authorize_supervisor(
            &token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-discovery".into(),
                supervisor_key: "synthetic-controller".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    // Initializes canonical bindings/revision through the public ordinary API.
    bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap();
    let state = AppState::new(store.clone(), "x".repeat(32), "http://localhost".into())
        .unwrap()
        .with_execution_store(bound);
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, "localhost".parse().unwrap());
    headers.insert(
        header::COOKIE,
        format!("orkestr_v2_session={token}").parse().unwrap(),
    );
    let call = |state: AppState, headers: HeaderMap, id: String, query| {
        list(State(state), headers, Path(id), query)
    };
    let response = call(
        state.clone(),
        headers.clone(),
        conversation.to_string(),
        query(""),
    )
    .await
    .unwrap_or_else(|error| panic!("unexpected status {}", error.0));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let page: WorkerExecutionPage = serde_json::from_slice(&bytes).unwrap();
    assert!(page.is_valid());
    assert!(page.workers.is_empty()); // No fabricated Deep-as-Worker entry.
    for suffix in [
        "?limit=0",
        "?limit=101",
        "?limit=-1",
        "?limit=1&limit=2",
        "?after=no",
        "?after=00000000-0000-0000-0000-000000000000",
        "?owner=synthetic",
        "?after=00000000-0000-0000-0000-000000000001&after=00000000-0000-0000-0000-000000000002",
    ] {
        assert_eq!(
            call(
                state.clone(),
                headers.clone(),
                conversation.to_string(),
                query(suffix)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::BAD_REQUEST,
            "{suffix}"
        );
    }
    let mut wrong_host = headers.clone();
    wrong_host.insert(header::HOST, "foreign.invalid".parse().unwrap());
    assert_eq!(
        call(
            state.clone(),
            wrong_host,
            conversation.to_string(),
            query("")
        )
        .await
        .err()
        .unwrap()
        .0,
        StatusCode::FORBIDDEN
    );
    let mut bearer = headers.clone();
    bearer.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    assert_eq!(
        call(state.clone(), bearer, conversation.to_string(), query(""))
            .await
            .err()
            .unwrap()
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            state.clone(),
            headers.clone(),
            Uuid::new_v4().to_string(),
            query("")
        )
        .await
        .err()
        .unwrap()
        .0,
        StatusCode::NOT_FOUND
    );
    let unbound = AppState::new(store.clone(), "x".repeat(32), "http://localhost".into()).unwrap();
    assert_eq!(
        call(
            unbound,
            headers.clone(),
            conversation.to_string(),
            query("")
        )
        .await
        .err()
        .unwrap()
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    store
        .revoke_session(&format!("browser:{token}"))
        .await
        .unwrap();
    assert_eq!(
        call(state, headers, conversation.to_string(), query("?limit=0"))
            .await
            .err()
            .unwrap()
            .0,
        StatusCode::UNAUTHORIZED
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
