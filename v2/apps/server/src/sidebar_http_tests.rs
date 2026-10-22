use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) const V1_TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";

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
fn whatsapp_linked_conversations_carry_the_group_and_hide_their_v1_thread() {
    let conversation = Uuid::new_v4();
    let route = Uuid::new_v4();
    let mut delegated_by_id = thread(
        "group-delegated",
        "Synthetic delegated",
        "2026-01-02T00:00:00Z",
    );
    delegated_by_id["binding"]["displayName"] = json!("Synthetic delegated group");
    delegated_by_id["binding"]["remoteBackend"] = json!("rust-v2");
    delegated_by_id["binding"]["remoteThreadId"] = json!(conversation.to_string());
    delegated_by_id["binding"]["remoteRuntimeEnabled"] = json!(true);
    // Migrated chat: the V1 binding names an adapter route, the V2 lineage
    // names the thread.
    let mut migrated = thread(
        "group-migrated",
        "Synthetic migrated",
        "2026-01-03T00:00:00Z",
    );
    migrated["binding"]["displayName"] = json!("Synthetic migrated group");
    migrated["binding"]["remoteThreadId"] = json!(route.to_string());
    let registry = json!({"threads": [
        delegated_by_id,
        migrated,
        thread("group-v1", "Synthetic V1 group", "2026-01-01T00:00:00Z"),
        worker("worker-group-migrated-0001", "group-migrated", "Synthetic migrated / Worker 1", "2026-01-04T00:00:00Z"),
        {"id": "unbound", "name": "Synthetic unbound"},
    ]});
    let threads = sidebar_v1::parse_registry(&registry).unwrap();
    let mut by_id = row(
        "Synthetic delegated conversation",
        Some("2026-01-02T00:00:00.000Z"),
    );
    by_id.conversation_id = ConversationId(conversation);
    let mut by_lineage = row("Synthetic migrated", Some("2026-01-03T00:00:00.000Z"));
    by_lineage.lineage = Some(ConversationLineage {
        source_instance: "synthetic-v1".into(),
        source_thread_id: "group-migrated".into(),
        source_parent_thread_id: None,
    });
    let mut plain = row("Synthetic native", None);
    plain.source_thread_id = Some("unbound".into());
    let (id_key, lineage_key, plain_key) = (
        format!("v2:{}", by_id.conversation_id),
        format!("v2:{}", by_lineage.conversation_id),
        format!("v2:{}", plain.conversation_id),
    );
    let page = compose(
        vec![native(by_id), native(by_lineage), native(plain)],
        LinkedSource::Registry(&threads),
        &BTreeMap::new(),
        &HashMap::new(),
        &HashSet::new(),
        SidebarV1Status::Ready,
        false,
        1,
    );
    assert!(page.is_valid());
    let delegated = by_key(&page, &id_key);
    assert_eq!(
        delegated.whatsapp.as_deref(),
        Some("Synthetic delegated group")
    );
    assert_eq!(delegated.v1_thread_id.as_deref(), Some("group-delegated"));
    assert!(!delegated.read_only);
    let migrated = by_key(&page, &lineage_key);
    assert_eq!(
        migrated.whatsapp.as_deref(),
        Some("Synthetic migrated group")
    );
    // Each delegated V1 thread appears once: as its V2 conversation.
    for hidden in ["v1:group-delegated", "v1:group-migrated"] {
        assert!(page.entries.iter().all(|e| e.key != hidden), "{hidden}");
    }
    // Its sub-chats move under the V2 conversation.
    assert_eq!(
        by_key(&page, "v1:worker-group-migrated-0001")
            .parent_key
            .as_deref(),
        Some(lineage_key.as_str())
    );
    assert_eq!(
        by_key(&page, "v1:worker-group-migrated-0001").whatsapp,
        None
    );
    // A V1 group without a chat display name is labelled by its thread name.
    assert_eq!(
        by_key(&page, "v1:group-v1").whatsapp.as_deref(),
        Some("Synthetic V1 group")
    );
    assert_eq!(
        by_key(&page, &plain_key).whatsapp,
        None,
        "not a group thread"
    );
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

/// A synthetic, valid client message id.
fn synthetic_id(n: u128) -> String {
    Uuid::from_u128(n).to_string()
}

/// The registry the synthetic V1 API serves: [`registry`] plus a group whose
/// runtime is delegated to V2 but not imported here.
fn served_registry() -> Value {
    let mut value = registry();
    let mut delegated = thread(
        "group-delegated",
        "Synthetic delegated group",
        "2025-12-01T00:00:00Z",
    );
    delegated["binding"]["remoteThreadId"] = json!("00000000-0000-4000-8000-000000000001");
    delegated["binding"]["remoteRuntimeEnabled"] = json!(true);
    value["threads"].as_array_mut().unwrap().push(delegated);
    value
}

/// Synthetic V1 `ui-input`: dedupes on `clientMessageId` per thread like V1.
fn ui_input(
    inputs: &StdArc<StdMutex<Vec<(String, Value)>>>,
    thread: &str,
    body: &Value,
) -> (u16, Value) {
    let key = body["clientMessageId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let mut inputs = inputs.lock().unwrap();
    if let Some(index) = inputs
        .iter()
        .position(|(t, b)| t == thread && b["clientMessageId"] == key.as_str())
    {
        let first = &inputs[index].1;
        return (
            202,
            json!({"ok": true, "message": {"id": format!("msg-{index}"), "role": "user",
            "text": first["text"], "clientMessageId": key, "state": "queued",
            "duplicate": true, "duplicateReason": "client_message_id"}}),
        );
    }
    inputs.push((thread.to_owned(), body.clone()));
    (
        202,
        json!({"ok": true, "queued": true, "message": {"id": format!("msg-{}", inputs.len() - 1),
        "role": "user", "text": body["text"], "clientMessageId": key, "state": "queued"}}),
    )
}

/// Synthetic V1 loopback API: the registry and per-thread messages.
async fn fake_v1(calls: StdArc<StdMutex<Vec<String>>>) -> String {
    fake_v1_with_inputs(calls, StdArc::new(StdMutex::new(Vec::new()))).await
}

pub(crate) async fn fake_v1_with_inputs(
    calls: StdArc<StdMutex<Vec<String>>>,
    inputs: StdArc<StdMutex<Vec<(String, Value)>>>,
) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    // Like production V1 with ORKESTR_ATTACHMENT_ENCRYPTION_REQUIRED=1: files
    // only through encrypted inbound sessions, plain uploads refused.
    let identity = age::x25519::Identity::generate();
    let mut sessions = std::collections::HashMap::<String, Value>::new();
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
            let split = raw
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .unwrap_or(raw.len());
            let head = String::from_utf8_lossy(&raw[..split]).to_string();
            let length: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Length: "))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            let mut body = raw.get(split + 4..).unwrap_or_default().to_vec();
            while body.len() < length {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&buf[..n]);
            }
            let method = head.split(' ').next().unwrap_or_default().to_owned();
            let path = head.split(' ').nth(1).unwrap_or_default().to_owned();
            let raw_body = body.clone();
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let auth = head
                .lines()
                .any(|l| l == format!("Authorization: Bearer {V1_TOKEN}"));
            calls.lock().unwrap().push(path.clone());
            let (status, body) = if !auth {
                (401, json!({}))
            } else if let Some(rest) = path.strip_prefix("/api/attachment-encryption/inbound/") {
                fake_inbound(
                    &identity,
                    &mut sessions,
                    &method,
                    rest,
                    &head,
                    &body,
                    &raw_body,
                )
            } else if method == "POST" {
                let rest = path.strip_prefix("/api/threads/").unwrap_or_default();
                if let Some(thread) = rest.strip_suffix("/ui-input") {
                    ui_input(&inputs, thread, &body)
                } else if rest.ends_with("/uploads") {
                    (409, json!({"error": "inbound_upload_encryption_required"}))
                } else {
                    (404, json!({"error": "not_found"}))
                }
            } else if path.starts_with("/api/threads/summary") {
                (200, served_registry())
            } else if path.starts_with("/api/threads/group-coordinated/messages") {
                let mut page = json!({"currentCursor": 7, "hasMoreBefore": true, "state": "ready", "messages": [
                    {"id": "m6", "role": "user", "text": "Synthetic question", "cursor": "6", "createdAt": "2026-01-03T00:00:00Z"},
                    {"id": "m7", "role": "assistant", "text": "Synthetic answer", "cursor": 7, "phase": "final_answer", "createdAt": "2026-01-03T00:00:01Z"},
                    {"id": "m5", "role": "user", "text": "Synthetic member note", "cursor": 5, "senderEffectiveRole": "member"},
                ]});
                // After app input: the input waits and the coordinator posted.
                if !inputs.lock().unwrap().is_empty() {
                    let list = page["messages"].as_array_mut().unwrap();
                    list.push(json!({"id": "m8", "role": "user", "source": "ui", "text": "Synthetic hello", "cursor": 8, "state": "queued"}));
                    list.push(json!({"id": "m9", "role": "assistant", "source": "api-session", "text": "Synthetic coordinator note", "cursor": 9, "phase": "final_answer"}));
                }
                (200, page)
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

/// Synthetic V1 encrypted inbound uploads: a session per file with a signed
/// descriptor, the age ciphertext decrypted and its framing checked, then
/// `process` publishes the attachment under the thread's upload directory.
fn fake_inbound(
    identity: &age::x25519::Identity,
    sessions: &mut std::collections::HashMap<String, Value>,
    method: &str,
    rest: &str,
    head: &str,
    body: &Value,
    raw: &[u8],
) -> (u16, Value) {
    if method == "GET" && rest.starts_with("status?threadId=") {
        return (
            200,
            json!({"ok": true, "enabled": true, "required": true, "ready": true,
            "processingMode": "transport", "limits": {"maxFileBytes": 26214400, "maxFiles": 20}}),
        );
    }
    if method == "POST" && rest == "sessions" {
        let thread = body["threadId"].as_str().unwrap_or_default().to_owned();
        let recipient = identity.to_public().to_string();
        let out: Vec<Value> = body["files"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|f| {
                let id = format!("inbound-{}", f["idempotencyKey"].as_str().unwrap_or("x"));
                sessions
                    .entry(id.clone())
                    .or_insert_with(|| {
                        json!({"id": id, "state": "receiving", "threadId": thread, "attachment": null,
                        "descriptor": {"version": 1, "sessionId": id, "keyId": "synthetic-key",
                        "keyVersion": 1, "recipient": recipient, "purpose": "inbound_attachment_upload",
                        "expiresAt": "2099-01-01T00:00:00Z", "maxPlaintextBytes": f["plaintextSize"],
                        "signature": "synthetic-signature"}})
                    })
                    .clone()
            })
            .collect();
        return (201, json!({"ok": true, "sessions": out}));
    }
    let Some((id, action)) = rest
        .strip_prefix("sessions/")
        .and_then(|r| r.split_once('/'))
    else {
        return (404, json!({"error": "not_found"}));
    };
    let Some(session) = sessions.get_mut(id) else {
        return (404, json!({"error": "not_found"}));
    };
    match (method, action) {
        ("PUT", "ciphertext") if session["state"] == "receiving" => {
            if !head.lines().any(|l| l == "Content-Type: application/age") {
                return (
                    415,
                    json!({"error": "inbound_upload_ciphertext_content_type_required"}),
                );
            }
            let Some(plain) = age::Decryptor::new(raw).ok().and_then(|d| {
                let mut out = Vec::new();
                std::io::Read::read_to_end(
                    &mut d
                        .decrypt(std::iter::once(identity as &dyn age::Identity))
                        .ok()?,
                    &mut out,
                )
                .ok()?;
                Some(out)
            }) else {
                return (400, json!({"error": "inbound_upload_decrypt_failed"}));
            };
            let text = String::from_utf8_lossy(&plain).to_string();
            let mut lines = text.splitn(3, '\n');
            let (magic, length) = (
                lines.next(),
                lines.next().and_then(|l| l.parse::<usize>().ok()),
            );
            let prefix = format!("{}\n{}\n", magic.unwrap_or(""), length.unwrap_or(0));
            let header: Value = plain
                .get(prefix.len()..prefix.len() + length.unwrap_or(0))
                .and_then(|h| serde_json::from_slice(h).ok())
                .unwrap_or(Value::Null);
            let content = plain.len() - prefix.len() - length.unwrap_or(0);
            if magic != Some("ORKESTR-INBOUND-UPLOAD/1")
                || header["sessionId"] != id
                || header["descriptor"] != session["descriptor"]
                || header["plaintextSize"].as_u64() != Some(content as u64)
            {
                return (400, json!({"error": "inbound_upload_payload_invalid"}));
            }
            session["state"] = json!("quarantined");
            session["header"] = header;
            (201, json!({"ok": true, "session": session}))
        }
        ("POST", "process") if session["state"] == "quarantined" => {
            let header = session["header"].clone();
            let name = header["filename"].as_str().unwrap_or("x");
            session["state"] = json!("ready");
            session["attachment"] = json!({"id": format!("inbound-attachment-{id}"),
                "name": name, "filename": name, "mimetype": header["mimetype"],
                "size": header["plaintextSize"],
                "path": format!("/synthetic-v1/uploads/{}/{name}", session["threadId"].as_str().unwrap_or("")),
                "source": "browser_encrypted_inbound", "uploadSessionId": id});
            (201, json!({"ok": true, "session": session}))
        }
        _ => (409, json!({"error": "inbound_upload_state_invalid"})),
    }
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

#[tokio::test]
async fn owner_input_reaches_listed_v1_threads_exactly_once() {
    let mut case = case().await;
    let auth = case.auth();
    let calls = StdArc::new(StdMutex::new(Vec::new()));
    let inputs = StdArc::new(StdMutex::new(Vec::new()));
    let url = fake_v1_with_inputs(calls.clone(), inputs.clone()).await;
    let body = |id: &str, text: &str| json!({"client_message_id": id, "text": text}).to_string();
    let first = synthetic_id(1);
    let path = "/api/v2/v1-threads/group-coordinated/messages";
    // Without the V1 client nothing is sent.
    let (status, _) = send(
        &case.state,
        "POST",
        path,
        &[&auth],
        &body(&first, "Synthetic hello"),
    )
    .await;
    assert_eq!(status, 404);
    case.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));

    // The history page says the thread is writable and bound to a group.
    let (status, page) = send(&case.state, "GET", path, &[&auth], "").await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(
        (page["writable"].as_bool(), page["working"].as_bool()),
        (Some(true), Some(false))
    );

    let (status, receipt) = send(
        &case.state,
        "POST",
        path,
        &[&auth],
        &body(&first, "Synthetic hello"),
    )
    .await;
    assert_eq!(status, 202, "{receipt}");
    let receipt: V1ThreadInputReceipt = serde_json::from_value(receipt).unwrap();
    assert!(receipt.is_valid() && !receipt.duplicate);
    assert_eq!(receipt.thread_id, "group-coordinated");
    {
        let inputs = inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        let (thread, sent) = &inputs[0];
        assert_eq!(thread, "group-coordinated");
        // Exactly the V1 web UI body: no role, source or trust fields.
        assert_eq!(
            sent,
            &json!({"text": "Synthetic hello", "clientMessageId": format!("orkestr-v2-{first}"),
                "replyDelivery": "ui_only"})
        );
    }
    // A retry (unknown outcome in the browser) returns the first message.
    let (status, again) = send(
        &case.state,
        "POST",
        path,
        &[&auth],
        &body(&first, "Synthetic hello"),
    )
    .await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["duplicate"], true);
    assert_eq!(again["message_id"], receipt.message_id.as_str());
    assert_eq!(inputs.lock().unwrap().len(), 1, "exactly once");
    // The same key with other text is a conflict, never a second input.
    let (status, conflict) = send(
        &case.state,
        "POST",
        path,
        &[&auth],
        &body(&first, "Other text"),
    )
    .await;
    assert_eq!(
        (status, conflict["code"].as_str()),
        (409, Some("idempotency_conflict"))
    );

    // The page now shows the waiting input and the coordinator's post.
    let (status, page) = send(&case.state, "GET", path, &[&auth], "").await;
    assert_eq!(status, 200, "{page}");
    let page: V1HistoryPage = serde_json::from_value(page).unwrap();
    assert!(page.working, "queued owner input means V1 is working");
    let last = page.messages.last().unwrap();
    assert!(last.coordinator && last.author == SidebarAuthor::Assistant);
    assert!(!page.messages[page.messages.len() - 2].coordinator);

    // Worker sub-threads take owner input too.
    let worker = "/api/v2/v1-threads/worker-group-coordinated-0001/messages";
    let other = synthetic_id(2);
    let (status, _) = send(
        &case.state,
        "POST",
        worker,
        &[&auth],
        &body(&other, "Synthetic worker note"),
    )
    .await;
    assert_eq!(status, 202);

    // Delegated to V2: refused here, so it can never be routed twice.
    let delegated = "/api/v2/v1-threads/group-delegated/messages";
    let (status, page) = send(&case.state, "GET", delegated, &[&auth], "").await;
    assert_eq!((status, page["writable"].as_bool()), (200, Some(false)));
    let third = synthetic_id(3);
    let (status, refused) = send(
        &case.state,
        "POST",
        delegated,
        &[&auth],
        &body(&third, "Synthetic"),
    )
    .await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (409, Some("v1_thread_delegated"))
    );
    // Unlisted, imported-elsewhere or malformed targets and bodies.
    for hidden in ["unbound", "retired-worker", "task-group-quiet-1"] {
        let (status, _) = send(
            &case.state,
            "POST",
            &format!("/api/v2/v1-threads/{hidden}/messages"),
            &[&auth],
            &body(&third, "Synthetic"),
        )
        .await;
        assert_eq!(status, 404, "{hidden}");
    }
    for bad in [
        body("not-a-uuid", "Synthetic"),
        body(&third, "   "),
        json!({"client_message_id": &third, "text": "x", "role": "assistant"}).to_string(),
        json!({"client_message_id": &third, "text": "x", "reply_to_whatsapp": true}).to_string(),
        body(&third, &"x".repeat(V1_INPUT_TEXT_MAX + 1)),
    ] {
        let (status, _) = send(&case.state, "POST", path, &[&auth], &bad).await;
        assert_eq!(status, 400);
    }
    let (status, _) = send(&case.state, "POST", path, &[], &body(&third, "Synthetic")).await;
    assert_eq!(status, 401);
    assert_eq!(
        inputs.lock().unwrap().len(),
        2,
        "no refused request reached V1"
    );
    case.finish().await;
}

