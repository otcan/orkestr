use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const V1_TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";

fn thread(id: &str, name: &str, at: &str) -> Value {
    json!({"id": id, "name": name, "lastActivityAt": at, "lastMessageAt": at,
        "lastMessageCursor": 7, "lastMessageRole": "assistant", "lastMessageId": format!("{id}-last"),
        "binding": {"connector": "whatsapp", "enabled": true, "chatId": "000@g.us"}})
}
fn worker(id: &str, parent: &str, name: &str, at: &str) -> Value {
    json!({"id": id, "name": name, "threadKind": "worker", "parentThreadId": parent,
        "lastActivityAt": at, "lastMessageCursor": 3, "lastMessageRole": "user", "lastMessageId": format!("{id}-last")})
}
/// Synthetic V1 registry: two groups, a worker sub-thread, a retired worker,
/// a task agent, an unbound thread and a group already imported into V2.
fn registry() -> Value {
    json!({"threads": [
        thread("group-coordinated", "Synthetic coordinated group", "2026-01-03T00:00:00Z"),
        thread("group-quiet", "Synthetic quiet group", "2026-01-01T00:00:00Z"),
        worker("worker-group-coordinated-0001", "group-coordinated", "Synthetic coordinated group / Worker 1", "2026-01-04T00:00:00Z"),
        {"id": "retired-worker", "name": "Synthetic retired", "threadKind": "worker", "parentThreadId": "group-quiet", "retired": true},
        {"id": "task-group-quiet-1", "name": "Synthetic task", "threadKind": "task-agent", "parentThreadId": "group-quiet"},
        {"id": "unbound", "name": "Synthetic unbound"},
        thread("group-imported", "Synthetic imported group", "2026-01-05T00:00:00Z"),
        worker("imported-worker", "group-quiet", "Synthetic imported worker", "2026-01-02T00:00:00Z"),
    ]})
}

fn row(name: &str, at: Option<&str>) -> SidebarConversation {
    SidebarConversation {
        conversation_id: ConversationId(Uuid::new_v4()),
        name: name.into(),
        sequence: 4,
        last_event_at: at.map(str::to_owned),
        last_archived_at: None,
        unread: 2,
        preview: Some((
            SidebarAuthor::Assistant,
            "[WhatsApp: x]\n\nSynthetic   reply".into(),
        )),
        source_thread_id: None,
        lineage: None,
    }
}
fn native(row: SidebarConversation) -> Native {
    Native {
        row,
        activity: SidebarActivity::default(),
    }
}
fn by_key<'a>(page: &'a SidebarPage, key: &str) -> &'a SidebarEntry {
    page.entries.iter().find(|e| e.key == key).unwrap()
}

