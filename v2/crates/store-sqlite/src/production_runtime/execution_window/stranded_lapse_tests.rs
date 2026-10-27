//! Runs whose lease passed while their process was gone (0054), as on the
//! live pilot: a host Worker that died on renewal while `running` under a
//! proposed Deep (969f5efc), and a Claude window whose Fast was lost and whose
//! Deep was `running` when the service restarted (bf83b9ea).
use super::*;

async fn settle(store: &Store, w: &Window, window: Uuid, generation: u64) -> Vec<RunId> {
    store
        .settle_lapsed_runs_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            window,
            generation,
            Actor::Startup,
        )
        .await
        .unwrap()
}

async fn expire(store: &Store, run: &ProviderAdmission) {
    sqlx::query("UPDATE production_runs SET lease_deadline_ms=lease_deadline_ms-120000 WHERE id=?")
        .bind(run.run.run_id.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
}

async fn accept(store: &Store, w: &Window, run: &ProviderAdmission, done: &EventId) {
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(w.f.conversation.to_string())
            .fetch_one(&store.pool)
            .await
            .unwrap();
    store
        .accept_execution_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: run.run.run_id.clone(),
                completion_event_id: done.clone(),
                expected_revision: revision,
                request_key: format!("accept-after-lapse-{}", run.run.run_id),
            },
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lapsed_worker_fails_and_its_proposed_parent_stays_acceptable() {
    let b = workbench_with(WorkerEnd::Running).await;
    let w = &b.p.w;
    let window = w.status.window_id;
    let fresh = restart_window(w, window, 1).await;
    let worker = b.worker.run.run_id.to_string();
    // The Worker's lease is still live: nothing is settled, nothing changes.
    let before = fixtures::snapshot(&fresh).await;
    assert!(settle(&fresh, w, window, 1).await.is_empty());
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    // While the running child exists, the parent proposal cannot be accepted.
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(w.f.conversation.to_string())
            .fetch_one(&fresh.pool)
            .await
            .unwrap();
    assert!(fresh
        .accept_execution_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: b.p.deep.run.run_id.clone(),
                completion_event_id: b.p.deep_done.clone(),
                expected_revision: revision,
                request_key: "accept-before-lapse".into(),
            },
        )
        .await
        .is_err());
    expire(&fresh, &b.worker).await;
    assert_eq!(
        settle(&fresh, w, window, 1).await,
        vec![b.worker.run.run_id.clone()]
    );
    assert_eq!(
        scalar(&fresh, "SELECT r.state||':'||t.terminal_kind||':'||l.cause||':'||l.prior_state||':'||l.actor FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id JOIN production_run_lapses l ON l.run_id=r.id WHERE r.id=?", &worker).await,
        "cancelled:failed:lease_expired_process_gone:running:startup"
    );
    assert_eq!(
        scalar(&fresh, "SELECT b.state FROM session_bindings b JOIN production_runs r ON r.session_id=b.id WHERE r.id=?", &worker).await,
        "lost"
    );
    // Idempotent: a second settle has nothing left to do.
    assert!(settle(&fresh, w, window, 1).await.is_empty());
    // Within the acceptance grace the automatic path never abandons them.
    let held = fixtures::snapshot(&fresh).await;
    assert!(matches!(
        reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(held, fixtures::snapshot(&fresh).await);
    // The owner accepts the proposals; the window then retires as accepted.
    accept(&fresh, w, &b.p.fast, &b.p.fast_done).await;
    accept(&fresh, w, &b.p.deep, &b.p.deep_done).await;
    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Accepted);
    assert!(receipt.abandoned_run_ids.is_empty());
    assert_eq!(window_state(&fresh, window).await, "closed");
    fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lapsed_deep_and_lost_fast_close_the_window_failed_and_resume_it() {
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
                request_key: "lapse-fast".into(),
            },
        )
        .await
        .unwrap();
    let fast = w.consume(&fast_admission).await.provider().clone();
    let deep = deep_dispatch(&w, "lapse-deep").await.provider().clone();
    for (run, events) in [
        (&fast, vec![ProviderEvent::Started, ProviderEvent::Lost]),
        (&deep, vec![ProviderEvent::Started]),
    ] {
        for (sequence, kind) in events.into_iter().enumerate() {
            w.bound
                .append_provider_event(
                    &w.f.owner,
                    run,
                    &observation(run, sequence as u64 + 1, kind),
                )
                .await
                .unwrap();
        }
    }
    let window = w.status.window_id;
    let fresh = restart_window(&w, window, 1).await;
    // Before settling, the decision refuses the uncertain turns.
    assert!(matches!(
        reconcile(&fresh, &w, Decision::AbandonUnaccepted, Actor::Startup).await,
        Err(RuntimeStoreError::Fenced)
    ));
    expire(&fresh, &fast).await;
    expire(&fresh, &deep).await;
    let mut settled = settle(&fresh, &w, window, 1).await;
    settled.sort_by_key(|r| r.to_string());
    let mut expected = vec![fast.run.run_id.clone(), deep.run.run_id.clone()];
    expected.sort_by_key(|r| r.to_string());
    assert_eq!(settled, expected);
    assert_eq!(
        scalar(
            &fresh,
            "SELECT prior_state FROM production_run_lapses WHERE run_id=?",
            &fast.run.run_id.to_string()
        )
        .await,
        "blocked"
    );
    let receipt = reconcile(&fresh, &w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.prior_run_id, Some(deep.run.run_id.clone()));
    assert_eq!(receipt.open_failure_cause, None);
    assert_eq!(window_state(&fresh, window).await, "closed");
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_lapsed_retirements").await,
        1
    );
    // The conversation resumes the same native Deep session; nothing re-runs.
    let retired = fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    assert_eq!(retired.prior_run_id(), &deep.run.run_id);
    let mut request = input(&w.f, "after-lapse").await;
    request.expected_generation = 1;
    request.predecessor_window_id = Some(window);
    let next = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    let grant = retired
        .store()
        .issue_idle_execution_window_credential_authenticated(
            &w.browser_credential,
            next.status.window_id,
            2,
            "after-lapse-boot",
            next.status.expires_at_ms,
            &"e".repeat(64),
        )
        .await
        .unwrap();
    let (_, metadata) = fresh
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
}

