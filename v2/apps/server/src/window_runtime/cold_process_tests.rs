//! Independent Rust-process replacement at the committed Store seam.
//! This is not manager/start-service or HTTP mounting qualification.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ExecutionWindowRequest, ExecutionWindowState, MessageInput};
use orkestr_v2_store_sqlite::Store;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[tokio::test]
#[ignore = "invoked only by the finite parent process oracle"]
async fn cold_process_child() {
    let root = PathBuf::from(std::env::var_os("ORKESTR_BETA_COLD_FIXTURE").unwrap());
    let store = Store::open(&root.join("state.sqlite3")).await.unwrap();
    if std::env::var("ORKESTR_BETA_COLD_MODE").unwrap() == "original" {
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        store
            .save_session("synthetic-browser", &owner)
            .await
            .unwrap();
        // Deployed first-login path: browser session only, no machine token file
        // or synthetic machine save_session. Native metadata follows private bind.
        let initial = store
            .bootstrap_execution_window_authenticated(
                "synthetic-browser",
                &conversation,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "synthetic-window".into(),
                    supervisor_key: "synthetic-deep".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let binding = initial.binding().clone();
        let input = store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "synthetic-input".into(),
                    text: "synthetic payload".into(),
                },
            )
            .await
            .unwrap()
            .receipt;
        let request = ExecutionWindowRequest {
            request_key: "synthetic-window".into(),
            input_message_id: input.message_id,
            input_event_id: input.event_id,
            input_request_key: "synthetic-input".into(),
            expected_generation: 0,
            window_id: None,
            predecessor_window_id: None,
        };
        let admission = store
            .admit_execution_window_authenticated("synthetic-browser", &conversation, &request)
            .await
            .unwrap();
        let grant = initial
            .store()
            .issue_execution_window_credential(
                initial.credential(),
                admission.status.window_id,
                1,
                "synthetic-boot",
                admission.status.expires_at_ms,
                &"a".repeat(64),
            )
            .await
            .unwrap();
        let active = initial
            .store()
            .bind_execution_window(initial.credential(), &grant)
            .await
            .unwrap();
        let metadata = active.authorize_session_metadata(&binding).await.unwrap();
        active
            .confirm_metadata_session(
                metadata,
                NativeSessionConfirmation {
                    session_id: binding.session_id,
                    expected_generation: binding.generation,
                    native_session_id: "synthetic-native".into(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "synthetic-ready".into(),
                },
            )
            .await
            .unwrap();
        let status = active
            .activate_execution_window(
                grant.credential(),
                admission.status.window_id,
                1,
                "synthetic-boot",
            )
            .await
            .unwrap();
        // Only public evidence crosses process replacement. No private token is serialized.
        std::fs::write(
            root.join("ready.json"),
            serde_json::to_vec(&status).unwrap(),
        )
        .unwrap();
        loop {
            tokio::time::sleep(Duration::from_millis(20)).await;
            // Retain actual private objects until the OS kills this process.
            std::hint::black_box((&store, &initial, &active, &grant));
        }
    }
    let previous: orkestr_v2_contracts::ExecutionWindowStatus =
        serde_json::from_slice(&std::fs::read(root.join("ready.json")).unwrap()).unwrap();
    let current = store
        .execution_window_status_authenticated("synthetic-browser", &previous.conversation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.state, ExecutionWindowState::Active);
    let status = store
        .reconcile_execution_window_authenticated(
            "synthetic-browser",
            &previous.conversation_id,
            previous.window_id,
            previous.generation,
        )
        .await
        .unwrap();
    assert_eq!(status.state, ExecutionWindowState::ReconciliationRequired);
    assert_eq!(status.window_id, previous.window_id);
    assert_eq!(status.expires_at_ms, previous.expires_at_ms);
    assert!(store
        .issue_idle_execution_window_credential_authenticated(
            "synthetic-browser",
            previous.window_id,
            previous.generation,
            "replacement-boot",
            previous.expires_at_ms,
            &"b".repeat(64),
        )
        .await
        .is_err());
    // An invented machine token cannot act as a configured fallback.
    assert!(store
        .authorize_supervisor(
            "abababababababababababababababababababababababababababababababab",
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-window".into(),
                supervisor_key: "synthetic-deep".into(),
                takeover: ProductionTakeover::First,
            }
        )
        .await
        .is_err());
    let execution = store
        .execution_status(
            &store
                .credentials("synthetic-owner")
                .await
                .unwrap()
                .unwrap()
                .0,
            &previous.conversation_id,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(execution.run_id.is_none());
    assert_eq!(
        execution.phase,
        orkestr_v2_contracts::ExecutionPhase::Queued
    );
    std::fs::write(
        root.join("replacement.json"),
        serde_json::to_vec(&status).unwrap(),
    )
    .unwrap();
}

#[test]
fn killed_rust_process_cannot_recover_active_window_authority() {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("beta-cold-process-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let log = std::fs::File::create(root.join("original.log")).unwrap();
    let command = |mode: &str| {
        let mut c = Command::new(std::env::current_exe().unwrap());
        c.args([
            "--exact",
            "window_runtime::cold_process_tests::cold_process_child",
            "--ignored",
            "--nocapture",
        ])
        .env("ORKESTR_BETA_COLD_FIXTURE", &root)
        .env("ORKESTR_BETA_COLD_MODE", mode)
        .stdin(Stdio::null());
        c
    };
    let mut first = command("original")
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("ready.json").exists() && Instant::now() < deadline {
        if first.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let ready = root.join("ready.json").exists();
    if first.try_wait().unwrap().is_none() {
        first.kill().unwrap();
    }
    first.wait().unwrap();
    assert!(ready, "original never activated; see original.log");
    let log = std::fs::File::create(root.join("replacement.log")).unwrap();
    let mut replacement = command("replacement")
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = replacement.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            replacement.kill().unwrap();
            replacement.wait().unwrap();
            break None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(
        status.is_some_and(|s| s.success()),
        "replacement failed; see replacement.log"
    );
    assert!(root.join("replacement.json").exists());
    // Raw process logs and public evidence remain in the disposable test home.
}
