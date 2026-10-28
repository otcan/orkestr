use super::*;
use axum::body::to_bytes;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const V1_TOKEN: &str = "ffffffffffffffffffffffff";
const ADAPTER_TOKEN: &str = "AdapterSyntheticToken0123456789abcdef";

/// Synthetic V1 and adapter: records every call; knobs inject refusals.
#[derive(Default)]
struct Peer {
    calls: Vec<(String, String, Value)>,
    /// V1 answers thread creation with another thread (a name match).
    name_taken: bool,
    /// The adapter refuses the next binding creation.
    adapter_refuses: bool,
    threads: std::collections::HashMap<String, Value>,
    bindings: std::collections::HashMap<String, Value>,
}
type Shared = StdArc<StdMutex<Peer>>;

fn v1(peer: &Shared, method: &str, path: &str, body: &Value) -> (u16, Value) {
    let mut peer = peer.lock().unwrap();
    match (method, path) {
        ("POST", "/api/threads") => {
            if peer.name_taken {
                return (
                    200,
                    json!({"thread": {"id": "existing-synthetic", "name": body["name"]}}),
                );
            }
            let id = body["id"].as_str().unwrap().to_owned();
            let thread = peer
                .threads
                .entry(id.clone())
                .or_insert_with(|| json!({"id": id, "name": body["name"], "binding": null}))
                .clone();
            (200, json!({"thread": thread}))
        }
        ("POST", "/api/connectors/whatsapp/thread-groups") => {
            let id = body["threadId"].as_str().unwrap().to_owned();
            let Some(thread) = peer.threads.get_mut(&id) else {
                return (404, json!({"error": "thread_not_found"}));
            };
            let reused = !thread["binding"].is_null();
            if !reused {
                thread["binding"] = json!({"connector": "whatsapp", "chatId": "120000000000000001@g.us",
                    "responderAccountId": "synthetic-account", "mirrorToWhatsApp": body["mirrorToWhatsApp"]});
            }
            (
                200,
                json!({"ok": true, "created": !reused, "reused": reused,
                "chat": {"id": "120000000000000001@g.us"}, "binding": thread["binding"]}),
            )
        }
        _ => {
            let rest = path.strip_prefix("/api/threads/").unwrap_or_default();
            let (id, tail) = rest.split_once('/').unwrap_or((rest, ""));
            let id = id.split('?').next().unwrap().to_owned();
            let Some(thread) = peer.threads.get_mut(&id) else {
                return (404, json!({"error": "thread_not_found"}));
            };
            match (method, tail) {
                ("GET", "") => (200, json!({"thread": thread})),
                ("GET", t) if t.starts_with("messages") => {
                    (200, json!({"messages": [], "hasMoreBefore": false}))
                }
                ("PUT", "binding") => {
                    for (k, v) in body.as_object().unwrap() {
                        thread["binding"][k] = v.clone();
                    }
                    (200, json!({"ok": true, "binding": thread["binding"]}))
                }
                _ => (404, json!({"error": "not_found"})),
            }
        }
    }
}

fn adapter(peer: &Shared, method: &str, path: &str, body: &Value) -> (u16, Value) {
    let mut peer = peer.lock().unwrap();
    let route = path
        .strip_prefix("/bindings/")
        .unwrap_or_default()
        .to_owned();
    if method != "PUT" || route.is_empty() {
        return (404, json!({"ok": false}));
    }
    if std::mem::take(&mut peer.adapter_refuses) {
        return (409, json!({"ok": false, "error": "binding_conflict"}));
    }
    match peer.bindings.get(&route) {
        Some(existing) if existing != body => {
            (409, json!({"ok": false, "error": "binding_exists"}))
        }
        _ => {
            peer.bindings.insert(route.clone(), body.clone());
            (
                200,
                json!({"ok": true, "remote_thread_id": route, "state": "enabled", "error": null}),
            )
        }
    }
}

async fn serve(peer: Shared, token: &'static str, is_adapter: bool) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            let split = loop {
                if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at;
                }
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break raw.len();
                }
                raw.extend_from_slice(&buf[..n]);
            };
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
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let authorized = head
                .lines()
                .any(|l| l == format!("Authorization: Bearer {token}"));
            peer.lock()
                .unwrap()
                .calls
                .push((method.clone(), path.clone(), body.clone()));
            let (status, value) = if !authorized {
                (401, json!({}))
            } else if is_adapter {
                adapter(&peer, &method, &path, &body)
            } else {
                v1(&peer, &method, &path, &body)
            };
            let text = value.to_string();
            let response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    format!("http://{address}")
}