/// The live 969f5efc shape written by a schema-53 release: upgrading changes
/// no row, then the lapsed Worker settles and the proposal is accepted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schema53_lapsed_worker_settles_after_upgrade() {
    let b = workbench_with(WorkerEnd::Running).await;
    let w = &b.p.w;
    let window = w.status.window_id;
    expire(&w.f.store, &b.worker).await;
    super::upgrade::downgrade_to_schema53(&w.f.store).await;
    assert_eq!(
        count(&w.f.store, "SELECT max(version) FROM _sqlx_migrations").await,
        53
    );
    let before = fixtures::snapshot(&w.f.store).await;
    let fresh = restart_window(w, window, 1).await;
    assert_eq!(
        count(&fresh, "SELECT max(version) FROM _sqlx_migrations").await,
        80
    );
    assert_eq!(
        before,
        fixtures::snapshot(&fresh).await,
        "upgrade changes no row"
    );
    for table in ["production_run_lapses", "production_lapsed_retirements"] {
        assert_eq!(
            count(&fresh, &format!("SELECT count(*) FROM {table}")).await,
            0
        );
    }
    assert_eq!(
        settle(&fresh, w, window, 1).await,
        vec![b.worker.run.run_id.clone()]
    );
    accept(&fresh, w, &b.p.fast, &b.p.fast_done).await;
    accept(&fresh, w, &b.p.deep, &b.p.deep_done).await;
    assert_eq!(
        reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
            .await
            .unwrap()
            .outcome,
        Outcome::Accepted
    );
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&fresh.pool)
        .await
        .unwrap()
        .is_empty());
}