#[test]
fn v1_receipts_are_bounded_and_refusals_are_definite() {
    let threads = sidebar_v1::parse_registry(&served_registry()).unwrap();
    let delegated = threads.iter().find(|t| t.id == "group-delegated").unwrap();
    assert!(delegated.delegated);
    let group = threads
        .iter()
        .find(|t| t.id == "group-coordinated")
        .unwrap();
    assert!(!group.delegated && group.whatsapp);
    assert_eq!(
        sidebar_v1::input_body(
            &V1ThreadInput {
                client_message_id: synthetic_id(1),
                text: "Synthetic".into(),
                attachment_ids: vec![],
            },
            &[]
        )["replyDelivery"],
        "ui_only",
        "replies to app input never go to WhatsApp"
    );
    // A remote id with the runtime switched off runs on V1 again.
    let mut local = thread("local-again", "Synthetic", "2026-01-01T00:00:00Z");
    local["binding"]["remoteThreadId"] = json!("x");
    local["binding"]["remoteRuntimeEnabled"] = json!(false);
    assert!(!sidebar_v1::parse_thread(&local).unwrap().delegated);
    let input = V1ThreadInput {
        client_message_id: synthetic_id(1),
        text: "Synthetic".into(),
        attachment_ids: vec![],
    };
    use sidebar_v1::{input_receipt, InputFailure};
    assert_eq!(
        input_receipt(group, &input, 404, &json!({})),
        Err(InputFailure::NotFound)
    );
    assert_eq!(
        input_receipt(group, &input, 409, &json!({"error": "thread_busy"})),
        Err(InputFailure::Refused("thread_busy".into()))
    );
    assert_eq!(
        input_receipt(group, &input, 502, &json!({})),
        Err(InputFailure::Unknown)
    );
    let handled = input_receipt(group, &input, 202, &json!({"ok": true})).unwrap();
    assert_eq!(
        handled.message_id,
        format!("orkestr-v2-{}", input.client_message_id)
    );
}

