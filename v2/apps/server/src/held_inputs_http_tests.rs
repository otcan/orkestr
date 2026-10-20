use super::*;
use orkestr_v2_application::IntakeStore;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[path = "held_inputs_http_tests/fixture.rs"]
pub(crate) mod fixture;
use fixture::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retired_scope_keeps_held_provenance_and_fresh_input_does_not_release_it() {
    let f = retired().await;
    let before = page(&f.state, &f.conversation).await;
    assert_eq!(before.held, f.expected.held);
    assert!(!before.eligible_input_available);
    let fresh = f
        .state
        .store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "fresh-after-stop".into(),
                text: "synthetic fresh intent".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let after = page(&f.state, &f.conversation).await;
    assert_eq!(after.held, before.held);
    assert!(after.eligible_input_available);
    assert!(fresh.sequence > before.held[0].through_scope_sequence);
    assert!(f
        .state
        .execution_scope(&f.owner, &f.conversation)
        .await
        .unwrap_or_else(|_| panic!("scope read refused"))
        .is_none());
    assert_eq!(
        f.state
            .store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap()
            .phase,
        ExecutionPhase::Cancelled
    );
    f.state.store.close().await;
}

#[tokio::test]
async fn held_route_retains_browser_auth_query_and_conversation_refusals() {
    let f = retired().await;
    let id = f.conversation.to_string();
    for (headers, expected) in [
        (headers(None, AUTHORITY), StatusCode::UNAUTHORIZED),
        (
            headers(Some(&"b".repeat(64)), AUTHORITY),
            StatusCode::UNAUTHORIZED,
        ),
        (
            headers(Some(COOKIE), "foreign.invalid"),
            StatusCode::FORBIDDEN,
        ),
        (
            {
                let mut h = headers(Some(COOKIE), AUTHORITY);
                h.insert(
                    "authorization",
                    "Bearer synthetic-machine-session".parse().unwrap(),
                );
                h
            },
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        assert_eq!(request(&f.state, &id, "", headers).await.status(), expected);
    }
    assert_eq!(
        request(
            &f.state,
            &Uuid::new_v4().to_string(),
            "",
            headers(Some(COOKIE), AUTHORITY)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    for query in [
        "?limit=0",
        "?limit=101",
        "?limit=1.5",
        "?limit=4294967296",
        "?after_sequence=-1",
        "?after_sequence=bad",
        "?unknown=1",
        "?after_sequence=0&after_sequence=1",
    ] {
        assert_eq!(
            request(&f.state, &id, query, headers(Some(COOKIE), AUTHORITY))
                .await
                .status(),
            StatusCode::BAD_REQUEST,
            "{query}"
        );
    }
    for id in ["invalid", "00000000-0000-0000-0000-000000000000"] {
        assert_eq!(
            request(&f.state, id, "", headers(Some(COOKIE), AUTHORITY))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    f.state
        .store
        .revoke_session(&format!("browser:{COOKIE}"))
        .await
        .unwrap();
    assert_eq!(
        request(&f.state, &id, "", headers(Some(COOKIE), AUTHORITY))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    f.state.store.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mounted_http_route_reads_after_original_scope_removed() {
    let f = retired().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::router(f.state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let id = f.conversation.to_string();
    let response = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        let mut connection = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
        connection.set_read_timeout(Some(Duration::from_secs(5)))?;
        connection.set_write_timeout(Some(Duration::from_secs(5)))?;
        write!(connection, "GET /api/v2/conversations/{id}/held-inputs HTTP/1.1\r\nHost: {AUTHORITY}\r\nCookie: orkestr_v2_session={COOKIE}\r\nConnection: close\r\n\r\n")?;
        let mut response = String::new();
        connection.read_to_string(&mut response)?;
        Ok(response)
    }).await;
    server.abort();
    let _ = server.await;
    let response = response.unwrap().unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    assert!(head.starts_with("HTTP/1.1 200 "), "{head}");
    let page: HeldOwnerInputPage = serde_json::from_str(body).unwrap();
    assert_eq!(page.held, f.expected.held);
    f.state.store.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retired_hold_reads_in_fresh_process_without_any_execution_handles() {
    let f = retired().await;
    // Only synthetic durable coordinates cross the exec boundary. The fresh
    // child cannot possess the original supervisor, registry or reap objects.
    std::fs::write(
        f.root.0.join("expected.json"),
        serde_json::to_vec(&f.expected).unwrap(),
    )
    .unwrap();
    f.state.store.close().await;
    drop(f.state);
    let filter = format!("{}::cold_child", module_path!().split_once("::").unwrap().1);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &filter, "--nocapture"])
        .env_clear()
        .env("HELD_BROWSER_COLD_ROOT", &f.root.0)
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "fresh held-read child failed");
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("fresh held-read child timed out");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn cold_child() {
    let Some(root) = std::env::var_os("HELD_BROWSER_COLD_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let expected: HeldOwnerInputPage =
        serde_json::from_slice(&std::fs::read(root.join("expected.json")).unwrap()).unwrap();
    let state = state(Store::open(&root.join("core.sqlite3")).await.unwrap());
    let owner = state
        .store
        .authenticate(&format!("browser:{COOKIE}"))
        .await
        .unwrap()
        .unwrap();
    assert!(state
        .execution_scope(&owner, &expected.conversation_id)
        .await
        .unwrap_or_else(|_| panic!("scope read refused"))
        .is_none());
    let result = page(&state, &expected.conversation_id).await;
    assert_eq!(result.held, expected.held);
    assert!(!result.eligible_input_available);
    let window = state
        .store
        .execution_window_status_authenticated(
            &format!("browser:{COOKIE}"),
            &expected.conversation_id,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(window.state, ExecutionWindowState::Closed);
    state.store.close().await;
}
