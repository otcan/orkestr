use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const V1_TOKEN: &str = "dddddddddddddddddddddddd";

fn group(id: &str) -> Value {
    json!({"id": id, "name": "Synthetic group", "lastActivityAt": "2026-01-01T00:00:00Z",
        "binding": {"connector": "whatsapp", "enabled": true, "chatId": "000@g.us",
            "remoteThreadId": "00000000-0000-4000-8000-000000000001", "remoteRuntimeEnabled": true}})
}
fn worker(id: &str, parent: Option<&str>, at: &str) -> Value {
    let mut value = json!({"id": id, "name": format!("Synthetic {id}"), "threadKind": "worker",
        "lastActivityAt": at});
    if let Some(parent) = parent {
        value["parentThreadId"] = json!(parent);
    }
    value
}

/// Synthetic V1 registry: a delegated group with a direct worker (working),
/// an encoded-id worker without `parentThreadId`, a nested worker, a retired
/// worker, a task agent, and another group with its own worker.
fn registry() -> Value {
    let mut working = worker(
        "worker-synthetic-group-0001",
        Some("synthetic-group"),
        "2026-01-03T00:00:00Z",
    );
    working["working"] = json!(true);
    let mut retired = worker(
        "worker-synthetic-group-0003",
        Some("synthetic-group"),
        "2026-01-05T00:00:00Z",
    );
    retired["retired"] = json!(true);
    json!({"threads": [
        group("synthetic-group"),
        working,
        worker("worker-synthetic-group-0002", None, "2026-01-04T00:00:00Z"),
        worker("worker-worker-synthetic-group-0001-0001", Some("worker-synthetic-group-0001"), "2026-01-02T00:00:00Z"),
        retired,
        {"id": "task-synthetic-group-1", "name": "Synthetic task", "threadKind": "task-agent", "parentThreadId": "synthetic-group"},
        group("synthetic-other"),
        worker("worker-synthetic-other-0001", Some("synthetic-other"), "2026-01-06T00:00:00Z"),
    ]})
}

fn threads() -> Vec<V1Thread> {
    sidebar_v1::parse_registry(&registry()).unwrap()
}
fn ids(found: &[Found<'_>]) -> Vec<(String, String, u32)> {
    found
        .iter()
        .map(|f| (f.thread.id.clone(), f.parent.clone(), f.depth))
        .collect()
}

#[test]
fn descendants_follow_parent_ids_and_encoded_worker_ids() {
    let threads = threads();
    let mut found = ids(&descendants(&threads, "synthetic-group"));
    found.sort();
    let entry = |id: &str, parent: &str, depth| (id.to_owned(), parent.to_owned(), depth);
    assert_eq!(
        found,
        vec![
            entry("worker-synthetic-group-0001", "synthetic-group", 1),
            entry("worker-synthetic-group-0002", "synthetic-group", 1),
            entry("worker-synthetic-group-0003", "synthetic-group", 1),
            entry(
                "worker-worker-synthetic-group-0001-0001",
                "worker-synthetic-group-0001",
                2
            ),
        ],
        "task agents and other groups' workers are not listed"
    );
    assert!(descendants(&threads, "synthetic-unknown").is_empty());
}

#[test]
fn descendants_stop_at_the_depth_bound_and_survive_cycles() {
    let mut chain = vec![group("synthetic-root")];
    let mut parent = "synthetic-root".to_owned();
    for level in 1..=V1_WORKERS_DEPTH + 2 {
        let id = format!("synthetic-level-{level}");
        chain.push(worker(&id, Some(&parent), "2026-01-01T00:00:00Z"));
        parent = id;
    }
    // A cycle back to an ancestor and one between two strangers.
    chain.push(worker(
        "synthetic-cycle-a",
        Some("synthetic-cycle-b"),
        "2026-01-01T00:00:00Z",
    ));
    chain.push(worker(
        "synthetic-cycle-b",
        Some("synthetic-cycle-a"),
        "2026-01-01T00:00:00Z",
    ));
    let threads = sidebar_v1::parse_registry(&json!({ "threads": chain })).unwrap();
    let found = descendants(&threads, "synthetic-root");
    assert_eq!(found.len(), V1_WORKERS_DEPTH as usize);
    assert_eq!(found.last().unwrap().depth, V1_WORKERS_DEPTH);
    assert_eq!(descendants(&threads, "synthetic-cycle-a").len(), 1);
}

fn context<'a>(
    linked: Option<&'a str>,
    imported: &'a HashMap<String, ConversationId>,
    previews: &'a HashMap<String, SidebarPreview>,
) -> Context<'a> {
    Context {
        conversation: ConversationId(Uuid::from_u128(9)),
        linked,
        status: SidebarV1Status::Ready,
        imported,
        previews,
        observed_at_ms: 1,
    }
}

