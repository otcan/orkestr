use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const V1_TOKEN: &str = "cccccccccccccccccccccccc";
const INSTANCE: &str = "ins_AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_INSTANCE: &str = "ins_BBBBBBBBBBBBBBBBBBBBBA";
const GROUP_REF: &str = "thr_AAAAAAAAAAAAAAAAAAAAAQ";
const WORKER_REF: &str = "thr_AAAAAAAAAAAAAAAAAAAAAg";
const MIGRATED_REF: &str = "thr_AAAAAAAAAAAAAAAAAAAAAw";
const RETIRED_REF: &str = "thr_AAAAAAAAAAAAAAAAAAAABA";
const UNKNOWN_REF: &str = "thr_AAAAAAAAAAAAAAAAAAAABQ";

fn with_ref(mut thread: Value, reference: &str) -> Value {
    thread["publicRef"] = json!(reference);
    thread["canonicalPath"] = json!(format!("/instance/{INSTANCE}/thread/{reference}"));
    thread
}
fn group(id: &str) -> Value {
    json!({"id": id, "name": "Synthetic group", "lastActivityAt": "2026-01-01T00:00:00Z",
        "binding": {"connector": "whatsapp", "enabled": true, "chatId": "000@g.us"}})
}
/// Synthetic V1 registry: a group, its worker, a migrated group and a
/// retired group, each with a synthetic public reference.
fn registry() -> Value {
    json!({"threads": [
        with_ref(group("synthetic-group"), GROUP_REF),
        with_ref(json!({"id": "worker-synthetic-group-0001", "name": "Synthetic worker", "threadKind": "worker",
            "parentThreadId": "synthetic-group"}), WORKER_REF),
        with_ref(group("synthetic-migrated"), MIGRATED_REF),
        with_ref(json!({"id": "synthetic-retired", "name": "Synthetic retired", "retired": true,
            "binding": {"connector": "whatsapp", "enabled": true, "chatId": "001@g.us"}}), RETIRED_REF),
    ]})
}

async fn fake_v1() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
            }
            let head = String::from_utf8_lossy(&raw).to_string();
            let path = head.split(' ').nth(1).unwrap_or_default().to_owned();
            let auth = head
                .lines()
                .any(|l| l == format!("Authorization: Bearer {V1_TOKEN}"));
            let (status, body) = if auth && path.starts_with("/api/threads/summary") {
                (200, registry())
            } else {
                (404, json!({}))
            };
            let text = body.to_string();
            let response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    format!("http://{address}")
}

#[test]
fn targets_prefer_the_migrated_conversation() {
    let threads = sidebar_v1::parse_registry(&registry()).unwrap();
    assert_eq!(threads[0].public_ref.as_deref(), Some(GROUP_REF));
    assert_eq!(threads[0].instance_ref.as_deref(), Some(INSTANCE));
    let migrated = ConversationId(Uuid::from_u128(7));
    let conversations = HashMap::from([("synthetic-migrated".to_string(), migrated.clone())]);
    assert_eq!(
        target(&threads, &conversations, MIGRATED_REF, Some(INSTANCE)),
        Some(V1LinkTarget::Conversation {
            conversation_id: migrated.clone()
        })
    );
    assert_eq!(
        target(&threads, &conversations, GROUP_REF, None),
        Some(V1LinkTarget::V1Thread {
            thread_id: "synthetic-group".into()
        })
    );
    assert_eq!(
        target(&threads, &conversations, WORKER_REF, Some(INSTANCE)),
        Some(V1LinkTarget::V1Thread {
            thread_id: "worker-synthetic-group-0001".into()
        })
    );
    // Another instance, a retired thread or an unknown reference: nothing.
    assert_eq!(
        target(&threads, &conversations, GROUP_REF, Some(OTHER_INSTANCE)),
        None
    );
    assert_eq!(target(&threads, &conversations, RETIRED_REF, None), None);
    assert_eq!(target(&threads, &conversations, UNKNOWN_REF, None), None);
}

#[tokio::test]
async fn old_v1_links_redirect_and_resolve_for_the_owner() {
    let mut case = case().await;
    let auth = case.auth();
    // The page route only redirects to a UI fragment, without authentication.
    let response = redirect(Path((INSTANCE.to_owned(), GROUP_REF.to_owned()))).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        response.headers()[header::LOCATION],
        format!("/#v1-link/{INSTANCE}/{GROUP_REF}").as_str()
    );
    for (instance, thread) in [(INSTANCE, "thr_short"), ("ins_x", GROUP_REF)] {
        let response = redirect(Path((instance.to_owned(), thread.to_owned()))).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    let (status, _) = send(
        &case.state,
        "GET",
        &format!("/instance/{INSTANCE}/thread/{GROUP_REF}"),
        &[],
        "",
    )
    .await;
    assert_eq!(status, 303, "the route is mounted");

    let path = |reference: &str| format!("/api/v2/v1-links/{reference}?instance={INSTANCE}");
    // Without the V1 client nothing resolves.
    let (status, _) = send(&case.state, "GET", &path(GROUP_REF), &[&auth], "").await;
    assert_eq!(status, 404);
    let url = fake_v1().await;
    case.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let (status, found) = send(&case.state, "GET", &path(GROUP_REF), &[&auth], "").await;
    assert_eq!(status, 200, "{found}");
    assert_eq!(
        found,
        json!({"kind": "v1_thread", "thread_id": "synthetic-group"})
    );
    for missing in [RETIRED_REF, UNKNOWN_REF, "thr_bad"] {
        let (status, _) = send(&case.state, "GET", &path(missing), &[&auth], "").await;
        assert_eq!(status, 404, "{missing}");
    }
    let (status, _) = send(&case.state, "GET", &path(GROUP_REF), &[], "").await;
    assert_eq!(status, 401);
    case.finish().await;
}
