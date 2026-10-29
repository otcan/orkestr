//! The two shapes #138 refused: a Worker left `cancel_requested` after its
//! deadline (the live "Workbench" conversation) and a window whose open failed
//! before it ran anything of its own (first window and successor).
use super::*;
use orkestr_v2_application::runtime::RuntimeStore;
use orkestr_v2_contracts::ExecutionWindowOpenFailureCause as Cause;

pub(super) struct Workbench {
    pub(super) p: Pending,
    pub(super) worker: ProviderAdmission,
    /// The cancellation receipt, or the `lost` observation for a broker death.
    cancellation: EventId,
}

/// Deep delegates a Worker, the Worker hits its deadline and the parent loop
/// requests its cancellation; Fast and Deep then propose. The process dies
/// before the Worker acknowledges: exactly the live Workbench shape.
async fn workbench() -> Workbench {
    workbench_with(WorkerEnd::Cancelled).await
}

/// How the Worker's process ended before the restart.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum WorkerEnd {
    /// Deadline cancellation requested, never acknowledged (0052).
    Cancelled,
    /// Broker died mid-turn after a `lost` observation (0053).
    Lost,
    /// Nothing recorded: the process just vanished while `running` (0054).
    Running,
}

/// `lost`: instead of a deadline cancellation, the Worker's broker dies
/// mid-turn (live host-mode incident: a refused provider frame). The run is
/// `blocked` with unknown delivery after a `lost` observation.
pub(super) async fn workbench_with(end: WorkerEnd) -> Workbench {
    let w = Window::open().await;
    let fast = w.ready_fast().await;
    w.activate().await;
    let fast_admission = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                fast_binding_id: fast.session_id.clone(),
                expected_binding_generation: fast.generation,
                request_key: "workbench-fast".into(),
            },
        )
        .await
        .unwrap();
    let fast = w.consume(&fast_admission).await.provider().clone();
    let deep = deep_dispatch(&w, "workbench-deep").await.provider().clone();
    w.bound
        .append_provider_event(
            &w.f.owner,
            &deep,
            &observation(&deep, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let binding = w
        .bound
        .create_worker_binding(
            &w.f.owner,
            &w.f.conversation,
            Some(&deep.binding.session_id),
            "workbench-worker",
        )
        .await
        .unwrap();
    let metadata = w
        .bound
        .authorize_worker_metadata(w.credential.credential(), &deep.run.run_id, &binding)
        .await
        .unwrap();
    let binding = w
        .bound
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
                native_session_id: "synthetic-workbench-worker".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "workbench-worker-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    let WorkerDelegationResult::Fresh(delegation) = w
        .bound
        .delegate_worker(
            w.credential.credential(),
            &deep.run.run_id,
            &WorkerAdmissionInput {
                worker_binding_id: binding.session_id.clone(),
                expected_binding_generation: binding.generation,
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                request_key: "workbench-worker".into(),
                lifetime_ms: 30_000,
            },
        )
        .await
        .unwrap()
    else {
        panic!("fresh delegation")
    };
    let admission = w
        .bound
        .admit_worker(w.credential.credential(), delegation)
        .await
        .unwrap();
    let worker = w.consume(&admission).await.provider().clone();
    w.bound
        .append_provider_event(
            &w.f.owner,
            &worker,
            &observation(&worker, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let evidence = match end {
        WorkerEnd::Lost => {
            w.bound
                .append_provider_event(
                    &w.f.owner,
                    &worker,
                    &observation(&worker, 2, ProviderEvent::Lost),
                )
                .await
                .unwrap();
            "SELECT event_id FROM production_observations WHERE run_id=? AND kind='lost'"
        }
        WorkerEnd::Cancelled => {
            w.bound
                .request_cancel(&w.f.owner, &worker.run.run_id, "worker-runtime-deadline")
                .await
                .unwrap();
            "SELECT event_id FROM production_cancellations WHERE run_id=?"
        }
        WorkerEnd::Running => {
            "SELECT event_id FROM production_observations WHERE run_id=? AND kind='started'"
        }
    };
    let cancellation = EventId(
        scalar(&w.f.store, evidence, &worker.run.run_id.to_string())
            .await
            .parse()
            .unwrap(),
    );
    let fast_done = propose(&w, &fast).await;
    let deep_done = propose(&w, &deep).await;
    Workbench {
        p: Pending {
            w,
            fast,
            deep,
            fast_done,
            deep_done,
        },
        worker,
        cancellation,
    }
}

async fn expire_worker_lease(store: &Store, worker: &ProviderAdmission) {
    sqlx::query("UPDATE production_runs SET lease_deadline_ms=lease_deadline_ms-60000 WHERE id=?")
        .bind(worker.run.run_id.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
}

async fn plan_of(
    store: &Store,
    w: &Window,
    window: Uuid,
    generation: u64,
    actor: Actor,
) -> Result<StrandedExecutionWindow> {
    store
        .plan_stranded_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            window,
            generation,
            Decision::AbandonUnaccepted,
            actor,
        )
        .await
}

async fn reconcile_window(
    store: &Store,
    w: &Window,
    window: Uuid,
    generation: u64,
    actor: Actor,
) -> Result<ExecutionWindowReconciliation> {
    match plan_of(store, w, window, generation, actor).await? {
        StrandedExecutionWindow::Reconciled(receipt) => Ok(receipt),
        StrandedExecutionWindow::Pending(plan) => {
            store
                .reconcile_stranded_execution_window_authenticated(
                    &w.browser_credential,
                    &plan,
                    Decision::AbandonUnaccepted,
                    actor,
                )
                .await
        }
    }
}

/// A fresh process observes window `generation` unfinished, past its deadline.
async fn restart_window(w: &Window, window: Uuid, generation: u64) -> Store {
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-900001,work_deadline_ms=work_deadline_ms-900001,expires_at_ms=expires_at_ms-900001 WHERE id=?")
        .bind(window.to_string())
        .execute(&w.f.store.pool)
        .await
        .unwrap();
    let fresh = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    fresh
        .reconcile_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            window,
            generation,
        )
        .await
        .unwrap();
    fresh
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_cancelled_worker_fails_and_unblocks_the_workbench_conversation() {
    let b = workbench().await;
    let w = &b.p.w;
    let fresh = restart(w, true).await;
    let worker = b.worker.run.run_id.to_string();
    // The Worker lease is still live: its child could still answer. Refused.
    let before = fixtures::snapshot(&fresh).await;
    assert!(matches!(
        reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    expire_worker_lease(&fresh, &b.worker).await;
    let StrandedExecutionWindow::Pending(plan) =
        plan_of(&fresh, w, w.status.window_id, 1, Actor::Startup)
            .await
            .unwrap()
    else {
        panic!("stranded Workbench must plan")
    };
    assert_eq!(plan.outcome, Outcome::Abandoned);
    assert_eq!(plan.failed_run_ids, vec![b.worker.run.run_id.clone()]);
    assert_eq!(plan.prior_run_id, Some(b.p.deep.run.run_id.clone()));
    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.failed_run_ids, vec![b.worker.run.run_id.clone()]);
    assert_eq!(receipt.abandoned_run_ids.len(), 2);
    assert_eq!(receipt.open_failure_cause, None);
    // Failed with its cause; never stopped, accepted or re-executed.
    assert_eq!(
        scalar(&fresh, "SELECT r.state||':'||t.terminal_kind||':'||t.event_id FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id WHERE r.id=?", &worker).await,
        format!("cancelled:failed:{}", b.cancellation)
    );
    assert_eq!(
        scalar(&fresh, "SELECT f.cause||':'||f.reconciliation_id FROM production_run_failures f WHERE f.run_id=?", &worker).await,
        format!("cancel_unacknowledged:{}", receipt.reconciliation_id)
    );
    // History is kept: the issued control and its receipt stay as they were.
    assert_eq!(
        scalar(&fresh, "SELECT o.state||':'||c.receipt_state FROM production_control_outbox o JOIN production_cancellations c ON c.run_id=o.run_id WHERE o.run_id=?", &worker).await,
        "pending:cancel_requested"
    );
    assert_eq!(
        scalar(&fresh, "SELECT b.state||':'||b.generation FROM session_bindings b JOIN production_runs r ON r.session_id=b.id WHERE r.id=?", &worker).await,
        format!("lost:{}", b.worker.binding.generation + 1)
    );
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_acceptances").await,
        0
    );
    assert_eq!(window_state(&fresh, w.status.window_id).await, "closed");
    // The conversation resumes its Deep session in a successor window.
    let retired = fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    assert_eq!(retired.prior_run_id(), &b.p.deep.run.run_id);
    let replay = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.failed_run_ids, receipt.failed_run_ids);
}

/// Live host-mode shape: the Worker's broker died on its first tool call, so
/// the run is `blocked` after `lost`. Before 0053 nothing could reconcile it,
/// and the conversation stayed stranded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_worker_fails_and_unblocks_its_conversation() {
    let b = workbench_with(WorkerEnd::Lost).await;
    let w = &b.p.w;
    let worker = b.worker.run.run_id.to_string();
    assert_eq!(
        scalar(
            &w.f.store,
            "SELECT state||':'||dispatch_state FROM production_runs WHERE id=?",
            &worker
        )
        .await,
        "blocked:delivery_unknown"
    );
    let fresh = restart(w, true).await;
    // Its lease is still live: the child could still answer. Refused.
    let before = fixtures::snapshot(&fresh).await;
    assert!(matches!(
        reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    expire_worker_lease(&fresh, &b.worker).await;
    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.failed_run_ids, vec![b.worker.run.run_id.clone()]);
    assert_eq!(receipt.abandoned_run_ids.len(), 2);
    assert_eq!(
        scalar(&fresh, "SELECT r.state||':'||t.terminal_kind||':'||t.event_id FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id WHERE r.id=?", &worker).await,
        format!("cancelled:failed:{}", b.cancellation)
    );
    assert_eq!(
        scalar(
            &fresh,
            "SELECT reconciliation_id FROM production_run_lost_failures WHERE run_id=?",
            &worker
        )
        .await,
        receipt.reconciliation_id.to_string()
    );
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_run_failures").await,
        0
    );
    assert_eq!(
        scalar(&fresh, "SELECT b.state||':'||b.generation FROM session_bindings b JOIN production_runs r ON r.session_id=b.id WHERE r.id=?", &worker).await,
        format!("lost:{}", b.worker.binding.generation + 1)
    );
    assert_eq!(window_state(&fresh, w.status.window_id).await, "closed");
    let replay = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    assert!(replay.duplicate);
}

/// Successor window: the opening reattached the retired supervisor (new
/// incarnation, resume reservation) and then broker setup failed. No run of
/// its own exists. A restart left it stranded forever before this change.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_successor_open_restores_its_retired_predecessor() {
    failed_successor_case(None).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_bounded_fast_setup_is_retired_without_reusing_uncertain_metadata() {
    failed_successor_case(Some(false)).await;
    failed_successor_case(Some(true)).await;
}

async fn failed_successor_case(bounded_setup: Option<bool>) {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    let (incarnation, generation): (String, i64) = sqlx::query_as(
        "SELECT incarnation_id,generation FROM production_supervisors WHERE context_id=(SELECT context_id FROM execution_windows WHERE id=?)",
    )
    .bind(w.status.window_id.to_string())
    .fetch_one(&fresh.pool)
    .await
    .unwrap();
    let deep = &p.deep;
    let open_successor = |key: &'static str, generation: u64, predecessor: Uuid| {
        let fresh = &fresh;
        async move {
            let retired = fresh
                .recover_retired_execution_window_authenticated(
                    &w.browser_credential,
                    &w.f.conversation,
                    fixtures::config(ProductionTakeover::First),
                )
                .await
                .unwrap();
            assert_eq!(retired.prior_run_id(), &deep.run.run_id);
            let mut request = input(&w.f, key).await;
            request.expected_generation = generation - 1;
            request.predecessor_window_id = Some(predecessor);
            let next = fresh
                .admit_execution_window_authenticated(
                    &w.browser_credential,
                    &w.f.conversation,
                    &request,
                )
                .await
                .unwrap();
            assert_eq!(next.status.generation, generation);
            let grant = retired
                .store()
                .issue_idle_execution_window_credential_authenticated(
                    &w.browser_credential,
                    next.status.window_id,
                    generation,
                    "successor-boot",
                    next.status.expires_at_ms,
                    &"c".repeat(64),
                )
                .await
                .unwrap();
            let (bound, metadata) = fresh
                .reattach_terminal_supervisor(
                    grant.credential(),
                    fixtures::config(ProductionTakeover::ExpiredPredecessor {
                        incarnation_id: retired.predecessor_incarnation().into(),
                    }),
                    &deep.run.run_id,
                )
                .await
                .unwrap();
            assert_eq!(
                metadata.binding().native_session_id,
                deep.binding.native_session_id
            );
            if let Some(confirm) = bounded_setup {
                let fast = bound
                    .ensure_role_bindings(&w.f.owner, &w.f.conversation)
                    .await
                    .unwrap()
                    .fast;
                let setup = bound
                    .authorize_bounded_fast_metadata(grant.credential(), &fast)
                    .await
                    .unwrap();
                assert_eq!(setup.binding().native_session_id, None);
                if confirm {
                    let binding = setup.binding().clone();
                    bound
                        .confirm_metadata_session(
                            setup,
                            NativeSessionConfirmation {
                                session_id: binding.session_id.clone(),
                                expected_generation: binding.generation,
                                native_session_id: format!("synthetic-unused-fast-{generation}"),
                                protocol_version: "synthetic-codex-1".into(),
                                source_event_key: format!("unused:{generation}"),
                            },
                        )
                        .await
                        .unwrap();
                }
            }
            (next, request)
        }
    };
    let (second, request) = open_successor("failed-successor", 2, w.status.window_id).await;
    // Broker readiness fails here: no run, then the process dies.
    let second_id = second.status.window_id;
    let fresh = restart_window(w, second_id, 2).await;
    let StrandedExecutionWindow::Pending(plan) = plan_of(&fresh, w, second_id, 2, Actor::Startup)
        .await
        .unwrap()
    else {
        panic!("failed open must plan")
    };
    assert_eq!(plan.outcome, Outcome::Failed);
    assert_eq!(plan.prior_run_id, None);
    assert_eq!(plan.open_failure_cause, Some(Cause::SetupIncomplete));
    assert_eq!(plan.restored_window_id, Some(w.status.window_id));
    let receipt = reconcile_window(&fresh, w, second_id, 2, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.restored_window_id, Some(w.status.window_id));
    assert_eq!(
        receipt.released_input_event_ids,
        vec![request.input_event_id.clone()]
    );
    assert_eq!(window_state(&fresh, second_id).await, "closed");
    if bounded_setup.is_some() {
        assert_eq!(count(&fresh, "SELECT count(*) FROM production_fast_continuity c JOIN session_bindings b ON b.id=c.session_id WHERE b.state='retired'").await, 1);
        assert_eq!(count(&fresh, "SELECT count(*) FROM production_runs r JOIN production_fast_continuity c ON c.session_id=r.session_id").await, 0);
    }
    // The retired supervisor is exactly as the predecessor left it.
    assert_eq!(
        sqlx::query_as::<_, (String, i64, i64)>("SELECT incarnation_id,generation,lease_deadline_ms FROM production_supervisors WHERE context_id=(SELECT context_id FROM execution_windows WHERE id=?)")
            .bind(w.status.window_id.to_string()).fetch_one(&fresh.pool).await.unwrap(),
        (incarnation.clone(), generation, 0)
    );
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_resume_metadata").await,
        0
    );
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM execution_window_failed_resume_metadata"
        )
        .await,
        1
    );
    assert_eq!(
        scalar(&fresh, "SELECT actor||':'||cause||':'||restored_generation FROM execution_window_open_failures WHERE window_id=?", &second_id.to_string()).await,
        format!("startup:setup_incomplete:{generation}")
    );
    let replay = reconcile_window(&fresh, w, second_id, 2, Actor::Owner)
        .await
        .unwrap();
    assert!(replay.duplicate);
    // The conversation opens again from the same retired Deep turn, through
    // the failed window, and its released input can be admitted again.
    let (third, _) = open_successor("after-failed-successor", 3, second_id).await;
    assert_eq!(third.status.predecessor_window_id, Some(second_id));
    assert_eq!(
        scalar(
            &fresh,
            "SELECT state FROM reasoning_inbox WHERE event_id=? AND NOT EXISTS(SELECT 1 FROM execution_window_inputs i WHERE i.event_id=reasoning_inbox.event_id)",
            &request.input_event_id.to_string()
        )
        .await,
        "queued"
    );
}

