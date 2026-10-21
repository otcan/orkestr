use super::*;
use axum::body::to_bytes;
use sha2::{Digest, Sha256};

/// Synthetic generator output, including transcript paths that must never leave the server.
fn synthetic(remote_thread: &str) -> serde_json::Value {
    serde_json::json!({
        "generatedAt": "2026-01-02T03:04:05.678901+00:00",
        "views": [{
            "view": "whatsapp-group",
            "name": "Synthetic group",
            "chatId": "000000000000000000@g.us",
            "threadId": "thread-synthetic-1",
            "fastLayer": "V1 thread executor (Codex)",
            "delegatedToV2": {"remoteBackend": "v2", "remoteThreadId": remote_thread, "remoteRuntimeEnabled": true},
            "futureField": {"ignored": true},
            "sessions": [{
                "sessionId": "session-synthetic-1",
                "kind": "claude-code",
                "role": "attached",
                "live": true,
                "lastActivity": "2026-01-02T03:04:00+00:00",
                "transcript": "/synthetic/secret/transcript.jsonl",
                "agents": [{
                    "agentId": "a0001",
                    "name": "synthetic agent",
                    "status": "running",
                    "startedAt": "2026-01-02T03:00:00Z",
                    "lastActivity": null,
                    "transcript": "/synthetic/secret/subagents/agent-a0001.jsonl"
                }]
            }, {
                "sessionId": "session-synthetic-2",
                "kind": "unknown",
                "role": "attached",
                "live": false,
                "lastActivity": null,
                "transcript": null
            }]
        }, {
            "view": "whatsapp-group",
            "name": null,
            "chatId": "000000000000000001@g.us",
            "threadId": "thread-synthetic-2",
            "fastLayer": "V1 thread executor (Codex)",
            "delegatedToV2": null,
            "sessions": []
        }]
    })
}

fn temp() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("live-map-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    root
}

#[test]
fn parses_generator_schema_and_strips_transcripts() {
    let (generated, views) = parse(synthetic("not-a-uuid").to_string().as_bytes()).unwrap();
    assert_eq!(
        generated,
        Some(timestamp_ms("2026-01-02T03:04:05.678Z").unwrap())
    );
    assert_eq!(views.len(), 2);
    let session = &views[0].sessions[0];
    assert!(session.live);
    assert_eq!(session.kind, "claude-code");
    assert_eq!(session.agents[0].status, "running");
    assert_eq!(session.agents[0].last_activity_ms, None);
    assert_eq!(views[0].sessions[1].last_activity_ms, None);
    assert_eq!(views[1].name, None);
    let encoded = serde_json::to_string(&views).unwrap();
    assert!(!encoded.contains("transcript"), "{encoded}");
    assert!(!encoded.contains("/synthetic/secret"), "{encoded}");
    assert!(!encoded.contains("futureField"));
}

