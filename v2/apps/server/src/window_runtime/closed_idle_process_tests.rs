//! Independent Store process-boundary oracle with ordinary browser auth handlers.
//! Core 16e8d977; Runtime registers this test-only leaf. No listener/provider starts.
use crate::{auth, browser, AppState};
use axum::{
    body::to_bytes,
    extract::State,
    http::{header, HeaderMap, Method},
    response::IntoResponse,
    Json,
};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use std::{
    path::Path,
    process::Command,
    time::{Duration, Instant},
};
use uuid::Uuid;

mod browser_fixture;
mod retirement;
use browser_fixture::{credentials, headers, login, logout};
use retirement::close;

const ORIGIN: &str = "http://synthetic.example:8090";
const SESSION: &str = "/api/v2/browser/session";
const BOOTSTRAP: &str = "synthetic-bootstrap-not-a-deployed-secret";

fn config(takeover: ProductionTakeover) -> ProductionSupervisorConfig {
    ProductionSupervisorConfig {
        provider: ProviderKind::Codex,
        namespace: "synthetic-subscription".into(),
        supervisor_key: "deep-supervisor".into(),
        takeover,
    }
}
async fn request(
    store: &Store,
    browser: &str,
    conversation: &ConversationId,
    key: &str,
    predecessor: Option<&ExecutionWindowStatus>,
) -> ExecutionWindowRequest {
    let owner = store.authenticate(browser).await.unwrap().unwrap();
    let r = store
        .admit(
            &owner,
            conversation,
            &MessageInput {
                client_message_id: key.into(),
                text: "synthetic durable input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    ExecutionWindowRequest {
        request_key: format!("window-{key}"),
        input_message_id: r.message_id,
        input_event_id: r.event_id,
        input_request_key: key.into(),
        expected_generation: predecessor.map_or(0, |p| p.generation),
        window_id: None,
        predecessor_window_id: predecessor.map(|p| p.window_id),
    }
}

#[test]
fn closed_idle_fresh_login_after_exec() {
    pair(false);
}
#[test]
fn active_loss_fresh_login_after_exec_refuses() {
    pair(true);
}

fn pair(active: bool) {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("independent-browser-cold-{}", Uuid::new_v4()));
    let filter = format!("{}::child", module_path!().split_once("::").unwrap().1);
    for phase in ["seed", "replace"] {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &filter, "--nocapture"])
            .env_clear()
            .env("ORKESTR_V2_HOME", &root)
            .env("BETA_INDEPENDENT_PHASE", phase)
            .env("BETA_INDEPENDENT_ACTIVE", if active { "yes" } else { "no" })
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "child failed: {phase}");
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("child timeout: {phase}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child() {
    let Ok(phase) = std::env::var("BETA_INDEPENDENT_PHASE") else {
        return;
    };
    println!("BETA_INDEPENDENT_CHILD|{}|{}", phase, std::process::id());
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    let active = std::env::var("BETA_INDEPENDENT_ACTIVE").unwrap() == "yes";
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let state = AppState::new(store.clone(), BOOTSTRAP.into(), ORIGIN.into()).unwrap();
    match phase.as_str() {
        "seed" => seed(&root, state, active).await,
        "replace" => replace(&root, state, active).await,
        _ => panic!("unknown phase"),
    }
}

async fn seed(root: &Path, state: AppState, active: bool) {
    let mut h = headers();
    h.insert("x-orkestr-bootstrap", BOOTSTRAP.parse().unwrap());
    let response = auth::setup(State(state.clone()), h, Ok(Json(credentials())))
        .await
        .unwrap_or_else(|_| panic!("ordinary setup refused"))
        .into_response();
    let setup: SetupResponse =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    let conv = setup.global_conversation_id;
    let h = login(&state).await;
    let browser = browser::credential(&h).unwrap_or_else(|_| panic!("cookie refused"));
    let owner = state.store.authenticate(&browser).await.unwrap().unwrap();
    let initial = state
        .store
        .bootstrap_execution_window_authenticated(
            &browser,
            &conv,
            config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let req = request(&state.store, &browser, &conv, "original-input", None).await;
    let a = state
        .store
        .admit_execution_window_authenticated(&browser, &conv, &req)
        .await
        .unwrap();
    let cap = initial
        .store()
        .issue_execution_window_credential(
            initial.credential(),
            a.status.window_id,
            a.status.generation,
            "seed-boot",
            a.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    let bound = initial
        .store()
        .bind_execution_window(initial.credential(), &cap)
        .await
        .unwrap();
    let binding = initial.binding();
    let metadata = bound.authorize_session_metadata(binding).await.unwrap();
    let transition = bound
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
                native_session_id: "synthetic-modeled-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "synthetic-ready".into(),
            },
        )
        .await
        .unwrap();
    bound
        .activate_execution_window(
            cap.credential(),
            a.status.window_id,
            a.status.generation,
            "seed-boot",
        )
        .await
        .unwrap();
    if !active {
        close(
            &bound,
            &state.store,
            &browser,
            &owner,
            &conv,
            transition.binding(),
            cap.credential(),
            &a.status,
        )
        .await;
    }
    // Only public coordinates cross the process boundary. No cookie/token/issuer/reap object.
    std::fs::write(
        root.join("coordinates.json"),
        serde_json::to_vec(&(conv, req, std::process::id())).unwrap(),
    )
    .unwrap();
    logout(&state, h).await;
    assert!(state.store.authenticate(&browser).await.unwrap().is_none());
}