/// First window: the bootstrap opening bound its credential but setup failed
/// before any run. The conversation bootstraps again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_first_open_is_fenced_then_bootstraps_again() {
    let w = Window::open().await;
    w.ready_fast().await;
    let fresh = restart(&w, true).await;
    assert!(!fresh
        .execution_window_failed_first_open_authenticated(&w.browser_credential, &w.f.conversation)
        .await
        .unwrap());
    let receipt = reconcile_window(&fresh, &w, w.status.window_id, 1, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.open_failure_cause, Some(Cause::SetupIncomplete));
    assert_eq!(receipt.restored_window_id, None);
    assert_eq!(
        receipt.released_input_event_ids,
        vec![w.source.input_event_id.clone()]
    );
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM production_supervisors WHERE lease_deadline_ms!=0"
        )
        .await,
        0
    );
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM auth_sessions a JOIN execution_windows w ON w.credential_hash=a.token_hash").await,
        0
    );
    assert!(fresh
        .execution_window_failed_first_open_authenticated(&w.browser_credential, &w.f.conversation)
        .await
        .unwrap());
    // No retired turn exists to resume, and the plain bootstrap still refuses.
    assert!(fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .is_err());
    let bootstrap = fresh
        .rebootstrap_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    assert_eq!(bootstrap.binding().state, SessionState::Starting);
    assert_ne!(bootstrap.binding().session_id, w.roles.deep.session_id);
    assert_eq!(
        scalar(
            &fresh,
            "SELECT state FROM session_bindings WHERE id=?",
            &w.roles.deep.session_id.to_string()
        )
        .await,
        "retired"
    );
    let mut request = w.source.clone();
    request.request_key = "window:after-failed-first-open".into();
    request.expected_generation = 1;
    request.predecessor_window_id = Some(w.status.window_id);
    let next = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(next.status.generation, 2);
    let grant = bootstrap
        .store()
        .issue_execution_window_credential(
            bootstrap.credential(),
            next.status.window_id,
            2,
            "rebootstrap-boot",
            next.status.expires_at_ms,
            &"d".repeat(64),
        )
        .await
        .unwrap();
    bootstrap
        .store()
        .bind_execution_window(bootstrap.credential(), &grant)
        .await
        .unwrap();
    // Re-bootstrapping is single-use: the lineage now has a live window.
    assert!(fresh
        .rebootstrap_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unissued_open_closes_without_touching_any_supervisor() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    let supervisors = count(&fresh, "SELECT sum(generation) FROM production_supervisors").await;
    // The manager admitted the successor, then issuance never happened.
    let mut request = input(&w.f, "unissued-successor").await;
    request.expected_generation = 1;
    request.predecessor_window_id = Some(w.status.window_id);
    let next = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    let id = next.status.window_id;
    let fresh = restart_window(w, id, 2).await;
    let receipt = reconcile_window(&fresh, w, id, 2, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.open_failure_cause, Some(Cause::CredentialUnissued));
    assert_eq!(receipt.restored_window_id, Some(w.status.window_id));
    // Neither an audited reconciliation nor a failed open is a canonical
    // retirement the manager may be handed.
    for (window, generation) in [(w.status.window_id, 1), (id, 2)] {
        assert_eq!(
            fresh
                .closed_execution_window_retirement_authenticated(
                    &w.browser_credential,
                    &w.f.conversation,
                    window,
                    generation,
                )
                .await
                .unwrap(),
            None
        );
    }
    assert_eq!(
        count(&fresh, "SELECT sum(generation) FROM production_supervisors").await,
        supervisors
    );
    fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
}

#[path = "stranded_upgrade_tests.rs"]
mod upgrade;

#[path = "stranded_lapse_tests.rs"]
mod lapse;

#[path = "stranded_property_tests.rs"]
mod property;

#[path = "auto_accept_window_tests.rs"]
mod auto_accept;