/// Live faa4f616: the Deep proposed while its Worker was still in native
/// setup. No delegation can be admitted under a proposed parent, so the task
/// never runs. It must end visibly as failed, and its confirmed (unused)
/// setup must not leave the window unretirable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_in_setup_when_parent_proposes_fails_visibly_without_stranding() {
    use orkestr_v2_contracts::{WorkerTaskCreateRequest, WorkerTaskFailureCause, WorkerTaskPhase};
    let p = pending_parent().await;
    let w = &p.w;
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM production_control_revisions WHERE run_id=?")
            .bind(p.deep.run.run_id.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    w.bound
        .create_worker_task_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &WorkerTaskCreateRequest {
                parent_run_id: p.deep.run.run_id.clone(),
                expected_control_revision: revision,
                request_key: "setup-race".into(),
                title: "Synthetic setup race".into(),
                instructions: "Summarize synthetic input".into(),
                lifetime_ms: 30_000,
                execution_budget_ms: Some(120_000),
            },
        )
        .await
        .unwrap();
    let claim = w
        .bound
        .claim_worker_task(w.credential.credential(), &p.deep.run.run_id)
        .await
        .unwrap()
        .unwrap();
    let task = claim.task_id().clone();
    // Native setup confirms readiness for the Worker's own binding.
    let binding = w
        .bound
        .create_worker_binding(
            &w.f.owner,
            &w.f.conversation,
            Some(&p.deep.binding.session_id),
            "worker-task:setup-race",
        )
        .await
        .unwrap();
    let metadata = w
        .bound
        .authorize_worker_metadata(w.credential.credential(), &p.deep.run.run_id, &binding)
        .await
        .unwrap();
    let binding = w
        .bound
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
                native_session_id: "synthetic-setup-race-worker".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "setup-race-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    // While the parent runs, setup may continue: nothing is failed.
    assert!(w
        .bound
        .fail_worker_task_setup(w.credential.credential(), &task, Some(&binding.session_id))
        .await
        .is_err());
    // The Deep proposes first; delegation is closed for good.
    let deep_done = w
        .bound
        .append_provider_event(
            &w.f.owner,
            &p.deep,
            &observation(
                &p.deep,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id;
    assert!(w
        .bound
        .delegate_worker_task(w.credential.credential(), claim, &binding)
        .await
        .is_err());
    w.bound
        .fail_worker_task_setup(w.credential.credential(), &task, Some(&binding.session_id))
        .await
        .unwrap();
    // Replays; a different setup conflicts.
    w.bound
        .fail_worker_task_setup(w.credential.credential(), &task, Some(&binding.session_id))
        .await
        .unwrap();
    assert!(w
        .bound
        .fail_worker_task_setup(w.credential.credential(), &task, None)
        .await
        .is_err());
    let list =
        w.f.store
            .worker_task_history_authenticated(
                &w.browser_credential,
                &w.f.owner,
                &w.f.conversation,
                &p.deep.run.run_id,
            )
            .await
            .unwrap();
    assert_eq!(list.tasks.len(), 1);
    assert_eq!(list.tasks[0].phase, WorkerTaskPhase::Failed);
    assert_eq!(
        list.tasks[0].failure_cause,
        Some(WorkerTaskFailureCause::ParentLeftRunningDuringSetup)
    );
    assert_eq!(
        scalar(
            &w.f.store,
            "SELECT state FROM session_bindings WHERE id=?",
            &binding.session_id.to_string()
        )
        .await,
        "lost"
    );
    // The window retires normally once the owner accepts the proposals.
    let fresh = restart_window(w, w.status.window_id, 1).await;
    accept(&fresh, w, &p.fast, &p.fast_done).await;
    accept(&fresh, w, &p.deep, &deep_done).await;
    assert_eq!(
        reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
            .await
            .unwrap()
            .outcome,
        Outcome::Accepted
    );
}

/// Fast proposed and Deep running (not yet proposed), as before delegation.
struct Parent {
    w: Window,
    fast: ProviderAdmission,
    fast_done: EventId,
    deep: ProviderAdmission,
}

async fn pending_parent() -> Parent {
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
                request_key: "setup-race-fast".into(),
            },
        )
        .await
        .unwrap();
    let fast = w.consume(&fast_admission).await.provider().clone();
    let deep = deep_dispatch(&w, "setup-race-deep")
        .await
        .provider()
        .clone();
    w.bound
        .append_provider_event(
            &w.f.owner,
            &deep,
            &observation(&deep, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let fast_done = propose(&w, &fast).await;
    Parent {
        w,
        fast,
        fast_done,
        deep,
    }
}

/// PA gen 22 (7dd23255): the Deep turn's observation was refused, its task
/// ended and its process was reaped, yet the window waited ~20 minutes for
/// its hard deadline. Once the lease has passed, the owner-side decision
/// closes it at once (nothing acceptable is abandoned); Startup still waits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lapsed_deep_closes_before_the_window_deadline_on_the_owner_side() {
    let w = Window::open().await;
    w.activate().await;
    let deep = deep_dispatch(&w, "early-deep").await.provider().clone();
    w.bound
        .append_provider_event(
            &w.f.owner,
            &deep,
            &observation(&deep, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let window = w.status.window_id;
    // A process that no longer owns the window marks it; no deadline moves.
    let fresh = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    fresh
        .reconcile_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            window,
            1,
        )
        .await
        .unwrap();
    expire(&fresh, &deep).await;
    let settled = fresh
        .settle_lapsed_runs_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            window,
            1,
            Actor::Owner,
        )
        .await
        .unwrap();
    assert_eq!(settled, vec![deep.run.run_id.clone()]);
    assert!(matches!(
        reconcile(&fresh, &w, Decision::AbandonUnaccepted, Actor::Startup).await,
        Err(RuntimeStoreError::Fenced)
    ));
    let plan = match fresh
        .plan_stranded_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            window,
            1,
            Decision::AbandonUnaccepted,
            Actor::Owner,
        )
        .await
        .unwrap()
    {
        StrandedExecutionWindow::Pending(plan) => plan,
        StrandedExecutionWindow::Reconciled(_) => panic!("pending plan expected"),
    };
    assert!(!plan.hard_deadline_passed);
    assert!(plan.abandoned_run_ids.is_empty());
    let receipt = reconcile(&fresh, &w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(window_state(&fresh, window).await, "closed");
}
