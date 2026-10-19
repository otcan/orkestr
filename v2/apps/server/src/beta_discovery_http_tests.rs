use super::*;
use axum::body::to_bytes;

#[tokio::test]
async fn discovery_requires_current_auth_and_explicit_trusted_configuration() {
    let root = std::env::temp_dir().join(format!("beta-discovery-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
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
    let state = AppState::new(
        store.clone(),
        "b".repeat(64),
        "http://127.0.0.1:19880".into(),
    )
    .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:19880".parse().unwrap());
    assert_eq!(
        read(State(state.clone()), headers.clone())
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    headers.insert(
        "cookie",
        format!("orkestr_v2_session={token}").parse().unwrap(),
    );
    let error = read(State(state.clone()), headers.clone())
        .await
        .unwrap_err();
    assert_eq!(
        (error.0, error.1),
        (StatusCode::NOT_FOUND, "beta_unconfigured")
    );
    let config = serde_json::from_value(serde_json::json!({
        "schema_version":1,"owner_id":owner,"conversation_id":conversation,
        "manager_socket":"/run/example/control.sock","launcher":"/opt/example/launcher",
        "launcher_sha256":"a".repeat(64),"workspace":"/srv/example",
        "namespace":"synthetic-beta","supervisor_key":"synthetic-supervisor"
    }))
    .unwrap();
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
    let parent: u32 = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let configured = state.with_beta_config(&config, &root, parent).unwrap();
    let mut foreign_config = config.clone();
    foreign_config.owner_id = OwnerId(Uuid::new_v4());
    let foreign = AppState::new(
        store.clone(),
        "b".repeat(64),
        "http://127.0.0.1:19880".into(),
    )
    .unwrap()
    .with_beta_config(&foreign_config, &root, parent)
    .unwrap();
    assert_eq!(
        read(State(foreign), headers.clone()).await.unwrap_err().0,
        StatusCode::FORBIDDEN
    );
    assert_mounted_route(configured.clone(), &token).await;
    let response = read(State(configured.clone()), headers.clone())
        .await
        .unwrap_or_else(|error| panic!("{}", error.1));
    assert_eq!(response.status(), StatusCode::OK);
    let body: BetaDiscovery =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(body.conversation_id, conversation);
    assert_eq!(body.limits, ExecutionWindowLimits::default());
    assert_eq!(
        body.controls,
        BetaControls {
            stop: false,
            steer: false,
            accept: false
        }
    );
    assert!(body.window.is_none());
    headers.insert("host", "foreign.invalid".parse().unwrap());
    assert_eq!(
        read(State(configured.clone()), headers.clone())
            .await
            .unwrap_err()
            .0,
        StatusCode::FORBIDDEN
    );
    headers.insert("host", "127.0.0.1:19880".parse().unwrap());
    store
        .revoke_session(&format!("browser:{token}"))
        .await
        .unwrap();
    assert_eq!(
        read(State(configured), headers).await.unwrap_err().0,
        StatusCode::UNAUTHORIZED
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

async fn assert_mounted_route(state: AppState, token: &str) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router(state))
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket.write_all(format!("GET /api/v2/beta HTTP/1.1\r\nHost: 127.0.0.1:19880\r\nCookie: orkestr_v2_session={token}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        socket.read_to_end(&mut bytes),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        bytes.starts_with(b"HTTP/1.1 200"),
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    stop.send(()).unwrap();
    server.await.unwrap();
}