async fn replace(root: &Path, state: AppState, active: bool) {
    let (conv, original, seed_pid): (ConversationId, ExecutionWindowRequest, u32) =
        serde_json::from_slice(&std::fs::read(root.join("coordinates.json")).unwrap()).unwrap();
    assert_ne!(seed_pid, std::process::id());
    let h = login(&state).await;
    let browser = browser::credential(&h).unwrap_or_else(|_| panic!("fresh cookie refused"));
    let before = state
        .store
        .execution_window_status_authenticated(&browser, &conv)
        .await
        .unwrap()
        .unwrap();
    if active {
        assert_eq!(before.state, ExecutionWindowState::Active);
        assert!(state
            .store
            .recover_retired_execution_window_authenticated(
                &browser,
                &conv,
                config(ProductionTakeover::First)
            )
            .await
            .is_err());
        let reconciled = state
            .store
            .reconcile_execution_window_authenticated(
                &browser,
                &conv,
                before.window_id,
                before.generation,
            )
            .await
            .unwrap();
        assert_eq!(
            reconciled.state,
            ExecutionWindowState::ReconciliationRequired
        );
        let req = request(
            &state.store,
            &browser,
            &conv,
            "fresh-after-loss",
            Some(&before),
        )
        .await;
        assert_ne!(req.input_message_id, original.input_message_id);
        assert_ne!(req.input_event_id, original.input_event_id);
        let snapshot = state
            .store
            .execution_window_status_authenticated(&browser, &conv)
            .await
            .unwrap();
        assert!(matches!(
            state
                .store
                .admit_execution_window_authenticated(&browser, &conv, &req)
                .await,
            Err(RuntimeStoreError::Fenced)
        ));
        assert!(state
            .store
            .recover_retired_execution_window_authenticated(
                &browser,
                &conv,
                config(ProductionTakeover::First)
            )
            .await
            .is_err());
        assert!(state
            .store
            .bootstrap_execution_window_authenticated(
                &browser,
                &conv,
                config(ProductionTakeover::First)
            )
            .await
            .is_err());
        assert_eq!(
            state
                .store
                .execution_window_status_authenticated(&browser, &conv)
                .await
                .unwrap(),
            snapshot
        );
    } else {
        assert_eq!(before.state, ExecutionWindowState::Closed);
        let recovered = state
            .store
            .recover_retired_execution_window_authenticated(
                &browser,
                &conv,
                config(ProductionTakeover::First),
            )
            .await
            .unwrap();
        let req = request(
            &state.store,
            &browser,
            &conv,
            "fresh-after-close",
            Some(&before),
        )
        .await;
        assert_ne!(req.input_message_id, original.input_message_id);
        assert_ne!(req.input_event_id, original.input_event_id);
        let next = state
            .store
            .admit_execution_window_authenticated(&browser, &conv, &req)
            .await
            .unwrap();
        assert_eq!(next.status.generation, before.generation + 1);
        assert_ne!(next.status.window_id, before.window_id);
        assert!(state
            .store
            .recover_retired_execution_window_authenticated(
                &browser,
                &conv,
                config(ProductionTakeover::First)
            )
            .await
            .is_err());
        let issued = recovered
            .store()
            .issue_idle_execution_window_credential_authenticated(
                &browser,
                next.status.window_id,
                next.status.generation,
                "replacement-boot",
                next.status.expires_at_ms,
                &"b".repeat(64),
            )
            .await
            .unwrap();
        assert!(recovered
            .store()
            .issue_idle_execution_window_credential_authenticated(
                &browser,
                next.status.window_id,
                next.status.generation,
                "replacement-boot",
                next.status.expires_at_ms,
                &"b".repeat(64)
            )
            .await
            .is_err());
        let (bound, metadata) = state
            .store
            .reattach_terminal_supervisor(
                issued.credential(),
                config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: recovered.predecessor_incarnation().into(),
                }),
                recovered.prior_run_id(),
            )
            .await
            .unwrap();
        assert_eq!(
            metadata.binding().native_session_id,
            recovered.binding().native_session_id
        );
        bound
            .activate_execution_window(
                issued.credential(),
                next.status.window_id,
                next.status.generation,
                "replacement-boot",
            )
            .await
            .unwrap();
        let after = state
            .store
            .execution_window_status_authenticated(&browser, &conv)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.state, ExecutionWindowState::Active);
        assert_eq!(after.expires_at_ms, next.status.expires_at_ms);
        assert_eq!(after.limits, next.status.limits);
    }
    logout(&state, h).await;
}
