use super::tests::input;
use super::*;
use crate::production_runtime::{observation_tests::input as observation, tests as fixtures};
use orkestr_v2_contracts::ExecutionAcceptanceRequest;
use std::time::Duration;

pub(super) async fn seed_closed(root: std::path::PathBuf, active_only: bool) {
    seed_closed_provider(root, active_only, ProviderKind::Codex).await;
}

pub(super) async fn seed_closed_provider(
    root: std::path::PathBuf,
    active_only: bool,
    provider: ProviderKind,
) {
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
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
    let browser = "synthetic-browser-window".to_string();
    // Browser login is the only saved session. All machine authority comes from
    // the deployed private bootstrap/issue/bind ports, not a test machine token.
    store.save_session(&browser, &owner).await.unwrap();
    let mut config = fixtures::config(ProductionTakeover::First);
    config.provider = provider;
    let initial = store
        .bootstrap_execution_window_authenticated(&browser, &conversation, config)
        .await
        .unwrap();
    let binding = initial.binding().clone();
    let f = fixtures::Case {
        store,
        handle: initial.store().clone(),
        root,
        owner,
        conversation,
        token: initial.credential().into(),
    };
    let request = input(&f, "first-window-proposal").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    let cap = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            a.status.window_id,
            1,
            "first-boot",
            a.status.expires_at_ms,
            &"e".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &cap)
        .await
        .unwrap();
    let metadata = bound.authorize_session_metadata(&binding).await.unwrap();
    let native = if provider == ProviderKind::Claude {
        Uuid::new_v4().to_string()
    } else {
        "synthetic-cold-native".into()
    };
    let transition = if provider == ProviderKind::Claude {
        bound
            .initialize_claude_session(
                metadata,
                super::super::claude_identity::ClaudeProcessInitialization {
                    requested_native_session_id: native.clone(),
                    protocol_version: "claude-control-v1".into(),
                    source_event_key: "synthetic-cold-ready".into(),
                },
            )
            .await
            .unwrap()
    } else {
        bound
            .confirm_metadata_session(
                metadata,
                NativeSessionConfirmation {
                    session_id: binding.session_id.clone(),
                    expected_generation: binding.generation,
                    native_session_id: native.clone(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "synthetic-cold-ready".into(),
                },
            )
            .await
            .unwrap()
    };
    let binding = transition.binding();
    bound
        .activate_execution_window(cap.credential(), a.status.window_id, 1, "first-boot")
        .await
        .unwrap();
    if active_only {
        std::fs::write(f.root.join("conversation"), f.conversation.to_string()).unwrap();
        return;
    }
    let claim = bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let run = bound
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "terminal-window-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&run, "terminal-window-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(dispatch) =
        bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let dispatch = if provider == ProviderKind::Claude {
        transition.attach_execution(*dispatch).unwrap()
    } else {
        *dispatch
    };
    let p = dispatch.provider();
    if provider == ProviderKind::Claude {
        bound
            .observe_claude_session(p, &native, "synthetic-cold-native-init")
            .await
            .unwrap();
    }
    bound
        .append_provider_event(&f.owner, p, &observation(p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let done = bound
        .append_provider_event(
            &f.owner,
            p,
            &observation(p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    bound
        .begin_execution_window_retirement(cap.credential(), a.status.window_id, 1, "first-boot")
        .await
        .unwrap();
    // Deterministic clock boundary, preserving the ledger's exact duration checks.
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-900001,work_deadline_ms=work_deadline_ms-900001,expires_at_ms=expires_at_ms-900001 WHERE id=?")
        .bind(a.status.window_id.to_string()).execute(&f.store.pool).await.unwrap();
    assert!(bound
        .retire_execution_window(
            cap.credential(),
            a.status.window_id,
            1,
            "first-boot",
            &p.run.run_id
        )
        .await
        .is_err());
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status.phase,
        orkestr_v2_contracts::ExecutionPhase::AwaitingAcceptance
    );
    let called = std::sync::atomic::AtomicBool::new(false);
    assert!(bound
        .with_execution_fence(p, || {
            called.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    f.store
        .accept_execution_authenticated(
            &browser,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id,
                expected_revision: status.revision,
                request_key: "post-expiry-owner-accept".into(),
            },
        )
        .await
        .unwrap();
    // Trusted teardown call models the server boundary after original reap proof;
    // this Store test makes no native/process cleanup claim.
    bound
        .retire_terminal_supervisor(cap.credential(), &p.run.run_id)
        .await
        .unwrap();
    let (_retired, handoff) = bound
        .retire_execution_window(
            cap.credential(),
            a.status.window_id,
            1,
            "first-boot",
            &p.run.run_id,
        )
        .await
        .unwrap();
    assert_eq!(handoff.credential(), cap.credential());
    std::fs::write(f.root.join("conversation"), f.conversation.to_string()).unwrap();
    // No machine credential or opaque handle is persisted for the replacement.
}

#[test]
fn closed_idle_two_process_restart() {
    two_process(false);
}

#[test]
fn active_loss_two_process_refuses_retired_recovery() {
    two_process(true);
}

fn two_process(active: bool) {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("beta-closed-process-{}", Uuid::new_v4()));
    for phase in if active {
        ["seed-active", "replace-active"]
    } else {
        ["seed", "replace"]
    } {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "production_runtime::execution_window::retired_process_tests::closed_idle_child",
                "--nocapture",
            ])
            .env_clear()
            .env("ORKESTR_V2_HOME", &root)
            .env("BETA_CLOSED_PHASE", phase)
            .spawn()
            .unwrap();
        let start = std::time::Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if start.elapsed() > Duration::from_secs(30) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("bounded child timeout");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_idle_child() {
    let Ok(phase) = std::env::var("BETA_CLOSED_PHASE") else {
        return;
    };
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    if phase == "seed" || phase == "seed-active" {
        seed_closed(root, phase == "seed-active").await;
        return;
    }
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let conversation = ConversationId(
        std::fs::read_to_string(root.join("conversation"))
            .unwrap()
            .parse()
            .unwrap(),
    );
    let browser = "synthetic-browser-window";
    assert!(store
        .recover_retired_execution_window_authenticated(
            "revoked-or-unknown",
            &conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    assert!(store
        .recover_retired_execution_window_authenticated(
            browser,
            &ConversationId(Uuid::new_v4()),
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    if phase == "replace-active" {
        assert!(store
            .recover_retired_execution_window_authenticated(
                browser,
                &conversation,
                fixtures::config(ProductionTakeover::First)
            )
            .await
            .is_err());
        let previous = store
            .execution_window_status_authenticated(browser, &conversation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(previous.state, ExecutionWindowState::Active);
        let observed = store
            .reconcile_execution_window_authenticated(
                browser,
                &conversation,
                previous.window_id,
                previous.generation,
            )
            .await
            .unwrap();
        assert_eq!(observed.state, ExecutionWindowState::ReconciliationRequired);
        assert!(store
            .recover_retired_execution_window_authenticated(
                browser,
                &conversation,
                fixtures::config(ProductionTakeover::First)
            )
            .await
            .is_err());
        assert!(store
            .bootstrap_execution_window_authenticated(
                browser,
                &conversation,
                fixtures::config(ProductionTakeover::First)
            )
            .await
            .is_err());
        return;
    }
    let mut wrong = fixtures::config(ProductionTakeover::First);
    wrong.supervisor_key = "other-configured-context".into();
    assert!(store
        .recover_retired_execution_window_authenticated(browser, &conversation, wrong)
        .await
        .is_err());
    let mut wrong = fixtures::config(ProductionTakeover::First);
    wrong.provider = ProviderKind::Claude;
    assert!(store
        .recover_retired_execution_window_authenticated(browser, &conversation, wrong)
        .await
        .is_err());
    let recovered = store
        .recover_retired_execution_window_authenticated(
            browser,
            &conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let case = fixtures::Case {
        store: store.clone(),
        handle: store.clone(),
        root: root.clone(),
        owner,
        conversation: conversation.clone(),
        token: String::new(),
    };
    let previous = store
        .execution_window_status_authenticated(browser, &conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(previous.state, ExecutionWindowState::Closed);
    let mut request = input(&case, "cold-clean-next-input").await;
    request.expected_generation = previous.generation;
    request.predecessor_window_id = Some(previous.window_id);
    let next = store
        .admit_execution_window_authenticated(browser, &conversation, &request)
        .await
        .unwrap();
    // Admission creates Opening, so cold rediscovery cannot bypass a lost issue.
    assert!(store
        .recover_retired_execution_window_authenticated(
            browser,
            &conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    let issued = recovered
        .store()
        .issue_idle_execution_window_credential_authenticated(
            browser,
            next.status.window_id,
            next.status.generation,
            "replacement-boot",
            next.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    assert!(recovered
        .store()
        .issue_idle_execution_window_credential_authenticated(
            browser,
            next.status.window_id,
            next.status.generation,
            "replacement-boot",
            next.status.expires_at_ms,
            &"a".repeat(64)
        )
        .await
        .is_err());
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: recovered.predecessor_incarnation().into(),
    });
    let (bound, metadata) = store
        .reattach_terminal_supervisor(issued.credential(), config, recovered.prior_run())
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
    store.revoke_session(browser).await.unwrap();
    assert!(store
        .recover_retired_execution_window_authenticated(
            browser,
            &conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
}
