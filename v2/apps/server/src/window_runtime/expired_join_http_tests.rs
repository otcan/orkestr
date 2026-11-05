//! Definite read-only fences differ from uncertain storage or delivery.
use super::*;
use crate::held_inputs::tests::fixture::{headers, state, AUTHORITY, COOKIE};
use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use orkestr_v2_contracts::ExecutionWindowAdmission;
use sha2::{Digest, Sha256};
async fn http_state(f: &Fixture) -> crate::AppState {
    f.store
        .save_session(&format!("browser:{COOKIE}"), &f.owner)
        .await
        .unwrap();
    let mut state = state(f.store.clone());
    state.window_controller = Some(Arc::new(f.controller(8)));
    state
}
async fn call(
    state: &crate::AppState,
    conversation: &ConversationId,
    input: ExecutionWindowRequest,
) -> Response {
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
    crate::window_http::admit(
        State(state.clone()),
        h,
        Path(conversation.to_string()),
        Ok(Json(input)),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
fn sql(f: &Fixture, statement: &str, args: serde_json::Value) -> serde_json::Value {
    let out=std::process::Command::new("python3").args(["-I","-S","-B","-c",
        "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); rows=c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall(); c.commit(); print(json.dumps(rows))"])
        .arg(f.root.join("core.sqlite3")).arg(statement).arg(args.to_string()).env("PYTHONDONTWRITEBYTECODE","1").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
fn expire(f: &Fixture, id: &str) {
    sql(
        f,
        "UPDATE execution_windows SET state='closed',opened_at_ms=1,work_deadline_ms=870001,expires_at_ms=900001 WHERE id=?",
        serde_json::json!([id]),
    );
}
fn counts(f: &Fixture, event: &str) -> serde_json::Value {
    sql(f,"SELECT (SELECT count(*) FROM execution_window_inputs WHERE event_id=?1),(SELECT count(*) FROM execution_window_queue WHERE event_id=?1),(SELECT count(*) FROM production_runs WHERE event_id=?1)",serde_json::json!([event]))
}
#[tokio::test]
async fn expired_join_is_definite_http409_without_window_or_run_admission() {
    let f = fixture().await;
    let c = f.conversation("expired-join").await;
    let old = f.occupy(&c, "old").await;
    let mut input = f.request(&c, "expired-followup").await;
    input.window_id = Some(old.window_id);
    input.expected_generation = old.generation;

    expire(&f, &old.window_id.to_string());
    let state = http_state(&f).await;
    let event = input.input_event_id.to_string();
    for _ in 0..2 {
        let reply = call(&state, &c, input.clone()).await;
        assert_eq!(reply.status(), axum::http::StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(reply.into_body(), 8192).await.unwrap();
        assert!(std::str::from_utf8(&bytes)
            .unwrap()
            .contains("window_fenced"));
        assert_eq!(counts(&f, &event), serde_json::json!([[0, 0, 0]]));
    }
    assert!(state
        .window_controller
        .as_ref()
        .unwrap()
        .existing(&c)
        .is_none());
    assert_eq!(
        sql(
            &f,
            "SELECT state FROM reasoning_inbox WHERE event_id=?",
            serde_json::json!([event])
        ),
        serde_json::json!([["queued"]])
    );
    // Losing the retirement proof store is uncertainty, never safe settlement.
    sql(
        &f,
        "DROP TABLE owner_input_retirements",
        serde_json::json!([]),
    );
    assert_eq!(
        call(&state, &c, input).await.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
}
#[tokio::test]
async fn committed_duplicate_keeps_original_receipt_without_new_execution() {
    let f = fixture().await;
    let c = f.conversation("committed").await;
    let input = f.request(&c, "committed").await;
    let old = f
        .store
        .admit_execution_window_capped_authenticated(BROWSER, &c, &input, 8)
        .await
        .unwrap();

    expire(&f, &old.status.window_id.to_string());
    let state = http_state(&f).await;
    for _ in 0..2 {
        let reply = call(&state, &c, input.clone()).await;
        assert_eq!(reply.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(reply.into_body(), 8192).await.unwrap();
        let receipt: ExecutionWindowAdmission = serde_json::from_slice(&bytes).unwrap();
        assert!(receipt.duplicate);
        assert_eq!(receipt.status.window_id, old.status.window_id);
        assert_eq!(
            counts(&f, &input.input_event_id.to_string()),
            serde_json::json!([[1, 0, 0]])
        );
    }
    assert!(state
        .window_controller
        .as_ref()
        .unwrap()
        .existing(&c)
        .is_none());
}
#[tokio::test]
async fn inspection_storage_failure_stays_retryable_http503() {
    let f = fixture().await;
    let c = f.conversation("storage").await;
    let input = f.request(&c, "storage").await;
    let state = http_state(&f).await;
    // Only the inspection query fails; authentication remains possible.

    sql(
        &f,
        "DROP TABLE execution_window_inputs",
        serde_json::json!([]),
    );
    let reply = call(&state, &c, input).await;
    assert_eq!(reply.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    let bytes = axum::body::to_bytes(reply.into_body(), 8192).await.unwrap();
    assert!(std::str::from_utf8(&bytes)
        .unwrap()
        .contains("window_unavailable"));
    assert!(state
        .window_controller
        .as_ref()
        .unwrap()
        .existing(&c)
        .is_none());
}

#[tokio::test]
async fn exact_retired_head_is_safe_to_refuse_before_later_input_admission() {
    let f = fixture().await;
    let c = f.conversation("retired-head").await;
    let old = f.occupy(&c, "old").await;
    let mut input = f.request(&c, "obsolete").await;
    input.window_id = Some(old.window_id);
    input.expected_generation = old.generation;

    expire(&f, &old.window_id.to_string());
    f.store
        .retire_owner_input_for_browser(
            BROWSER,
            &c,
            &input.input_message_id,
            &orkestr_v2_contracts::OwnerInputRetirementRequest {
                request_key: "retire-exact-obsolete".into(),
                reason: "Expired synthetic input; never replay".into(),
            },
        )
        .await
        .unwrap();
    let state = http_state(&f).await;
    let reply = call(&state, &c, input.clone()).await;
    assert_eq!(reply.status(), axum::http::StatusCode::CONFLICT);
    let bytes = axum::body::to_bytes(reply.into_body(), 8192).await.unwrap();
    assert!(std::str::from_utf8(&bytes)
        .unwrap()
        .contains("window_input_retired"));
    let mut foreign = input.clone();
    foreign.input_request_key = "another-original".into();
    let reply = call(&state, &c, foreign).await;
    let bytes = axum::body::to_bytes(reply.into_body(), 8192).await.unwrap();
    assert!(std::str::from_utf8(&bytes)
        .unwrap()
        .contains("window_fenced"));
    assert_eq!(
        counts(&f, &input.input_event_id.to_string()),
        serde_json::json!([[0, 0, 0]])
    );
    let mut later = f.request(&c, "later-original").await;
    later.expected_generation = old.generation;
    later.predecessor_window_id = Some(old.window_id);
    let receipt = f
        .store
        .admit_execution_window_capped_authenticated(BROWSER, &c, &later, 8)
        .await
        .unwrap();
    assert_ne!(receipt.status.window_id, old.window_id);
    assert_eq!(receipt.input_event_id, later.input_event_id);
    assert_eq!(
        sql(
            &f,
            "SELECT state FROM reasoning_inbox WHERE event_id=?",
            serde_json::json!([input.input_event_id.to_string()])
        ),
        serde_json::json!([["retired"]])
    );
    assert_eq!(
        counts(&f, &input.input_event_id.to_string()),
        serde_json::json!([[0, 0, 0]])
    );
}