#[test]
fn rejects_malformed_and_out_of_bounds_documents() {
    for bad in [
        "".to_string(),
        "{".to_string(),
        "[]".to_string(),
        r#"{"views":{}}"#.to_string(),
        r#"{"views":[{"name":"missing view kind"}]}"#.to_string(),
        r#"{"views":[{"view":"x","sessions":[{"agents":[{"name":"no id"}]}]}]}"#.to_string(),
        format!(
            r#"{{"views":[{{"view":"{}"}}]}}"#,
            "x".repeat(LIVE_MAP_MAX_TEXT + 1)
        ),
        r#"{"views":[{"view":"x","chatId":"line\nbreak"}]}"#.to_string(),
    ] {
        assert!(parse(bad.as_bytes()).is_none(), "accepted {bad:?}");
    }
    let too_many =
        serde_json::json!({"views": vec![serde_json::json!({"view":"x"}); LIVE_MAP_MAX_VIEWS + 1]});
    assert!(parse(too_many.to_string().as_bytes()).is_none());
    let sessions = vec![serde_json::json!({"sessionId":"s"}); LIVE_MAP_MAX_SESSIONS + 1];
    let too_many = serde_json::json!({"views":[{"view":"x","sessions":sessions}]});
    assert!(parse(too_many.to_string().as_bytes()).is_none());
    // Free-text names are bounded and cleaned rather than refusing the map.
    let long = format!(
        r#"{{"views":[{{"view":"x","name":"a\nb{}"}}]}}"#,
        "y".repeat(600)
    );
    let name = parse(long.as_bytes()).unwrap().1[0].name.clone().unwrap();
    assert_eq!(name.chars().count(), LIVE_MAP_MAX_TEXT);
    assert!(name.starts_with("a b"));
    // An empty generator run is a valid, empty map.
    assert_eq!(parse(br#"{"views":[]}"#).unwrap().1.len(), 0);
}

#[test]
fn file_reads_report_missing_unreadable_too_large_and_invalid() {
    let root = temp();
    let missing = read_host(&root.join("absent.json"), MAX_FILE_BYTES);
    assert_eq!(missing.status, HostLiveMapStatus::Missing);
    assert_eq!(
        read_host(&root, MAX_FILE_BYTES).status,
        HostLiveMapStatus::Unreadable
    );
    let file = root.join("map.json");
    let body = synthetic("x").to_string();
    std::fs::write(&file, &body).unwrap();
    let ready = read_host(&file, MAX_FILE_BYTES);
    assert_eq!(ready.status, HostLiveMapStatus::Ready);
    assert!(ready.modified_at_ms.is_some());
    assert_eq!(ready.views.len(), 2);
    let capped = read_host(&file, body.len() as u64 - 1);
    assert_eq!(capped.status, HostLiveMapStatus::TooLarge);
    assert!(capped.views.is_empty());
    assert_eq!(
        read_host(&file, body.len() as u64).status,
        HostLiveMapStatus::Ready
    );
    std::fs::write(&file, b"not json").unwrap();
    assert_eq!(
        read_host(&file, MAX_FILE_BYTES).status,
        HostLiveMapStatus::Invalid
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn timestamps_accept_python_isoformat_and_rfc3339_only() {
    assert_eq!(timestamp_ms("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(timestamp_ms("1970-01-01T01:00:00+01:00"), Some(0));
    assert_eq!(
        timestamp_ms("2000-03-01T00:00:00.5Z"),
        Some(951_868_800_500)
    );
    assert_eq!(
        timestamp_ms("2026-10-20T16:21:55.833973+00:00"),
        Some(1_792_513_315_833)
    );
    for bad in [
        "",
        "yesterday",
        "2026-13-01T00:00:00Z",
        "2026-01-01T00:00:00",
        "2026-01-01T00:00:00.Z",
        "2026-01-01T00:00:00+0100",
    ] {
        assert_eq!(timestamp_ms(bad), None, "{bad}");
    }
}

#[tokio::test]
async fn startup_path_must_be_absolute() {
    let (root, state, _) = fixture().await;
    assert!(state
        .clone()
        .with_live_map_file(Path::new("relative/map.json"))
        .is_err());
    assert!(state
        .clone()
        .with_live_map_file(Path::new("/var/lib/../map.json"))
        .is_err());
    assert!(state
        .clone()
        .with_live_map_file(Path::new("/var/lib/synthetic/map.json"))
        .is_ok());
    state.store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

async fn fixture() -> (std::path::PathBuf, AppState, HeaderMap) {
    let root = temp();
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
    let cookie = "c".repeat(64);
    store
        .save_session(&format!("browser:{cookie}"), &owner)
        .await
        .unwrap();
    let state = AppState::new(store, "b".repeat(64), "http://127.0.0.1:19881".into()).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:19881".parse().unwrap());
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

async fn body(response: Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), MAX_FILE_BYTES as usize)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn endpoint_is_off_until_configured_and_owner_only() {
    let (root, state, headers) = fixture().await;
    let error = read(State(state.clone()), headers.clone())
        .await
        .unwrap_err();
    assert_eq!(
        (error.0, error.1),
        (StatusCode::NOT_FOUND, "live_map_unconfigured")
    );
    let state = state.with_live_map_file(&root.join("map.json")).unwrap();
    let mut anonymous = headers.clone();
    anonymous.remove("cookie");
    assert_eq!(
        read(State(state.clone()), anonymous).await.unwrap_err().0,
        StatusCode::UNAUTHORIZED
    );
    let mut machine = headers.clone();
    machine.insert("authorization", "Bearer synthetic".parse().unwrap());
    assert!(read(State(state.clone()), machine).await.is_err());
    // Configured but not yet generated: native state still served.
    let (status, map) = body(
        read(State(state.clone()), headers)
            .await
            .unwrap_or_else(|e| panic!("{}", e.2)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(map["host"]["status"], "missing");
    assert_eq!(map["schema_version"], 1);
    assert!(map["conversations"].is_array());
    state.store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn endpoint_links_delegated_view_and_never_serves_transcripts() {
    let (root, state, headers) = fixture().await;
    let created = state
        .store
        .create_conversation_authenticated(
            &browser::credential(&headers).unwrap_or_else(|e| panic!("{}", e.2)),
            &ConversationInput {
                client_request_id: "live-map-synthetic".into(),
                name: "Synthetic delegated".into(),
            },
        )
        .await
        .unwrap()
        .0;
    let file = root.join("map.json");
    std::fs::write(
        &file,
        synthetic(&created.conversation_id.to_string()).to_string(),
    )
    .unwrap();
    let state = state.with_live_map_file(&file).unwrap();
    let response = read(State(state.clone()), headers.clone())
        .await
        .unwrap_or_else(|e| panic!("{}", e.2));
    let (status, map) = body(response).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: LiveMap = serde_json::from_value(map.clone()).unwrap();
    assert!(parsed.is_valid());
    assert_eq!(parsed.host.status, HostLiveMapStatus::Ready);
    assert_eq!(
        parsed.host.views[0]
            .delegated_to_v2
            .as_ref()
            .unwrap()
            .conversation_id,
        Some(created.conversation_id.clone())
    );
    let native = parsed
        .conversations
        .iter()
        .find(|c| c.conversation_id == created.conversation_id)
        .unwrap();
    assert_eq!(native.name, "Synthetic delegated");
    assert!(native.window.is_none() && native.workers.is_empty());
    let encoded = map.to_string();
    assert!(!encoded.contains("transcript") && !encoded.contains("/synthetic/secret"));
    // A remote thread that is not this owner's conversation is never linked.
    std::fs::write(&file, synthetic(&Uuid::new_v4().to_string()).to_string()).unwrap();
    let (_, map) = body(
        read(State(state.clone()), headers)
            .await
            .unwrap_or_else(|e| panic!("{}", e.2)),
    )
    .await;
    assert!(map["host"]["views"][0]["delegated_to_v2"]["conversation_id"].is_null());
    state.store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cached_host_map_follows_replaced_files() {
    let root = std::env::temp_dir().join(format!("live-map-cache-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("map.json");
    let write = |name: &str| {
        let next = root.join("map.json.next");
        std::fs::write(
            &next,
            serde_json::json!({"generatedAt": "2026-01-03T00:00:00Z",
                "views": [{"view": "synthetic", "name": name}]})
            .to_string(),
        )
        .unwrap();
        std::fs::rename(&next, &path).unwrap();
    };
    write("first");
    let first = read_host_cached(&path, MAX_FILE_BYTES);
    assert_eq!(first.views[0].name.as_deref(), Some("first"));
    assert_eq!(read_host_cached(&path, MAX_FILE_BYTES), first);
    write("second");
    assert_eq!(
        read_host_cached(&path, MAX_FILE_BYTES).views[0]
            .name
            .as_deref(),
        Some("second")
    );
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        read_host_cached(&path, MAX_FILE_BYTES).status,
        HostLiveMapStatus::Missing
    );
    std::fs::remove_dir_all(root).unwrap();
}
