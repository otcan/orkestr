//! Actual HTTP against the leaf inside the canonical guard; synthetic Store only.
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
};
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::Store;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

async fn call(
    socket: &std::path::Path,
    token: &str,
    method: &str,
    path: &str,
    body: &[u8],
    extra: &str,
) -> (u16, Vec<u8>) {
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    let csrf = format!(
        "{:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{token}").as_bytes())
    );
    let headers = extra.replace("VALID_CSRF", &csrf);
    stream.write_all(format!("{method} /api/v2{path} HTTP/1.1\r\nHost: localhost\r\nCookie: orkestr_v2_session={token}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read_to_end(&mut bytes),
    )
    .await
    .unwrap()
    .unwrap();
    let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
    let headers = std::str::from_utf8(&bytes[..split])
        .unwrap()
        .to_ascii_lowercase();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    if status == 200 {
        assert!(headers.contains("cache-control: no-store"));
        assert!(headers.contains("x-content-type-options: nosniff"));
    }
    (status, bytes[split + 4..].to_vec())
}
const MUTATE: &str = "Origin: http://localhost\r\nx-orkestr-csrf: VALID_CSRF\r\n";

#[tokio::test]
async fn current_browser_policy_read_decision_replay_conflict_and_revoke() {
    let home = std::env::temp_dir().join(format!("automatic-policy-http-{}", Uuid::new_v4()));
    std::fs::create_dir(&home).unwrap();
    let store = Store::open(&home.join("store.sqlite3")).await.unwrap();
    let conversation = store.setup("synthetic", "hash").await.unwrap();
    let owner = store.credentials("synthetic").await.unwrap().unwrap().0;
    let machine = "ab".repeat(32);
    let cookie = "cd".repeat(32);
    let credential = format!("browser:{cookie}");
    store.save_session(&machine, &owner).await.unwrap();
    store.save_session(&credential, &owner).await.unwrap();
    let bound = store
        .authorize_supervisor(
            &machine,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-http-policy".into(),
                supervisor_key: "synthetic".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let state =
        crate::AppState::new(store.clone(), "ef".repeat(32), "http://localhost".into()).unwrap();
    let app = crate::router(state);
    let socket = home.join("http.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let path = format!("/conversations/{conversation}/automatic-reply-permissions");
    let (status, bytes) = call(&socket, &cookie, "GET", &path, b"", "").await;
    assert_eq!(status, 200);
    let empty: AutomaticReplyPermissionPage = serde_json::from_slice(&bytes).unwrap();
    assert!(empty.is_valid() && empty.routes.is_empty());
    let route = Uuid::new_v4();
    bound
        .bind_automatic_reply_route(&machine, &conversation, route, "synthetic-account", 0)
        .await
        .unwrap();
    let request = AutomaticReplyPermissionRequest {
        route_id: route,
        expected_route_generation: 1,
        expected_permission_revision: 0,
        request_key: "owner-intent".into(),
        enabled: true,
    };
    let body = serde_json::to_vec(&request).unwrap();
    assert_eq!(
        call(&socket, &cookie, "POST", &path, &body, "").await.0,
        403
    );
    assert_eq!(
        call(
            &socket,
            &cookie,
            "POST",
            &path,
            &body,
            "Origin: http://foreign.invalid\r\nx-orkestr-csrf: VALID_CSRF\r\n"
        )
        .await
        .0,
        403
    );
    let read = call(&socket, &cookie, "GET", &path, b"", "").await;
    let page: AutomaticReplyPermissionPage = serde_json::from_slice(&read.1).unwrap();
    assert!(!page.routes[0].enabled);
    assert_eq!(page.routes[0].permission_revision, 0);
    let first = call(&socket, &cookie, "POST", &path, &body, MUTATE).await;
    assert_eq!(first.0, 200);
    let receipt: AutomaticReplyPermissionReceipt = serde_json::from_slice(&first.1).unwrap();
    assert!(receipt.enabled);
    assert_eq!(receipt.permission_revision, 1);
    let replay = call(&socket, &cookie, "POST", &path, &body, MUTATE).await;
    assert_eq!(replay, first);
    let mut changed = request.clone();
    changed.enabled = false;
    assert_eq!(
        call(
            &socket,
            &cookie,
            "POST",
            &path,
            &serde_json::to_vec(&changed).unwrap(),
            MUTATE
        )
        .await
        .0,
        409
    );
    changed.request_key = "stale-new-key".into();
    assert_eq!(
        call(
            &socket,
            &cookie,
            "POST",
            &path,
            &serde_json::to_vec(&changed).unwrap(),
            MUTATE
        )
        .await
        .0,
        409
    );
    changed.route_id = Uuid::new_v4();
    assert_eq!(
        call(
            &socket,
            &cookie,
            "POST",
            &path,
            &serde_json::to_vec(&changed).unwrap(),
            MUTATE
        )
        .await
        .0,
        404
    );
    for query in [
        "limit=0",
        "limit=33",
        "limit=65536",
        "after_id=bad",
        "after_id=00000000-0000-0000-0000-000000000000",
        "unknown=1",
        "limit=1&limit=2",
    ] {
        assert_eq!(
            call(&socket, &cookie, "GET", &format!("{path}?{query}"), b"", "")
                .await
                .0,
            400
        );
    }
    assert_eq!(
        call(
            &socket,
            &cookie,
            "POST",
            &format!("{path}?limit=1"),
            &body,
            MUTATE
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &socket,
            &cookie,
            "POST",
            &path,
            br#"{"unexpected":1}"#,
            MUTATE
        )
        .await
        .0,
        400
    );
    assert_eq!(call(&socket, &machine, "GET", &path, b"", "").await.0, 401);
    assert_eq!(
        call(
            &socket,
            &cookie,
            "GET",
            &path,
            b"",
            &format!("Authorization: Bearer {machine}\r\n")
        )
        .await
        .0,
        401
    );
    let foreign = format!(
        "/conversations/{}/automatic-reply-permissions",
        Uuid::new_v4()
    );
    assert_eq!(
        call(&socket, &cookie, "GET", &foreign, b"", "").await.0,
        401
    );
    assert_eq!(
        call(&socket, &cookie, "POST", &foreign, &body, MUTATE)
            .await
            .0,
        401
    );
    // Trusted route replacement resets permission; exact historical replay is not current policy.
    bound
        .bind_automatic_reply_route(&machine, &conversation, route, "replacement-synthetic", 1)
        .await
        .unwrap();
    assert_eq!(
        call(&socket, &cookie, "POST", &path, &body, MUTATE).await,
        first
    );
    let read = call(&socket, &cookie, "GET", &path, b"", "").await;
    let page: AutomaticReplyPermissionPage = serde_json::from_slice(&read.1).unwrap();
    assert_eq!(page.routes[0].route_generation, 2);
    assert!(!page.routes[0].enabled);
    assert_eq!(page.routes[0].permission_revision, 2);
    let mut expected = vec![route];
    for _ in 0..2 {
        let id = Uuid::new_v4();
        bound
            .bind_automatic_reply_route(&machine, &conversation, id, "synthetic-paged", 0)
            .await
            .unwrap();
        expected.push(id);
    }
    expected.sort();
    let mut found = Vec::new();
    let mut after = None;
    loop {
        let query = after.map_or_else(
            || format!("{path}?limit=1"),
            |id| format!("{path}?limit=1&after_id={id}"),
        );
        let (status, bytes) = call(&socket, &cookie, "GET", &query, b"", "").await;
        assert_eq!(status, 200);
        let page: AutomaticReplyPermissionPage = serde_json::from_slice(&bytes).unwrap();
        assert!(page.is_valid());
        found.extend(page.routes.iter().map(|r| r.route_id));
        after = page.next_after;
        if after.is_none() {
            break;
        }
        assert!(found.len() < 4);
    }
    assert_eq!(found, expected);
    assert_eq!(
        call(&socket, &cookie, "POST", &path, &vec![b' '; 2049], MUTATE)
            .await
            .0,
        400
    );
    store.revoke_session(&credential).await.unwrap();
    assert_eq!(call(&socket, &cookie, "GET", &path, b"", "").await.0, 401);
    assert_eq!(
        call(&socket, &cookie, "POST", &path, &body, MUTATE).await.0,
        401
    );
    server.abort();
    let _ = server.await;
    bound.close().await;
    store.close().await;
    std::fs::remove_dir_all(home).unwrap();
}