#[test]
fn visibility_hides_marked_entries_their_sub_chats_and_moved_v1_threads() {
    let threads = sidebar_v1::parse_registry(&registry()).unwrap();
    let plain = row("Synthetic native", Some("2026-01-02T12:00:00.000Z"));
    let mut moved = row("Synthetic imported group", None);
    moved.source_thread_id = Some("group-imported".into());
    let (plain_key, moved_key) = (
        format!("v2:{}", plain.conversation_id),
        format!("v2:{}", moved.conversation_id),
    );
    let page = || {
        compose(
            vec![native(plain.clone()), native(moved.clone())],
            LinkedSource::Registry(&threads),
            &BTreeMap::new(),
            &HashMap::new(),
            &HashSet::new(),
            SidebarV1Status::Ready,
            false,
            1,
        )
    };
    let all = page();
    let total = all.entries.len();
    assert!(all.entries.iter().all(|e| !e.hidden));
    // A V1 group with a worker sub-chat, and a V1 thread that moved to V2.
    let hidden: BTreeSet<String> = ["v1:group-coordinated", "v1:group-imported"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut shown = page();
    apply_visibility(&mut shown, &hidden, false);
    let keys: Vec<&str> = shown.entries.iter().map(|e| e.key.as_str()).collect();
    for gone in [
        "v1:group-coordinated",
        "v1:worker-group-coordinated-0001",
        moved_key.as_str(),
    ] {
        assert!(!keys.contains(&gone), "{gone} listed");
    }
    assert!(keys.contains(&plain_key.as_str()));
    assert_eq!(shown.hidden_count, 3);
    assert_eq!(shown.entries.len(), total - 3);
    assert!(shown.is_valid());
    let mut everything = page();
    apply_visibility(&mut everything, &hidden, true);
    assert_eq!(everything.entries.len(), total);
    assert_eq!(everything.hidden_count, 3);
    assert!(by_key(&everything, "v1:worker-group-coordinated-0001").hidden);
    assert!(by_key(&everything, &moved_key).hidden);
    assert!(!by_key(&everything, &plain_key).hidden);
    assert!(everything.is_valid());
    // Nothing hidden: the page is unchanged.
    let mut same = page();
    apply_visibility(&mut same, &BTreeSet::new(), false);
    assert_eq!(same, all);
}

#[tokio::test]
async fn hidden_system_chats_leave_the_default_list_but_stay_reachable() {
    let mut case = case().await;
    let auth = case.auth();
    let calls = StdArc::new(StdMutex::new(Vec::new()));
    let url = fake_v1(calls.clone()).await;
    case.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let native_key = format!("v2:{}", case.conversation);
    let put = |body: Value| {
        let (state, auth) = (case.state.clone(), auth.clone());
        async move {
            send(
                &state,
                "PUT",
                "/api/v2/sidebar/visibility",
                &[&auth],
                &body.to_string(),
            )
            .await
        }
    };
    let (status, body) = put(json!({"key": "v1:group-coordinated", "hidden": true,
        "reason": "Synthetic health probe"}))
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["changed"], true);
    let (status, body) = put(json!({"key": native_key, "hidden": true})).await;
    assert_eq!((status, body["changed"].as_bool()), (200, Some(true)));
    // Invalid keys, a reason on show, unknown fields and unknown chats.
    for bad in [
        json!({"key": "v9:x", "hidden": true}),
        json!({"key": "v1:group-quiet", "hidden": false, "reason": "x"}),
        json!({"key": "v1:group-quiet", "hidden": true, "extra": 1}),
    ] {
        assert_eq!(put(bad.clone()).await.0, 400, "{bad}");
    }
    let unknown = format!("v2:{}", Uuid::new_v4());
    assert_eq!(put(json!({"key": unknown, "hidden": true})).await.0, 404);

    let (status, page) = send(&case.state, "GET", "/api/v2/sidebar", &[&auth], "").await;
    assert_eq!(status, 200, "{page}");
    let page: SidebarPage = serde_json::from_value(page).unwrap();
    assert!(page.is_valid());
    let keys: Vec<&str> = page.entries.iter().map(|e| e.key.as_str()).collect();
    assert!(!keys.contains(&"v1:group-coordinated"));
    assert!(!keys.contains(&"v1:worker-group-coordinated-0001"));
    assert!(!keys.contains(&native_key.as_str()));
    assert!(keys.contains(&"v1:group-quiet"));
    assert_eq!(page.hidden_count, 3);
    let (status, page) = send(
        &case.state,
        "GET",
        "/api/v2/sidebar?include_hidden=true",
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200, "{page}");
    let page: SidebarPage = serde_json::from_value(page).unwrap();
    assert!(page.is_valid());
    assert_eq!(page.entries.iter().filter(|e| e.hidden).count(), 3);
    assert!(by_key(&page, "v1:group-coordinated").hidden);
    assert!(!by_key(&page, "v1:group-quiet").hidden);
    let (status, _) = send(&case.state, "GET", "/api/v2/sidebar?other=1", &[&auth], "").await;
    assert_eq!(status, 400);

    // Still reachable: its history opens and the native chat reads normally.
    let (status, _) = send(
        &case.state,
        "GET",
        "/api/v2/v1-threads/group-coordinated/messages",
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = send(&case.state, "GET", &case.path(""), &[&auth], "").await;
    assert_eq!(status, 200);

    // Showing again restores the default list; unauthenticated writes fail.
    let (status, body) = put(json!({"key": native_key, "hidden": false})).await;
    assert_eq!((status, body["changed"].as_bool()), (200, Some(true)));
    let (_, page) = send(&case.state, "GET", "/api/v2/sidebar", &[&auth], "").await;
    let page: SidebarPage = serde_json::from_value(page).unwrap();
    assert!(page.entries.iter().any(|e| e.key == native_key));
    assert_eq!(page.hidden_count, 2);
    let (status, _) = send(
        &case.state,
        "PUT",
        "/api/v2/sidebar/visibility",
        &[],
        r#"{"key":"v1:group-quiet","hidden":true}"#,
    )
    .await;
    assert_eq!(status, 401);
    case.finish().await;
}
