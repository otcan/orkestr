use super::*;
#[path = "message_provider_generation_http_tests.rs"]
mod message_provider_generation_tests;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HOST: &str = "127.0.0.1:19882";
const ORIGIN: &str = "http://127.0.0.1:19882";

pub(crate) struct Case {
    pub root: std::path::PathBuf,
    pub state: AppState,
    pub conversation: ConversationId,
    pub bearer: String,
    pub cookie: String,
}
pub(crate) async fn case() -> Case {
    let root = std::env::temp_dir().join(format!("resources-http-{}", Uuid::new_v4()));
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
impl Case {
    pub fn auth(&self) -> String {
        format!("Authorization: Bearer {}", self.bearer)
    }
    pub fn path(&self, rest: &str) -> String {
        format!("/api/v2/conversations/{}{rest}", self.conversation)
    }
    pub async fn finish(self) {
        self.state.store.close().await;
        let _ = std::fs::remove_dir_all(self.root);
    }
}

pub(crate) async fn send(
    state: &AppState,
    method: &str,
    path: &str,
    headers: &[&str],
    body: &str,
) -> (u16, serde_json::Value) {
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
    crate::desktop_broker::parse_response(&response).unwrap()
}

#[tokio::test]
async fn settings_round_trip_render_and_auth() {
    let mut case = case().await;
    let auth = case.auth();
    // Without an installed Claude path, selecting Claude is refused (V1 switch).
    let claude =
        serde_json::json!({"expected_revision":0,"provider":"claude","honor_no_reply":true});
    let path = case.path("/settings");
    let (status, value) = send(&case.state, "PUT", &path, &[&auth], &claude.to_string()).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("provider_unavailable"))
    );
    case.state = case.state.clone().with_claude_turns();
    let (status, value) = send(&case.state, "GET", &case.path("/settings"), &[&auth], "").await;
    assert_eq!(
        (
            status,
            value["revision"].as_i64(),
            value["provider"].as_str()
        ),
        (200, Some(0), Some("codex"))
    );
    let update = serde_json::json!({"expected_revision":0,"provider":"claude","model":"claude-opus-4.1",
        "reasoning_effort":"high","honor_no_reply":true,"reply_prefix":"orkestr:","reply_footer":"-- v2"});
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/settings"),
        &[&auth],
        &update.to_string(),
    )
    .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(
        (
            value["revision"].as_i64(),
            value["provider_generation"].as_i64()
        ),
        (Some(1), Some(1))
    );
    // Stale revision with different content.
    let mut stale = update.clone();
    stale["reply_footer"] = serde_json::json!("other");
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/settings"),
        &[&auth],
        &stale.to_string(),
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("settings_revision_mismatch"))
    );
    // Unknown fields and wrong efforts are refused.
    let (status, _) = send(
        &case.state,
        "PUT",
        &case.path("/settings"),
        &[&auth],
        r#"{"expected_revision":1,"provider":"codex","honor_no_reply":true,"sandbox":"off"}"#,
    )
    .await;
    assert_eq!(status, 400);
    for (text, expected) in [
        (
            "  NO_REPLY\n",
            serde_json::json!({"settings_revision":1,"outcome":"suppressed","reason":"no_reply"}),
        ),
        (
            "hi",
            serde_json::json!({"settings_revision":1,"outcome":"deliver","text":"orkestr: hi\n\n-- v2"}),
        ),
    ] {
        let body = serde_json::json!({ "text": text }).to_string();
        let (status, value) = send(
            &case.state,
            "POST",
            &case.path("/settings/render"),
            &[&auth],
            &body,
        )
        .await;
        assert_eq!((status, value), (200, expected));
    }
    // Browser writes need CSRF; machine bearer cannot carry Origin.
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let (status, _) = send(
        &case.state,
        "PUT",
        &case.path("/settings"),
        &[&cookie, &format!("Origin: {ORIGIN}")],
        &update.to_string(),
    )
    .await;
    assert_eq!(status, 403);
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/settings"),
        &[&auth, &format!("Origin: {ORIGIN}")],
        "",
    )
    .await;
    assert_eq!(status, 403);
    let (status, _) = send(&case.state, "GET", &case.path("/settings"), &[], "").await;
    assert_eq!(status, 401);
    let other = format!("/api/v2/conversations/{}/settings", Uuid::new_v4());
    let (status, _) = send(&case.state, "GET", &other, &[&auth], "").await;
    assert_eq!(status, 404);
    case.finish().await;
}

#[tokio::test]
async fn legacy_workers_register_list_and_transition() {
    let case = case().await;
    let auth = case.auth();
    let worker = |state: &str| {
        serde_json::json!({
        "source_thread_id":"worker-p-1","source_parent_thread_id":"p","worker_index":1,
        "title":"Parent / Worker 1","source_state":state,"branch":"orkestr/p/w1",
        "worktree_path":"/srv/example/worktrees/p/worker-p-1"})
    };
    let register = |state: &str, snapshot: &str| {
        serde_json::json!({
        "source_instance":"orkestr-v1","snapshot_id":snapshot,"workers":[worker(state)]})
        .to_string()
    };
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/legacy-workers"),
        &[&auth],
        &register("active", "s1"),
    )
    .await;
    assert_eq!(
        (status, value["items"][0]["outcome"].as_str()),
        (200, Some("inserted")),
        "{value}"
    );
    let step = |revision: i64, action: serde_json::Value| {
        let mut body = serde_json::json!({"source_instance":"orkestr-v1","source_thread_id":"worker-p-1","expected_revision":revision});
        body.as_object_mut()
            .unwrap()
            .extend(action.as_object().unwrap().clone());
        body.to_string()
    };
    let claim = step(1, serde_json::json!({"action":"claim_v2_worktree"}));
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/legacy-workers/transition"),
        &[&auth],
        &claim,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("worktree_not_released"))
    );
    send(
        &case.state,
        "POST",
        &case.path("/legacy-workers"),
        &[&auth],
        &register("retired", "s2"),
    )
    .await;
    for (revision, action) in [(2, "release_v1_worktree"), (3, "claim_v2_worktree")] {
        let body = step(revision, serde_json::json!({ "action": action }));
        let (status, value) = send(
            &case.state,
            "POST",
            &case.path("/legacy-workers/transition"),
            &[&auth],
            &body,
        )
        .await;
        assert_eq!(status, 200, "{action}: {value}");
    }
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/legacy-workers"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200);
    let link = &value["workers"][0];
    assert_eq!(
        (
            link["worktree_writer"].as_str(),
            link["disposition"].as_str(),
            link["revision"].as_i64()
        ),
        (Some("v2"), Some("archived"), Some(4))
    );
    let bad = step(4, serde_json::json!({"action":"force_claim"}));
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/legacy-workers/transition"),
        &[&auth],
        &bad,
    )
    .await;
    assert_eq!(status, 400);
    case.finish().await;
}
