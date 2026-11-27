use super::*;

const HUMAN: &str = "browser:synthetic-human";

async fn fixture(name: &str) -> (AppState, Store, std::path::PathBuf) {
    let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    std::fs::create_dir_all(&home).unwrap();
    let path = home.join(format!("{name}-{}.sqlite3", Uuid::new_v4()));
    let store = Store::open(&path).await.unwrap();
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
    store.save_session(HUMAN, &owner).await.unwrap();
    let state = AppState::new(
        store.clone(),
        "synthetic-bootstrap-service-limits-only".into(),
        "http://127.0.0.1:47110".into(),
    )
    .unwrap();
    (state, store, path)
}

/// A stored credential (id, token) for one synthetic consumer.
async fn credential(store: &Store, index: usize) -> (String, String) {
    let token = format!("{index:064x}");
    let id = store
        .create_service_credential(
            HUMAN,
            "synthetic-hash",
            &format!("consumer {index}"),
            &token,
        )
        .await
        .unwrap()
        .unwrap();
    (id, token)
}

async fn exchanged(
    state: &AppState,
    token: &str,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    let input = Json(Exchange {
        service_token: token.into(),
    });
    match exchange(
        State(state.clone()),
        Peer::default(),
        HeaderMap::new(),
        input,
    )
    .await
    {
        Ok(response) => Ok(response.status()),
        Err(error) => Err((error.0, error.1)),
    }
}

const LIMITED: (StatusCode, &str) = (StatusCode::TOO_MANY_REQUESTS, "rate_limited");
const REFUSED: (StatusCode, &str) = (StatusCode::UNAUTHORIZED, "unauthorized");

#[tokio::test]
async fn renewing_many_service_credentials_is_not_rate_limited() {
    let (state, store, path) = fixture("service-limits-renewal").await;
    // More consumers than the former server-wide ten attempts a minute, each
    // exchanged twice in a burst.
    let mut tokens = Vec::new();
    for index in 0..12 {
        tokens.push(credential(&store, index).await.1);
    }
    for token in tokens.iter().chain(&tokens) {
        assert_eq!(exchanged(&state, token).await, Ok(StatusCode::OK));
    }
    store.close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn a_revoked_or_unknown_key_locks_out_only_itself() {
    let (state, store, path) = fixture("service-limits-revoked").await;
    let (revoked, stale) = credential(&store, 1).await;
    let (_, live) = credential(&store, 2).await;
    assert!(store
        .revoke_service_credential(HUMAN, &revoked)
        .await
        .unwrap());
    // A consumer still on its revoked key keeps failing, then is limited.
    for _ in 0..10 {
        assert_eq!(exchanged(&state, &stale).await, Err(REFUSED));
    }
    assert_eq!(exchanged(&state, &stale).await, Err(LIMITED));
    assert_eq!(exchanged(&state, &live).await, Ok(StatusCode::OK));
    // Tokens no credential has count against their source.
    for index in 0..30 {
        let unknown = format!("{:064x}", 1000 + index);
        assert_eq!(exchanged(&state, &unknown).await, Err(REFUSED));
    }
    assert_eq!(exchanged(&state, &"f".repeat(64)).await, Err(LIMITED));
    assert_eq!(exchanged(&state, "malformed").await, Err(LIMITED));
    // Known credentials are not behind that source's failures.
    assert_eq!(exchanged(&state, &live).await, Ok(StatusCode::OK));
    store.close().await;
    std::fs::remove_file(path).unwrap();
}