async fn fixture() -> (std::path::PathBuf, AppState, HeaderMap) {
    let root = std::env::temp_dir().join(format!("whatsapp-chats-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let cookie = "a".repeat(64);
    store
        .save_session(&format!("browser:{cookie}"), &owner)
        .await
        .unwrap();
    let state = AppState::new(store, "b".repeat(64), "http://127.0.0.1:19881".into()).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:19881".parse().unwrap());
    headers.insert("origin", "http://127.0.0.1:19881".parse().unwrap());
    headers.insert(
        "cookie",
        format!("orkestr_v2_session={cookie}").parse().unwrap(),
    );
    headers.insert(
        "x-orkestr-csrf",
        format!(
            "{:x}",
            Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{cookie}").as_bytes())
        )
        .parse()
        .unwrap(),
    );
    (root, state, headers)
}

fn request(id: u128, name: &str) -> WhatsAppChatRequest {
    WhatsAppChatRequest {
        client_request_id: Uuid::from_u128(id).to_string(),
        name: name.into(),
        provider: ConversationProvider::Codex,
        model: Some("synthetic-model".into()),
        reasoning_effort: Some("low".into()),
        workspace: Some("/srv/synthetic-workspace".into()),
    }
}

async fn post(
    state: &AppState,
    headers: &HeaderMap,
    body: WhatsAppChatRequest,
) -> (StatusCode, WhatsAppChatProvision) {
    let response = create(State(state.clone()), headers.clone(), Ok(Json(body)))
        .await
        .unwrap_or_else(|error| panic!("refused: {}", error.1));
    let status = response.status();
    let value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    (status, value)
}

fn count(peer: &Shared, method: &str, prefix: &str) -> usize {
    peer.lock()
        .unwrap()
        .calls
        .iter()
        .filter(|(m, p, _)| m == method && p.starts_with(prefix))
        .count()
}

#[tokio::test]
async fn new_chat_is_wired_to_v2_once_and_resumes_after_a_refusal() {
    let (root, mut state, headers) = fixture().await;
    // Unconfigured: nothing is created anywhere.
    let error = create(
        State(state.clone()),
        headers.clone(),
        Ok(Json(request(1, "Synthetic chat"))),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.1, "whatsapp_chats_unconfigured");
    let response = directory(State(state.clone()), headers.clone())
        .await
        .unwrap_or_else(|e| panic!("{}", e.1));
    let listing: WhatsAppChatDirectory =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert!(!listing.available);

    let v1_peer: Shared = Default::default();
    let adapter_peer: Shared = Default::default();
    let v1_url = serve(v1_peer.clone(), V1_TOKEN, false).await;
    let adapter_url = serve(adapter_peer.clone(), ADAPTER_TOKEN, true).await;
    state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&v1_url, V1_TOKEN.into()).unwrap(),
    ));
    let rules_dir = std::env::temp_dir().join(format!("wa-chat-rules-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&rules_dir).unwrap();
    state.whatsapp_chats = Some(Arc::new(
        chats::synthetic(&adapter_url, ADAPTER_TOKEN).with_rules_dir(rules_dir.to_str().unwrap()),
    ));

    let (status, chat) = post(&state, &headers, request(1, "Synthetic chat")).await;
    assert_eq!(status, StatusCode::CREATED, "{chat:?}");
    assert_eq!(chat.stage, WhatsAppChatStage::RelayPending);
    assert_eq!(chat.chat_id.as_deref(), Some("120000000000000001@g.us"));
    assert!(chat.error.is_none() && chat.is_valid());
    // Settings were applied to the new conversation.
    let credential = browser::credential(&headers).unwrap_or_else(|e| panic!("{}", e.1));
    let owner = browser::owner(&state, &headers)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1));
    let settings = state
        .store
        .conversation_settings(&credential, &owner, &chat.conversation_id)
        .await
        .unwrap();
    assert_eq!(
        (
            settings.model.as_deref(),
            settings.reasoning_effort.as_deref()
        ),
        (Some("synthetic-model"), Some("low"))
    );
    {
        let calls = &v1_peer.lock().unwrap().calls;
        let create_thread = calls
            .iter()
            .find(|(m, p, _)| m == "POST" && p == "/api/threads")
            .unwrap();
        assert_eq!(
            create_thread.2,
            json!({"id": chat.v1_thread_id, "name": "Synthetic chat", "cwd": "/srv/synthetic-workspace"})
        );
        let group = calls
            .iter()
            .find(|(_, p, _)| p.ends_with("/thread-groups"))
            .unwrap();
        // Owner numbers come from the private config, never from the browser.
        assert_eq!(group.2["participantIds"], json!(["10000000001@c.us"]));
        assert_eq!(group.2["mirrorToWhatsApp"], false);
        let delegation = calls.iter().find(|(m, _, _)| m == "PUT").unwrap();
        assert_eq!(
            delegation.2,
            json!({"remoteBackend": "synthetic-v2", "remoteThreadId": chat.remote_thread_id,
                "remoteRuntimeEnabled": true, "remoteMirrorEnabled": true, "mirrorToWhatsApp": false})
        );
    }
    let binding = adapter_peer.lock().unwrap().bindings[&chat.remote_thread_id].clone();
    assert_eq!(binding["conversation_id"], chat.conversation_id.to_string());
    assert_eq!(binding["public_thread_id"], chat.v1_thread_id.as_str());
    assert_eq!(binding["account_id"], "synthetic-account");
    assert_eq!(binding["excluded_public_ids"], json!([]));
    // The full onboarding template: owner-only Fast, 24 inputs, no extra
    // participants, unverified membership, and a generated rules file.
    assert_eq!(binding["fast_reply_policy"], "owner_only");
    assert_eq!(binding["max_outstanding_inputs"], 24);
    assert_eq!(binding["participants"], json!([]));
    assert_eq!(binding["owner_only_verified"], false);
    let rules_path = rules_dir.join(format!("chat-{}.md", chat.conversation_id));
    assert_eq!(binding["instructions_path"], rules_path.to_str().unwrap());
    let rules = std::fs::read_to_string(&rules_path).unwrap();
    assert!(rules.starts_with("Chat rules: Synthetic chat\n"));
    assert!(rules.contains(&chat.v1_thread_id) && rules.contains("120000000000000001@g.us"));
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&rules_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o037, 0, "no group write, nothing for others");
    }
    // An operator's edit survives a retry (create-only).
    std::fs::write(&rules_path, "operator rules\n").unwrap();
    assert_eq!(
        (
            binding["enabled"].as_bool(),
            binding["allowed_principals"].clone()
        ),
        (Some(true), json!(["synthetic-owner"]))
    );

    // A retry of a finished request creates nothing again.
    let before = v1_peer.lock().unwrap().calls.len();
    let (status, again) = post(&state, &headers, request(1, "Synthetic chat")).await;
    assert_eq!(
        (status, again.v1_thread_id.clone()),
        (StatusCode::CREATED, chat.v1_thread_id.clone())
    );
    assert_eq!(v1_peer.lock().unwrap().calls.len(), before);
    assert_eq!(
        std::fs::read_to_string(&rules_path).unwrap(),
        "operator rules\n"
    );
    // The same id for another chat is a conflict.
    let error = create(
        State(state.clone()),
        headers.clone(),
        Ok(Json(request(1, "Other chat"))),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.1, "whatsapp_chat_conflict");

    // An adapter refusal stops after the group; the retry continues there.
    adapter_peer.lock().unwrap().adapter_refuses = true;
    let (status, second) = post(&state, &headers, request(2, "Synthetic second")).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        (second.stage, second.error.as_deref()),
        (WhatsAppChatStage::Group, Some("adapter_binding_conflict"))
    );
    assert_eq!(
        count(&v1_peer, "PUT", "/api/threads/"),
        1,
        "not delegated without a binding"
    );
    let (status, second) = post(&state, &headers, request(2, "Synthetic second")).await;
    assert_eq!(
        (status, second.stage, second.error),
        (StatusCode::CREATED, WhatsAppChatStage::RelayPending, None)
    );
    assert_eq!(
        count(&v1_peer, "POST", "/api/threads"),
        2,
        "one V1 thread per chat"
    );

    // V1 matching an existing thread by name is never taken over.
    v1_peer.lock().unwrap().name_taken = true;
    let (status, third) = post(&state, &headers, request(3, "Synthetic third")).await;
    assert_eq!(
        (status, third.stage, third.error.as_deref()),
        (
            StatusCode::ACCEPTED,
            WhatsAppChatStage::Settings,
            Some("v1_thread_name_taken")
        )
    );
    // Group calls: the first chat, the second chat and its retry (V1 reuses
    // the bound group); none for the refused third chat.
    assert_eq!(count(&v1_peer, "POST", "/api/connectors"), 3);

    // Relay registration finishes a delegated chat only; archive keeps the row.
    let key = chat.client_request_id.clone();
    let response = relay_registered(State(state.clone()), headers.clone(), Path(key.clone()))
        .await
        .unwrap_or_else(|e| panic!("{}", e.1));
    let ready: WhatsAppChatProvision =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(ready.stage, WhatsAppChatStage::Ready);
    let error = relay_registered(
        State(state.clone()),
        headers.clone(),
        Path(third.client_request_id.clone()),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.1, "whatsapp_chat_not_delegated");
    let response = archive(
        State(state.clone()),
        headers.clone(),
        Path(key),
        Ok(Json(json!({}))),
    )
    .await
    .unwrap_or_else(|e| panic!("{}", e.1));
    assert_eq!(response.status(), StatusCode::OK);
    // The sidebar links the conversation to its V1 thread (no duplicate entry).
    let list = state
        .store
        .sidebar_conversations(&credential, &owner)
        .await
        .unwrap();
    assert!(list
        .conversations
        .iter()
        .any(|c| c.source_thread_id.as_deref() == Some(chat.v1_thread_id.as_str())));
    let response = directory(State(state.clone()), headers.clone())
        .await
        .unwrap_or_else(|e| panic!("{}", e.1));
    let listing: WhatsAppChatDirectory =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert!(listing.available);
    assert_eq!((listing.participants, listing.provisions.len()), (1, 3));
    assert!(
        !serde_json::to_string(&listing)
            .unwrap()
            .contains("10000000001"),
        "owner numbers stay private"
    );
    state.store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn creation_is_browser_only_and_bounded() {
    let (root, state, headers) = fixture().await;
    let mut bearer = HeaderMap::new();
    bearer.insert("host", "127.0.0.1:19881".parse().unwrap());
    bearer.insert(
        "authorization",
        format!("Bearer {}", "c".repeat(64)).parse().unwrap(),
    );
    assert!(create(
        State(state.clone()),
        bearer,
        Ok(Json(request(1, "Synthetic")))
    )
    .await
    .is_err());
    let mut bad = request(1, "Synthetic");
    bad.workspace = Some("relative".into());
    let error = create(State(state.clone()), headers.clone(), Ok(Json(bad)))
        .await
        .err()
        .unwrap();
    assert_eq!(error.1, "invalid_whatsapp_chat");
    let mut claude = request(1, "Synthetic");
    claude.provider = ConversationProvider::Claude;
    claude.reasoning_effort = None;
    assert!(chats_unavailable_or_refused(&state, &headers, claude).await);
    state.store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

async fn chats_unavailable_or_refused(
    state: &AppState,
    headers: &HeaderMap,
    body: WhatsAppChatRequest,
) -> bool {
    let error = create(State(state.clone()), headers.clone(), Ok(Json(body)))
        .await
        .err()
        .unwrap();
    matches!(
        error.1,
        "whatsapp_chats_unconfigured" | "provider_unavailable"
    )
}

#[test]
fn an_unknown_group_outcome_is_reported_as_such() {
    assert!(chats::outcome_unknown(
        &json!({"provisioning": {"state": "outcome_unknown"}})
    ));
    assert!(chats::outcome_unknown(
        &json!({"groupCreateFailure": {"externalOutcome": "outcome_unknown"}})
    ));
    assert!(!chats::outcome_unknown(
        &json!({"provisioning": {"state": "rejected"}})
    ));
}

#[test]
fn group_answers_must_name_the_chat_and_account() {
    assert!(chats::group_from(
        &json!({"chat": {"id": "1@g.us"}, "binding": {"responderAccountId": "a"}})
    )
    .is_some());
    assert!(chats::group_from(
        &json!({"chat": {"id": "1@c.us"}, "binding": {"responderAccountId": "a"}})
    )
    .is_none());
    assert!(chats::group_from(&json!({"chat": {"id": "1@g.us"}, "binding": {}})).is_none());
}
