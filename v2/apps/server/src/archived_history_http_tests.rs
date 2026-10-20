use super::*;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HOST: &str = "127.0.0.1:19881";
const ORIGIN: &str = "http://127.0.0.1:19881";

struct Case {
    root: std::path::PathBuf,
    state: AppState,
    conversation: ConversationId,
    bearer: String,
    cookie: String,
}
async fn case() -> Case {
    let root = std::env::temp_dir().join(format!("archived-http-{}", Uuid::new_v4()));
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
    let bearer = "c".repeat(64);
    let cookie = "d".repeat(64);
    store.save_session(&bearer, &owner).await.unwrap();
    store
        .save_session(&format!("browser:{cookie}"), &owner)
        .await
        .unwrap();
    let state = AppState::new(store, "e".repeat(64), ORIGIN.into()).unwrap();
    Case {
        root,
        state,
        conversation,
        bearer,
        cookie,
    }
}
async fn send(
    state: &AppState,
    method: &str,
    path: &str,
    headers: &[&str],
    body: &str,
) -> (u16, Vec<u8>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = crate::router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", body.len());
    for header in headers {
        request.push_str(header);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.push_str(body);
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    socket.read_to_end(&mut response).await.unwrap();
    let _ = stop.send(());
    server.await.unwrap();
    let text = String::from_utf8_lossy(&response).to_string();
    let status = text[9..12].parse().unwrap();
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_owned())
        .unwrap_or_default();
    // Responses are small JSON documents; strip chunked framing if present.
    let body = if text
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        body.split("\r\n").skip(1).step_by(2).collect::<String>()
    } else {
        body
    };
    (status, body.into_bytes())
}
fn request(count: i64, filler: usize) -> ArchivedImportRequest {
    ArchivedImportRequest {
        source_instance: "synthetic-v1".into(),
        source_thread_id: "thread-http".into(),
        snapshot_id: "snapshot-http".into(),
        messages: (1..=count)
            .map(|p| ArchivedMessage {
                source_message_id: format!("m{p}"),
                source_position: p,
                source_cursor: p,
                role: if p % 2 == 1 { "user" } else { "assistant" }.into(),
                phase: None,
                state: Some("delivered".into()),
                source_kind: None,
                created_at: Some("2026-01-01T00:00:00.000Z".into()),
                updated_at: None,
                text: "s".repeat(filler),
                attachments: vec![],
            })
            .collect(),
    }
}

#[tokio::test]
async fn machine_import_beyond_default_limit_is_idempotent_and_readable() {
    let c = case().await;
    let bearer = format!("Authorization: Bearer {}", c.bearer);
    let path = format!("/api/v2/conversations/{}/archived-history", c.conversation);
    let body = serde_json::to_string(&request(4, 30 * 1024)).unwrap();
    assert!(body.len() > 40 * 1024);
    let (code, bytes) = send(&c.state, "POST", &path, &[bearer.as_str()], &body).await;
    assert_eq!(code, 200, "{}", String::from_utf8_lossy(&bytes));
    let receipt: ArchivedImportReceipt = serde_json::from_slice(&bytes).unwrap();
    assert_eq!((receipt.inserted, receipt.source.cursor), (4, 4));
    let (_, bytes) = send(&c.state, "POST", &path, &[bearer.as_str()], &body).await;
    let receipt: ArchivedImportReceipt = serde_json::from_slice(&bytes).unwrap();
    assert_eq!((receipt.inserted, receipt.duplicates), (0, 4));
    let (code, bytes) = send(
        &c.state,
        "GET",
        &format!("{path}/status"),
        &[bearer.as_str()],
        "",
    )
    .await;
    assert_eq!(code, 200);
    let status: ArchivedHistoryStatus = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status.sources[0].message_count, 4);
    let (code, bytes) = send(
        &c.state,
        "GET",
        &format!("{path}?after=1&limit=2"),
        &[bearer.as_str()],
        "",
    )
    .await;
    assert_eq!(code, 200);
    let page: ArchivedHistoryPage = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(page.entries.len(), 2);
    assert_eq!(page.entries[0].message.source_position, 2);
    assert_eq!(page.next_after, Some(3));
    c.state.store.close().await;
    std::fs::remove_dir_all(c.root).unwrap();
}

#[tokio::test]
async fn browser_writes_need_csrf_and_failures_are_closed() {
    let c = case().await;
    let path = format!("/api/v2/conversations/{}/archived-history", c.conversation);
    let body = serde_json::to_string(&request(2, 8)).unwrap();
    let cookie = format!("Cookie: orkestr_v2_session={}", c.cookie);
    let origin = format!("Origin: {ORIGIN}");
    let csrf = format!(
        "X-Orkestr-Csrf: {:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", c.cookie).as_bytes())
    );
    let (code, _) = send(
        &c.state,
        "POST",
        &path,
        &[cookie.as_str(), origin.as_str()],
        &body,
    )
    .await;
    assert_eq!(code, 403);
    let (code, _) = send(
        &c.state,
        "POST",
        &path,
        &[cookie.as_str(), origin.as_str(), csrf.as_str()],
        &body,
    )
    .await;
    assert_eq!(code, 200);
    let (code, _) = send(&c.state, "GET", &path, &[], "").await;
    assert_eq!(code, 401);
    let bearer = format!("Authorization: Bearer {}", c.bearer);
    let foreign = format!(
        "/api/v2/conversations/{}/archived-history/status",
        Uuid::new_v4()
    );
    assert_eq!(
        send(&c.state, "GET", &foreign, &[bearer.as_str()], "")
            .await
            .0,
        404
    );
    assert_eq!(
        send(
            &c.state,
            "POST",
            &path,
            &[bearer.as_str()],
            "{\"messages\":[]}"
        )
        .await
        .0,
        400
    );
    let mut unordered = request(2, 1);
    unordered.messages.reverse();
    let body = serde_json::to_string(&unordered).unwrap();
    assert_eq!(
        send(&c.state, "POST", &path, &[bearer.as_str()], &body)
            .await
            .0,
        400
    );
    assert_eq!(
        send(
            &c.state,
            "GET",
            &format!("{path}?limit=0"),
            &[bearer.as_str()],
            ""
        )
        .await
        .0,
        400
    );
    c.state.store.close().await;
    std::fs::remove_dir_all(c.root).unwrap();
}
