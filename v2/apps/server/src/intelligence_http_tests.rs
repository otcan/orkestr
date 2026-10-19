use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn get(state: AppState, path: &str, cookie: Option<&str>, host: &str) -> (u16, Vec<u8>) {
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
    let cookie = cookie.map_or(String::new(), |value| {
        format!("Cookie: orkestr_v2_session={value}\r\n")
    });
    socket
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{cookie}Connection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        socket.read_to_end(&mut bytes),
    )
    .await
    .unwrap()
    .unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
    let split = bytes
        .windows(4)
        .position(|value| value == b"\r\n\r\n")
        .unwrap();
    let status = std::str::from_utf8(&bytes[..split])
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, bytes[split + 4..].to_vec())
}

#[tokio::test]
async fn mounted_capabilities_keep_configuration_separate_from_live_role_authority() {
    let root = std::env::temp_dir().join(format!("intelligence-http-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-password-hash")
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
    let path = format!("/api/v2/conversations/{conversation}/intelligence");
    assert_eq!(
        get(state.clone(), &path, None, "127.0.0.1:19880").await.0,
        401
    );
    assert_eq!(
        get(state.clone(), &path, Some(&token), "foreign.invalid")
            .await
            .0,
        403
    );
    let (code, bytes) = get(state.clone(), &path, Some(&token), "127.0.0.1:19880").await;
    assert_eq!(code, 200);
    let unavailable: IntelligenceCapabilities = serde_json::from_slice(&bytes).unwrap();
    assert!(unavailable.is_valid());
    assert!(
        !unavailable.deep.configured
            && !unavailable.fast.configured
            && !unavailable.worker.configured
    );

    let role = |name: &str| {
        serde_json::json!({
            "launcher": format!("/opt/example/{name}"), "launcher_sha256": "a".repeat(64), "workspace":"/srv/example"
        })
    };
    let config = serde_json::from_value(serde_json::json!({
        "schema_version":1,"owner_id":owner,"conversation_id":conversation,
        "manager_socket":"/run/example/control.sock","launcher":"/opt/example/launcher",
        "launcher_sha256":"a".repeat(64),"workspace":"/srv/example",
        "namespace":"synthetic-beta","supervisor_key":"synthetic-supervisor",
        "roles":{"fast":role("fast"),"workers":[role("worker-0"),role("worker-1"),role("worker-2"),role("worker-3")]}
    })).unwrap();
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
    let configured = state
        .clone()
        .with_beta_config(&config, &root, parent)
        .unwrap();
    let (code, bytes) = get(configured.clone(), &path, Some(&token), "127.0.0.1:19880").await;
    assert_eq!(code, 200);
    let capabilities: IntelligenceCapabilities = serde_json::from_slice(&bytes).unwrap();
    assert!(capabilities.is_valid());
    assert_eq!(capabilities.conversation_id, conversation);
    assert!(
        capabilities.deep.configured
            && capabilities.fast.configured
            && capabilities.worker.configured
    );
    assert!(
        !capabilities.deep.available
            && !capabilities.fast.available
            && !capabilities.worker.available
    );
    assert_eq!(
        (
            capabilities.deep.max_parallel,
            capabilities.fast.max_parallel,
            capabilities.worker.max_parallel
        ),
        (1, 1, 4)
    );
    assert!(
        capabilities.worker.accept
            && capabilities.fast.accept
            && !capabilities.worker.steer
            && !capabilities.fast.steer
    );
    let unknown = format!("/api/v2/conversations/{}/intelligence", Uuid::new_v4());
    assert_eq!(
        get(
            configured.clone(),
            &unknown,
            Some(&token),
            "127.0.0.1:19880"
        )
        .await
        .0,
        404
    );
    assert_eq!(
        get(
            configured.clone(),
            "/api/v2/conversations/not-a-uuid/intelligence",
            Some(&token),
            "127.0.0.1:19880"
        )
        .await
        .0,
        400
    );
    assert!(store
        .execution_status(&owner, &conversation)
        .await
        .unwrap()
        .is_none());
    store
        .revoke_session(&format!("browser:{token}"))
        .await
        .unwrap();
    assert_eq!(
        get(configured, &path, Some(&token), "127.0.0.1:19880")
            .await
            .0,
        401
    );
    drop(state);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