#[test]
fn composes_activity_order_linked_v1_threads_and_sub_chats() {
    let threads = sidebar_v1::parse_registry(&registry()).unwrap();
    let plain = row("Synthetic native", Some("2026-01-02T12:00:00.000Z"));
    let mut imported = row("Synthetic imported group", None);
    imported.source_thread_id = Some("group-imported".into());
    imported.last_archived_at = Some("2026-01-05T00:00:00.000Z".into());
    // Imported V1 worker whose durable parent link was recorded.
    let mut sub = row(
        "Synthetic imported worker",
        Some("2026-01-06T00:00:00.000Z"),
    );
    sub.source_thread_id = Some("imported-worker".into());
    sub.lineage = Some(ConversationLineage {
        source_instance: "synthetic-v1".into(),
        source_thread_id: "imported-worker".into(),
        source_parent_thread_id: Some("group-quiet".into()),
    });
    let (plain_key, imported_key, sub_key) = (
        format!("v2:{}", plain.conversation_id),
        format!("v2:{}", imported.conversation_id),
        format!("v2:{}", sub.conversation_id),
    );
    let marks = BTreeMap::from([("group-coordinated".to_string(), 5_i64)]);
    let previews = HashMap::from([(
        "group-coordinated".to_string(),
        SidebarPreview {
            author: SidebarAuthor::Assistant,
            text: "Synthetic V1 reply".into(),
        },
    )]);
    let coordinator = HashSet::from(["group-coordinated".to_string()]);
    let page = compose(
        vec![native(plain), native(imported), native(sub)],
        LinkedSource::Registry(&threads),
        &marks,
        &previews,
        &coordinator,
        SidebarV1Status::Ready,
        false,
        1,
    );
    assert!(page.is_valid());
    let keys: Vec<&str> = page.entries.iter().map(|e| e.key.as_str()).collect();
    // Newest activity first; the imported group appears once, as V2.
    assert_eq!(
        keys,
        vec![
            sub_key.as_str(),
            imported_key.as_str(),
            "v1:worker-group-coordinated-0001",
            "v1:group-coordinated",
            plain_key.as_str(),
            "v1:group-quiet",
        ]
    );
    let linked = by_key(&page, "v1:group-coordinated");
    assert!(linked.read_only && linked.coordinator);
    assert_eq!(linked.unread, 1, "V1 reply after the read mark");
    assert_eq!(linked.read_marker, 7);
    assert_eq!(linked.preview.as_ref().unwrap().text, "Synthetic V1 reply");
    assert_eq!(
        by_key(&page, "v1:worker-group-coordinated-0001")
            .parent_key
            .as_deref(),
        Some("v1:group-coordinated")
    );
    // The imported sub-thread stays under its (still V1) parent.
    assert_eq!(
        by_key(&page, &sub_key).parent_key.as_deref(),
        Some("v1:group-quiet")
    );
    let quiet = by_key(&page, "v1:group-quiet");
    assert!(!quiet.coordinator);
    assert_eq!(quiet.unread, 0, "no mark yet: never viewed is not unread");
    let plain = by_key(&page, &plain_key);
    assert_eq!(plain.preview.as_ref().unwrap().text, "Synthetic reply");
    assert_eq!(plain.unread, 2);
    assert!(!plain.read_only);
    for hidden in [
        "v1:retired-worker",
        "v1:task-group-quiet-1",
        "v1:unbound",
        "v1:group-imported",
    ] {
        assert!(!keys.contains(&hidden), "{hidden}");
    }
}

#[test]
fn registry_fills_a_parent_link_not_yet_recorded_and_parents_may_be_native() {
    let threads = sidebar_v1::parse_registry(&registry()).unwrap();
    let mut parent = row("Synthetic quiet group", Some("2026-01-01T00:00:00Z"));
    parent.source_thread_id = Some("group-quiet".into());
    let mut child = row("Synthetic imported worker", Some("2026-01-02T00:00:00Z"));
    child.source_thread_id = Some("imported-worker".into());
    let parent_key = format!("v2:{}", parent.conversation_id);
    let child_key = format!("v2:{}", child.conversation_id);
    let page = compose(
        vec![native(parent), native(child)],
        LinkedSource::Registry(&threads),
        &BTreeMap::new(),
        &HashMap::new(),
        &HashSet::new(),
        SidebarV1Status::Ready,
        false,
        1,
    );
    assert_eq!(
        by_key(&page, &child_key).parent_key.as_deref(),
        Some(parent_key.as_str())
    );
    assert!(!page.entries.iter().any(|e| e.key == "v1:group-quiet"));
}

#[test]
fn live_map_alone_lists_views_with_encoded_parents_and_coordinators() {
    let session = |live: bool, at: Option<i64>| LiveSession {
        session_id: "session".into(),
        kind: "claude-code".into(),
        role: "attached".into(),
        live,
        last_activity_ms: at,
        agents: vec![],
    };
    let view = |id: &str, name: &str, sessions: Vec<LiveSession>| LiveView {
        view: "whatsapp-group".into(),
        name: Some(name.into()),
        chat_id: None,
        thread_id: Some(id.into()),
        fast_layer: None,
        delegated_to_v2: None,
        sessions,
    };
    let views = vec![
        view(
            "parent-1",
            "Synthetic parent",
            vec![session(true, Some(50))],
        ),
        view(
            "worker-parent-1-abcd",
            "Synthetic parent / Worker 1",
            vec![session(false, Some(80))],
        ),
        view("solo", "Synthetic solo", vec![]),
    ];
    let page = compose(
        vec![],
        LinkedSource::Map(&views),
        &BTreeMap::new(),
        &HashMap::new(),
        &coordinators(&views),
        SidebarV1Status::MapOnly,
        false,
        1,
    );
    assert!(page.is_valid());
    assert_eq!(page.entries[0].key, "v1:worker-parent-1-abcd");
    assert_eq!(page.entries[0].parent_key.as_deref(), Some("v1:parent-1"));
    assert!(by_key(&page, "v1:parent-1").coordinator);
    assert!(!by_key(&page, "v1:solo").coordinator);
    assert_eq!(page.entries.last().unwrap().key, "v1:solo");
}

