use super::*;
use crate::held_inputs::tests::fixture::*;
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
};
use std::io::{Read, Write};

async fn execution_read(
    state: &AppState,
    id: &str,
    run: &RunId,
    h: HeaderMap,
    fast: bool,
) -> Response {
    status_for(
        state.clone(),
        h,
        id.to_owned(),
        Ok(Query(StatusQuery {
            run_id: Some(run.clone()),
        })),
        fast,
    )
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
async fn tasks_read(state: &AppState, id: &str, run: &RunId, h: HeaderMap) -> Response {
    let uri = format!("/worker-tasks?parent_run_id={run}")
        .parse()
        .unwrap();
    crate::worker_tasks::list(
        State(state.clone()),
        h,
        Path(id.to_owned()),
        Query::try_from_uri(&uri),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
async fn body<T: serde::de::DeserializeOwned>(response: Response) -> T {
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 16_384)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mounted_routes_read_original_retired_run_and_empty_worker_history() {
    let f = retired().await;
    let run = f.expected.held[0].boundary_run_id.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::router(f.state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let id = f.conversation.to_string();
    let selected = run.to_string();
    let responses = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<String>> {
        let mut responses = Vec::new();
        for suffix in [format!("execution?run_id={selected}"), format!("worker-tasks?parent_run_id={selected}")] {
            let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            stream.set_write_timeout(Some(Duration::from_secs(5)))?;
            write!(stream, "GET /api/v2/conversations/{id}/{suffix} HTTP/1.1\r\nHost: {AUTHORITY}\r\nCookie: orkestr_v2_session={COOKIE}\r\nConnection: close\r\n\r\n")?;
            let mut response = String::new();
            stream.read_to_string(&mut response)?;
            responses.push(response);
        }
        Ok(responses)
    }).await;
    server.abort();
    let _ = server.await;
    let responses = responses.unwrap().unwrap();
    let values: Vec<serde_json::Value> = responses
        .iter()
        .map(|response| {
            let (head, body) = response.split_once("\r\n\r\n").unwrap();
            assert!(head.starts_with("HTTP/1.1 200 "), "{head}");
            serde_json::from_str(body).unwrap()
        })
        .collect();
    let status: ExecutionStatus = serde_json::from_value(values[0].clone()).unwrap();
    assert_eq!(status.run_id, Some(run.clone()));
    assert_eq!(status.phase, ExecutionPhase::Cancelled);
    assert!(!status.capabilities.stop && !status.capabilities.steer);
    assert!(status.acceptance_candidate.is_none());
    let tasks: WorkerTaskList = serde_json::from_value(values[1].clone()).unwrap();
    assert_eq!(tasks.parent_run_id, run);
    assert!(tasks.tasks.is_empty() && !tasks.can_create);
    assert_eq!(page(&f.state, &f.conversation).await.held, f.expected.held);
    assert!(f.root.0.is_dir());
    f.state.store.close().await;
}

#[tokio::test]
async fn newer_scope_keeps_old_history_readable_without_live_controls() {
    let f = retired().await;
    let run = f.expected.held[0].boundary_run_id.clone();
    let new_machine = "d".repeat(64);
    f.state
        .store
        .save_session(&new_machine, &f.owner)
        .await
        .unwrap();
    let newer = f
        .state
        .store
        .authorize_supervisor(
            &new_machine,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-held-fixture".into(),
                supervisor_key: "different-history-supervisor".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    assert!(newer
        .execution_run_status_authenticated(&format!("browser:{COOKIE}"), &f.conversation, &run)
        .await
        .unwrap()
        .is_none());
    let state = state(f.state.store.clone())
        .with_execution_store(f.owner.clone(), f.conversation.clone(), newer)
        .unwrap();
    let status: ExecutionStatus = body(
        execution_read(
            &state,
            &f.conversation.to_string(),
            &run,
            headers(Some(COOKIE), AUTHORITY),
            false,
        )
        .await,
    )
    .await;
    assert_eq!(status.run_id, Some(run.clone()));
    assert_eq!(status.phase, ExecutionPhase::Cancelled);
    assert!(!status.capabilities.stop && !status.capabilities.steer);
    let tasks: WorkerTaskList = body(
        tasks_read(
            &state,
            &f.conversation.to_string(),
            &run,
            headers(Some(COOKIE), AUTHORITY),
        )
        .await,
    )
    .await;
    assert!(!tasks.can_create && tasks.tasks.is_empty());
    f.state.store.close().await;
}

#[tokio::test]
async fn historical_routes_keep_current_browser_scope_and_role_refusals() {
    let f = retired().await;
    let id = f.conversation.to_string();
    let run = &f.expected.held[0].boundary_run_id;
    for (h, expected) in [
        (headers(None, AUTHORITY), StatusCode::UNAUTHORIZED),
        (
            headers(Some(&"b".repeat(64)), AUTHORITY),
            StatusCode::UNAUTHORIZED,
        ),
        (
            headers(Some(COOKIE), "foreign.invalid"),
            StatusCode::FORBIDDEN,
        ),
    ] {
        assert_eq!(
            execution_read(&f.state, &id, run, h.clone(), false)
                .await
                .status(),
            expected
        );
        assert_eq!(tasks_read(&f.state, &id, run, h).await.status(), expected);
    }
    for (id, selected) in [
        (Uuid::new_v4().to_string(), run.clone()),
        (id.clone(), RunId(Uuid::new_v4())),
    ] {
        assert_eq!(
            execution_read(
                &f.state,
                &id,
                &selected,
                headers(Some(COOKIE), AUTHORITY),
                false
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            tasks_read(&f.state, &id, &selected, headers(Some(COOKIE), AUTHORITY))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        execution_read(&f.state, &id, run, headers(Some(COOKIE), AUTHORITY), true)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    f.state
        .store
        .revoke_session(&format!("browser:{COOKIE}"))
        .await
        .unwrap();
    assert_eq!(
        execution_read(&f.state, &id, run, headers(Some(COOKIE), AUTHORITY), false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        tasks_read(&f.state, &id, run, headers(Some(COOKIE), AUTHORITY))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    f.state.store.close().await;
}

#[tokio::test]
async fn historical_reads_do_not_enable_worker_creation_or_stop() {
    use sha2::{Digest, Sha256};
    let f = retired().await;
    let run = f.expected.held[0].boundary_run_id.clone();
    let id = f.conversation.to_string();
    let status: ExecutionStatus =
        body(execution_read(&f.state, &id, &run, headers(Some(COOKIE), AUTHORITY), false).await)
            .await;
    let mut h = headers(Some(COOKIE), AUTHORITY);
    h.insert("origin", format!("http://{AUTHORITY}").parse().unwrap());
    h.insert(
        "x-orkestr-csrf",
        format!(
            "{:x}",
            Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{COOKIE}").as_bytes())
        )
        .parse()
        .unwrap(),
    );
    let request = WorkerTaskCreateRequest {
        parent_run_id: run.clone(),
        expected_control_revision: status.control_revision.unwrap(),
        request_key: "no-history-creation".into(),
        title: "Synthetic task".into(),
        instructions: "Synthetic instructions".into(),
        lifetime_ms: 30_000,
        execution_budget_ms: None,
    };
    assert!(request.is_valid());
    let response = crate::worker_tasks::create(
        State(f.state.clone()),
        h.clone(),
        Path(id.clone()),
        Ok(Json(request)),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let response = super::stop(
        State(f.state.clone()),
        h,
        Path(id.clone()),
        Ok(Json(ExecutionControlRequest {
            run_id: run.clone(),
            expected_revision: status.revision,
            expected_control_revision: status.control_revision,
            request_key: "no-history-stop".into(),
        })),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let after: ExecutionStatus =
        body(execution_read(&f.state, &id, &run, headers(Some(COOKIE), AUTHORITY), false).await)
            .await;
    assert_eq!(after.revision, status.revision);
    assert_eq!(after.control_revision, status.control_revision);
    assert_eq!(after.phase, ExecutionPhase::Cancelled);
    let tasks: WorkerTaskList =
        body(tasks_read(&f.state, &id, &run, headers(Some(COOKIE), AUTHORITY)).await).await;
    assert!(!tasks.can_create && tasks.tasks.is_empty());
    f.state.store.close().await;
}