#[test]
fn page_lists_active_workers_first_counts_retired_and_marks_openable() {
    let threads = threads();
    let conversation = ConversationId(Uuid::from_u128(9));
    let migrated = ConversationId(Uuid::from_u128(10));
    let imported = HashMap::from([
        ("synthetic-group".to_owned(), conversation),
        (
            "worker-worker-synthetic-group-0001-0001".to_owned(),
            migrated.clone(),
        ),
    ]);
    let previews = HashMap::from([(
        "worker-synthetic-group-0001".to_owned(),
        SidebarPreview {
            author: orkestr_v2_contracts::SidebarAuthor::Assistant,
            text: "Synthetic progress".into(),
        },
    )]);
    let page = page(
        &threads,
        context(Some("synthetic-group"), &imported, &previews),
    );
    assert!(page.is_valid());
    let order: Vec<(&str, V1WorkerState, bool)> = page
        .workers
        .iter()
        .map(|w| (w.thread_id.as_str(), w.state, w.openable))
        .collect();
    assert_eq!(
        order,
        vec![
            // Found by its encoded id; the sidebar lists only `parentThreadId`
            // children, so the history route would not open it.
            ("worker-synthetic-group-0002", V1WorkerState::Idle, false),
            ("worker-synthetic-group-0001", V1WorkerState::Working, true),
            (
                "worker-worker-synthetic-group-0001-0001",
                V1WorkerState::Idle,
                false
            ),
            ("worker-synthetic-group-0003", V1WorkerState::Retired, false),
        ]
    );
    assert_eq!(page.retired, 1);
    assert!(!page.truncated);
    assert_eq!(
        page.workers[1].preview.as_ref().unwrap().text,
        "Synthetic progress"
    );
    assert_eq!(page.workers[2].conversation_id, Some(migrated));
    // Not linked: nothing.
    let page = super::page(&threads, context(None, &imported, &previews));
    assert!(page.is_valid() && page.workers.is_empty() && page.v1_thread_id.is_none());
}

#[test]
fn page_is_bounded_and_cuts_retired_workers_first() {
    let mut many = vec![group("synthetic-root")];
    for n in 0..V1_WORKERS_MAX + 5 {
        let mut entry = worker(
            &format!("worker-synthetic-root-{n:04}"),
            Some("synthetic-root"),
            "2026-01-01T00:00:00Z",
        );
        entry["retired"] = json!(n % 2 == 0);
        many.push(entry);
    }
    let threads = sidebar_v1::parse_registry(&json!({ "threads": many })).unwrap();
    let (imported, previews) = (HashMap::new(), HashMap::new());
    let page = page(
        &threads,
        context(Some("synthetic-root"), &imported, &previews),
    );
    assert!(page.is_valid());
    assert!(page.truncated);
    assert_eq!(page.workers.len(), V1_WORKERS_MAX);
    let active = (V1_WORKERS_MAX + 5) / 2;
    assert!(page.workers[..active]
        .iter()
        .all(|w| w.state != V1WorkerState::Retired));
    assert_eq!(page.retired as usize, V1_WORKERS_MAX + 5 - active);
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
            // Only the registry exists: a message read would be a 404.
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

#[tokio::test]
async fn owner_reads_the_v1_workers_of_a_linked_conversation() {
    let mut case = case().await;
    let auth = case.auth();
    let path = case.path("/v1-workers");
    // Not linked to V1 yet: an empty page.
    let (status, page) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["v1_thread_id"], Value::Null);
    assert_eq!(page["workers"], json!([]));

    let import = json!({"source_instance": "synthetic-v1", "source_thread_id": "synthetic-group",
        "snapshot_id": "snapshot-workers", "messages": [{"source_message_id": "m1", "source_position": 1,
        "source_cursor": 1, "role": "user", "phase": null, "state": "delivered", "source_kind": null,
        "created_at": "2026-01-01T00:00:00.000Z", "updated_at": null, "text": "Synthetic start", "attachments": []}]});
    let (status, body) = send(
        &case.state,
        "POST",
        &case.path("/archived-history"),
        &[&auth],
        &import.to_string(),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    // Linked, but no V1 client: nothing is assumed.
    let (status, page) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["v1_thread_id"], "synthetic-group");
    assert_eq!(page["v1_status"], "unconfigured");
    assert_eq!(page["workers"], json!([]));

    case.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&fake_v1().await, V1_TOKEN.into()).unwrap(),
    ));
    let (status, page) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(status, 200, "{page}");
    let page: V1WorkersPage = serde_json::from_value(page).unwrap();
    assert!(page.is_valid());
    assert_eq!(page.v1_status, SidebarV1Status::Ready);
    assert_eq!(page.workers.len(), 4);
    assert_eq!(page.retired, 1);
    assert!(page
        .workers
        .iter()
        .all(|w| w.thread_id.starts_with("worker-") && w.preview.is_none()));

    let (status, _) = send(&case.state, "GET", &path, &[], "").await;
    assert_eq!(status, 401);
    let other = format!("/api/v2/conversations/{}/v1-workers", Uuid::from_u128(77));
    let (status, _) = send(&case.state, "GET", &other, &[&auth], "").await;
    assert_eq!(status, 404);
    let (status, _) = send(
        &case.state,
        "GET",
        "/api/v2/conversations/not-a-uuid/v1-workers",
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 400);
    case.finish().await;
}

#[test]
fn a_delegated_v1_binding_links_its_conversation() {
    let threads = threads();
    let remote = ConversationId(Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap());
    // Both synthetic groups delegate to the same id; the first listed wins.
    assert_eq!(delegated_thread(&threads, &remote), Some("synthetic-group"));
    let other = ConversationId(Uuid::from_u128(5));
    assert_eq!(delegated_thread(&threads, &other), None);
}