#[test]
fn activity_comes_from_window_and_run_states() {
    let role = |phase| LiveRole {
        run_id: None,
        phase,
        observed_at_ms: 1,
    };
    let worker = |state| LiveWorker {
        run_id: RunId(Uuid::new_v4()),
        session_id: SessionId(Uuid::new_v4()),
        parent_run_id: RunId(Uuid::new_v4()),
        state,
        recovery: WorkerRecoveryDisposition::CurrentIncarnation,
    };
    let window = |state| LiveWindow {
        window_id: Uuid::new_v4(),
        generation: 1,
        state,
        opened_at_ms: 1,
        work_deadline_ms: 2,
        expires_at_ms: 3,
    };
    let mut live = LiveConversation {
        conversation_id: ConversationId(Uuid::new_v4()),
        name: "Synthetic".into(),
        window: Some(window(ExecutionWindowState::Active)),
        fast: Some(role(ExecutionPhase::Running)),
        deep: Some(role(ExecutionPhase::Completed)),
        workers: vec![
            worker(RunState::Running),
            worker(RunState::Succeeded),
            worker(RunState::Starting),
        ],
        partial: false,
    };
    assert_eq!(
        activity(&live),
        SidebarActivity {
            fast: true,
            deep: false,
            workers: 2
        }
    );
    live.fast = Some(role(ExecutionPhase::AwaitingAcceptance));
    live.workers.clear();
    assert!(!activity(&live).active());
    live.window = Some(window(ExecutionWindowState::Opening));
    assert!(activity(&live).deep);
}

#[test]
fn previews_are_one_bounded_line_without_connector_headers() {
    assert_eq!(
        sidebar_v1::preview_text("[WhatsApp: group]\n\n  First   line \nsecond"),
        "First line"
    );
    let long = "x".repeat(400);
    let text = sidebar_v1::preview_text(&long);
    assert_eq!(text.chars().count(), SIDEBAR_PREVIEW_MAX);
    assert!(text.ends_with('…'));
    assert!(sidebar_v1::preview(SidebarAuthor::Owner, "\n \n").is_none());
}

/// Synthetic V1 loopback API: the registry and per-thread messages.
async fn fake_v1(calls: StdArc<StdMutex<Vec<String>>>) -> String {
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
            calls.lock().unwrap().push(path.clone());
            let (status, body) = if !auth {
                (401, json!({}))
            } else if path.starts_with("/api/threads/summary") {
                (200, registry())
            } else if path.starts_with("/api/threads/group-coordinated/messages") {
                (
                    200,
                    json!({"currentCursor": 7, "hasMoreBefore": true, "messages": [
                        {"id": "m6", "role": "user", "text": "Synthetic question", "cursor": "6", "createdAt": "2026-01-03T00:00:00Z"},
                        {"id": "m7", "role": "assistant", "text": "Synthetic answer", "cursor": 7, "phase": "final_answer", "createdAt": "2026-01-03T00:00:01Z"},
                        {"id": "m5", "role": "user", "text": "Synthetic member note", "cursor": 5, "senderEffectiveRole": "member"},
                    ]}),
                )
            } else if path.contains("/messages") {
                (200, json!({"messages": []}))
            } else {
                (404, json!({"error": "not_found"}))
            };
            let text = body.to_string();
            let response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    format!("http://{address}")
}

