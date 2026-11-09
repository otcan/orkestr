//! Actual authenticated HTTP comparisons; no manager/provider starts.
use super::*;
use crate::window_runtime::{
    handles::Handles, initial::InitialAuthority, manager_client::ManagerClient, Controller,
};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{
    ConversationInput, ExecutionWindowRequest, MessageInput, QueuedWindowWithdrawal,
};
use std::{sync::Arc, time::Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn configured() -> crate::conversation_resources_http::tests::Case {
    let mut f = case().await;
    let owner = f
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let config: crate::beta_config::BetaConfig = serde_json::from_value(json!({
        "schema_version":1,"owner_id":owner,"conversation_id":f.conversation,
        "manager_socket":f.root.join("absent.sock"),"launcher":"/opt/synthetic/launcher",
        "launcher_sha256":"a".repeat(64),"workspace":"/srv/synthetic/workspace",
        "namespace":"synthetic-native","supervisor_key":"synthetic-supervisor","max_active_windows":8,
    })).unwrap();
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
    let parent = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let manager = ManagerClient::new(
        config.manager_socket.clone(),
        owner.clone(),
        f.conversation.clone(),
        parent,
    )
    .unwrap();
    f.state.window_controller = Some(Arc::new(
        Controller::new(
            config.clone(),
            f.root.clone(),
            f.state.store.clone(),
            Arc::new(InitialAuthority::new(&config).unwrap()),
            Handles::new(owner, f.conversation.clone()).unwrap(),
            manager,
        )
        .unwrap(),
    ));
    f
}

fn normalized(mut value: Value) -> Value {
    if let Some(body) = value.get_mut("body").and_then(Value::as_object_mut) {
        // Read-time observations may advance; durable progress timestamps stay.
        body.remove("observed_at_ms");
        body.remove("queue_age_ms");
    }
    value
}

#[tokio::test]
async fn configured_batch_matches_individuals_and_refreshes_after_queue_changes() {
    let f = configured().await;
    let credential = format!("browser:{}", f.cookie);
    let cookie = format!("Cookie: orkestr_v2_session={}", f.cookie);
    let owner = f
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let message = f
        .state
        .store
        .admit(
            &owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "status-http-input".into(),
                text: "Synthetic input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let request = ExecutionWindowRequest {
        request_key: "status-http-window".into(),
        input_message_id: message.message_id,
        input_event_id: message.event_id,
        input_request_key: "status-http-input".into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    f.state
        .store
        .enqueue_execution_window_authenticated(&credential, &f.conversation, &request)
        .await
        .unwrap();
    let missing = Uuid::new_v4().to_string();
    let path = format!(
        "/api/v2/conversation-status?ids={},{}",
        f.conversation, missing
    );
    let (status, page) = send(&f.state, "GET", &path, &[&cookie], "").await;
    assert_eq!(status, 200, "{page}");
    for (row, id) in page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .zip([f.conversation.to_string(), missing])
    {
        for (field, suffix) in [("execution", "execution"), ("queue", "window/queue")] {
            let (status, body) = send(
                &f.state,
                "GET",
                &format!("/api/v2/conversations/{id}/{suffix}"),
                &[&cookie],
                "",
            )
            .await;
            assert_eq!(
                normalized(row[field].clone()),
                normalized(json!({"status":status,"body":body})),
                "{field}"
            );
        }
    }
    assert_eq!(page["rows"][0]["queue"]["body"]["queued_total"], 1);
    f.state
        .store
        .withdraw_queued_execution_window_authenticated(
            &credential,
            &f.conversation,
            &request.request_key,
            QueuedWindowWithdrawal::InputUnavailable,
        )
        .await
        .unwrap();
    let (_, next) = send(&f.state, "GET", &path, &[&cookie], "").await;
    assert_eq!(next["rows"][0]["queue"]["body"]["queued_total"], 0);
    f.state.store.revoke_session(&credential).await.unwrap();
    assert_eq!(send(&f.state, "GET", &path, &[&cookie], "").await.0, 401);
    f.finish().await;
}

async fn legacy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Ids>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let mut rows = Vec::new();
    for id in parse_ids(&query.ids)? {
        let execution = row(execution::status(
            State(state.clone()),
            headers.clone(),
            axum::extract::Path(id.clone()),
            Ok(Query(execution::StatusQuery::default())),
        )
        .await)
        .await;
        let queue = row(window_http::queue(
            State(state.clone()),
            headers.clone(),
            axum::extract::Path(id.clone()),
        )
        .await)
        .await;
        rows.push(json!({"id":id,"execution":execution,"queue":queue}));
    }
    Ok(Json(json!({"rows":rows})).into_response())
}

async fn http(app: Router, path: &str, cookie: &str) -> (u16, Value, u128) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let started = Instant::now();
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:19882\r\nCookie: orkestr_v2_session={cookie}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    socket.read_to_end(&mut raw).await.unwrap();
    let elapsed = started.elapsed().as_micros();
    let split = raw.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
    let status = std::str::from_utf8(&raw[..split])
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let body = serde_json::from_slice(&raw[split + 4..]).unwrap();
    let _ = stop.send(());
    server.await.unwrap();
    (status, body, elapsed)
}

#[tokio::test]
async fn http_width_benchmark_preserves_all_rows_without_a_timing_assertion() {
    let f = configured().await;
    let credential = format!("browser:{}", f.cookie);
    let mut ids = vec![f.conversation.to_string()];
    for n in 1..50 {
        ids.push(
            f.state
                .store
                .create_conversation_authenticated(
                    &credential,
                    &ConversationInput {
                        client_request_id: format!("http-batch-{n}"),
                        name: format!("Synthetic {n}"),
                    },
                )
                .await
                .unwrap()
                .0
                .conversation_id
                .to_string(),
        );
    }
    for width in [1, 10, 50] {
        let path = format!("/api/v2/conversation-status?ids={}", ids[..width].join(","));
        let old = Router::new()
            .route("/api/v2/conversation-status", get(legacy))
            .with_state(f.state.clone());
        let new = Router::new()
            .route("/api/v2/conversation-status", get(read))
            .with_state(f.state.clone());
        let (old_status, old_body, old_us) = http(old, &path, &f.cookie).await;
        let (new_status, new_body, new_us) = http(new, &path, &f.cookie).await;
        assert_eq!(old_status, 200);
        assert_eq!(new_status, 200);
        assert_eq!(old_body, new_body);
        println!("STATUS_BATCH_HTTP width={width} legacy_us={old_us} batch_us={new_us}");
    }
    f.finish().await;
}