#[tokio::test]
async fn sidebar_lists_linked_v1_threads_reads_history_and_keeps_marks() {
    let mut case = case().await;
    let auth = case.auth();
    // Without a V1 client or live map only native conversations are listed.
    let (status, page) = send(&case.state, "GET", "/api/v2/sidebar", &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(page["v1_status"], "unconfigured");
    assert_eq!(page["entries"].as_array().unwrap().len(), 1);
    let (status, _) = send(
        &case.state,
        "GET",
        "/api/v2/v1-threads/group-coordinated/messages",
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 404);

    let calls = StdArc::new(StdMutex::new(Vec::new()));
    let url = fake_v1(calls.clone()).await;
    case.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let map = case.root.join("map.json");
    std::fs::write(
        &map,
        json!({"generatedAt": "2026-01-03T00:00:00Z", "views": [{"view": "whatsapp-group",
            "name": "Synthetic coordinated group", "threadId": "group-coordinated",
            "sessions": [{"sessionId": "synthetic-session", "kind": "claude-code", "role": "attached",
            "live": true, "transcript": "/synthetic/never-shown.jsonl"}]}]})
        .to_string(),
    )
    .unwrap();
    case.state = case.state.clone().with_live_map_file(&map).unwrap();
    let (status, page) = send(&case.state, "GET", "/api/v2/sidebar", &[&auth], "").await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["v1_status"], "ready");
    let text = page.to_string();
    assert!(!text.contains("never-shown"));
    let page: SidebarPage = serde_json::from_value(page).unwrap();
    assert!(page.is_valid());
    let group = by_key(&page, "v1:group-coordinated");
    assert!(group.coordinator && group.read_only);
    assert_eq!(group.preview.as_ref().unwrap().text, "Synthetic answer");
    assert_eq!(
        group.preview.as_ref().unwrap().author,
        SidebarAuthor::Assistant
    );
    // Registry reads are cached; preview reads are bounded per request.
    let registry_reads = |calls: &StdArc<StdMutex<Vec<String>>>| {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.starts_with("/api/threads/summary"))
            .count()
    };
    let _ = send(&case.state, "GET", "/api/v2/sidebar", &[&auth], "").await;
    assert_eq!(registry_reads(&calls), 1);

    // Read-only recent history of a listed thread; never of others.
    let (status, history) = send(
        &case.state,
        "GET",
        "/api/v2/v1-threads/group-coordinated/messages",
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200, "{history}");
    let history: V1HistoryPage = serde_json::from_value(history).unwrap();
    assert!(history.is_valid() && history.coordinator);
    let cursors: Vec<i64> = history.messages.iter().map(|m| m.cursor).collect();
    assert_eq!(cursors, vec![5, 6, 7]);
    assert_eq!(history.before_cursor, Some(5));
    assert_eq!(history.messages[0].author, SidebarAuthor::Participant);
    assert_eq!(history.messages[1].author, SidebarAuthor::Owner);
    for hidden in ["unbound", "retired-worker", "task-group-quiet-1"] {
        let (status, _) = send(
            &case.state,
            "GET",
            &format!("/api/v2/v1-threads/{hidden}/messages"),
            &[&auth],
            "",
        )
        .await;
        assert_eq!(status, 404, "{hidden}");
    }
    let (status, _) = send(
        &case.state,
        "GET",
        "/api/v2/v1-threads/..%2Fsecrets/messages",
        &[&auth],
        "",
    )
    .await;
    assert!(status == 400 || status == 404);

    // Read marks: V1 cursor and native sequence; never past the sequence.
    let (status, mark) = send(
        &case.state,
        "PUT",
        "/api/v2/sidebar/read",
        &[&auth],
        r#"{"key":"v1:group-coordinated","marker":7}"#,
    )
    .await;
    assert_eq!((status, mark["marker"].as_i64()), (200, Some(7)));
    let (status, _) = send(
        &case.state,
        "PUT",
        "/api/v2/sidebar/read",
        &[&auth],
        &json!({"key": format!("v2:{}", case.conversation), "marker": 99}).to_string(),
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = send(
        &case.state,
        "PUT",
        "/api/v2/sidebar/read",
        &[&auth],
        r#"{"key":"v9:x","marker":1}"#,
    )
    .await;
    assert_eq!(status, 400);

    // Lineage only for an imported source; unauthenticated reads fail.
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/lineage"),
        &[&auth],
        r#"{"source_instance":"synthetic-v1","source_thread_id":"imported-worker","source_parent_thread_id":"group-quiet"}"#,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("lineage_source_not_imported"))
    );
    let (status, _) = send(&case.state, "GET", "/api/v2/sidebar", &[], "").await;
    assert_eq!(status, 401);
    case.finish().await;
}
