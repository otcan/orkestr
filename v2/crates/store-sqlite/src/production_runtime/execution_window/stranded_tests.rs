//! Restart with a window whose Fast and Deep proposals still await acceptance.
//! Reproduces the live shape: the opener process (and its private window
//! credential) is gone, Core marked the window `reconciliation_required`, its
//! hard deadline passed, and another conversation holds a saved, never-admitted
//! input that the stranded window was blocking.
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{
    ExecutionAcceptanceRequest, ExecutionWindowReconciliation,
    ExecutionWindowReconciliationActor as Actor, ExecutionWindowReconciliationDecision as Decision,
    ExecutionWindowTerminalOutcome as Outcome, MessageInput,
};

struct Pending {
    w: Window,
    fast: ProviderAdmission,
    deep: ProviderAdmission,
    fast_done: EventId,
    deep_done: EventId,
}

async fn propose(w: &Window, provider: &ProviderAdmission) -> EventId {
    w.bound
        .append_provider_event(
            &w.f.owner,
            provider,
            &observation(provider, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    w.bound
        .append_provider_event(
            &w.f.owner,
            provider,
            &observation(
                provider,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id
}

async fn deep_dispatch(w: &Window, key: &str) -> ConsumedProviderDispatch {
    let claim = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &w.roles.deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let admission = w
        .bound
        .admit_run(
            &claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            key,
        )
        .await
        .unwrap();
    w.consume(&admission).await
}

/// Fast and Deep both reach `awaiting_acceptance`; nobody accepts or stops.
async fn pending() -> Pending {
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
                request_key: "stranded-fast".into(),
            },
        )
        .await
        .unwrap();
    let fast = w.consume(&fast_admission).await.provider().clone();
    let deep = deep_dispatch(&w, "stranded-deep").await.provider().clone();
    let fast_done = propose(&w, &fast).await;
    let deep_done = propose(&w, &deep).await;
    Pending {
        w,
        fast,
        deep,
        fast_done,
        deep_done,
    }
}

/// The opener dies. A fresh process (new pool, no private credential) observes
/// the unfinished window and marks it uncertain, exactly like the server does.
async fn restart(w: &Window, expire: bool) -> Store {
    if expire {
        // Past the hard deadline and the acceptance grace, so the automatic
        // path may abandon proposals still awaiting the owner.
        shift(
            w,
            900_001 + crate::production_runtime::execution_window::stranded::ACCEPTANCE_GRACE_MS,
        )
        .await;
    }
    let fresh = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    let marked = fresh
        .reconcile_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
        )
        .await
        .unwrap();
    assert_eq!(marked.state, ExecutionWindowState::ReconciliationRequired);
    fresh
}

async fn shift(w: &Window, ms: i64) {
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-?,work_deadline_ms=work_deadline_ms-?,expires_at_ms=expires_at_ms-? WHERE id=?")
        .bind(ms).bind(ms).bind(ms).bind(w.status.window_id.to_string())
        .execute(&w.f.store.pool).await.unwrap();
}

async fn other_conversation(w: &Window) -> (ConversationId, ExecutionWindowRequest) {
    let other = ConversationId(Uuid::new_v4());
    sqlx::query("INSERT INTO conversations(id,owner_id,standalone) VALUES(?,?,1)")
        .bind(other.to_string())
        .bind(w.f.owner.to_string())
        .execute(&w.f.store.pool)
        .await
        .unwrap();
    let receipt =
        w.f.store
            .admit(
                &w.f.owner,
                &other,
                &MessageInput {
                    client_message_id: "other-saved-input".into(),
                    text: "synthetic saved input".into(),
                },
            )
            .await
            .unwrap()
            .receipt;
    let request = ExecutionWindowRequest {
        request_key: "window:other-saved-input".into(),
        input_message_id: receipt.message_id,
        input_event_id: receipt.event_id,
        input_request_key: "other-saved-input".into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    (other, request)
}

fn other_config() -> ProductionSupervisorConfig {
    ProductionSupervisorConfig {
        provider: ProviderKind::Codex,
        namespace: "synthetic-other-conversation".into(),
        supervisor_key: "other-supervisor".into(),
        takeover: ProductionTakeover::First,
    }
}

async fn scalar(store: &Store, sql: &str, bind: &str) -> String {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}
async fn count(store: &Store, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}
async fn window_state(store: &Store, window: Uuid) -> String {
    scalar(
        store,
        "SELECT state FROM execution_windows WHERE id=?",
        &window.to_string(),
    )
    .await
}

/// Plan, then commit exactly that plan (what the server does around the
/// manager step). A committed window replays from the plan call itself.
async fn reconcile(
    store: &Store,
    w: &Window,
    decision: Decision,
    actor: Actor,
) -> Result<ExecutionWindowReconciliation> {
    match store
        .plan_stranded_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
            decision,
            actor,
        )
        .await?
    {
        StrandedExecutionWindow::Reconciled(receipt) => Ok(receipt),
        StrandedExecutionWindow::Pending(plan) => {
            store
                .reconcile_stranded_execution_window_authenticated(
                    &w.browser_credential,
                    &plan,
                    decision,
                    actor,
                )
                .await
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_with_pending_acceptance_abandons_once_without_rerun_or_late_accept() {
    let p = pending().await;
    let w = &p.w;
    let (other, other_input) = other_conversation(w).await;
    // Before restart the live opener still owns the window: no reconciliation.
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(matches!(
        reconcile(&w.f.store, w, Decision::AbandonUnaccepted, Actor::Owner).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    let fresh = restart(w, true).await;
    // Live blocker: retirement needs the lost boot+credential, so the stranded
    // conversation can never open a successor window on its own.
    assert!(matches!(
        fresh
            .recover_retired_execution_window_authenticated(
                &w.browser_credential,
                &w.f.conversation,
                fixtures::config(ProductionTakeover::First),
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    let runs_before = count(&fresh, "SELECT count(*) FROM production_runs").await;
    let observations_before = count(&fresh, "SELECT count(*) FROM production_observations").await;

    let StrandedExecutionWindow::Pending(plan) = fresh
        .plan_stranded_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
            Decision::AbandonUnaccepted,
            Actor::Startup,
        )
        .await
        .unwrap()
    else {
        panic!("unreconciled window must plan")
    };
    assert_eq!(plan.outcome, Outcome::Abandoned);
    assert_eq!(plan.prior_run_id, Some(p.deep.run.run_id.clone()));
    assert_eq!(plan.terminal_event_id, Some(p.deep_done.clone()));
    assert!(plan.hard_deadline_passed);

    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert!(!receipt.duplicate);
    assert_eq!(receipt.actor, Actor::Startup);
    assert_eq!(receipt.outcome, Outcome::Abandoned);
    assert_eq!(receipt.prior_run_id, Some(p.deep.run.run_id.clone()));
    assert_eq!(receipt.terminal_event_id, Some(p.deep_done.clone()));
    let mut expected = vec![p.fast.run.run_id.clone(), p.deep.run.run_id.clone()];
    expected.sort_by_key(|r| r.to_string());
    assert_eq!(receipt.abandoned_run_ids, expected);
    assert!(receipt.released_input_event_ids.is_empty());

    // Explicitly abandoned, history retained, never accepted or re-executed.
    assert_eq!(window_state(&fresh, w.status.window_id).await, "closed");
    for (run, done) in [(&p.fast, &p.fast_done), (&p.deep, &p.deep_done)] {
        let id = run.run.run_id.to_string();
        assert_eq!(
            scalar(&fresh, "SELECT state FROM production_runs WHERE id=?", &id).await,
            "cancelled"
        );
        assert_eq!(
            scalar(&fresh, "SELECT terminal_kind||':'||event_id FROM production_terminal_evidence WHERE run_id=?", &id).await,
            format!("abandoned:{done}")
        );
        assert_eq!(
            scalar(
                &fresh,
                "SELECT b.state||':'||b.generation FROM session_bindings b JOIN production_runs r ON r.session_id=b.id WHERE r.id=?",
                &id
            )
            .await,
            format!("ready:{}", run.binding.generation + 1)
        );
    }
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_runs").await,
        runs_before
    );
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_observations").await,
        observations_before
    );
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_acceptances").await,
        0
    );
    assert_eq!(
        scalar(
            &fresh,
            "SELECT actor||':'||decision||':'||hard_deadline_passed FROM execution_window_reconciliations WHERE window_id=?",
            &w.status.window_id.to_string()
        )
        .await,
        "startup:abandon_unaccepted:1"
    );
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_run_abandonments").await,
        2
    );
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM production_supervisors WHERE lease_deadline_ms!=0"
        )
        .await,
        0
    );
    // The lost private credential is revoked: a surviving holder is fenced.
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM auth_sessions a JOIN execution_windows w ON w.credential_hash=a.token_hash").await,
        0
    );
    assert!(w
        .bound
        .activate_execution_window(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot"
        )
        .await
        .is_err());
    assert!(w
        .bound
        .retire_execution_window(
            w.credential.credential(),
            w.status.window_id,
            1,
            "role-test-boot",
            &p.deep.run.run_id
        )
        .await
        .is_err());

    // Accept after abandon is refused and changes nothing.
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(w.f.conversation.to_string())
            .fetch_one(&fresh.pool)
            .await
            .unwrap();
    let settled = fixtures::snapshot(&fresh).await;
    for (run, done) in [(&p.deep, &p.deep_done), (&p.fast, &p.fast_done)] {
        assert!(fresh
            .accept_execution_authenticated(
                &w.browser_credential,
                &w.f.conversation,
                &ExecutionAcceptanceRequest {
                    run_id: run.run.run_id.clone(),
                    completion_event_id: done.clone(),
                    expected_revision: revision,
                    request_key: format!("late-accept-{}", run.run.run_id),
                },
            )
            .await
            .is_err());
    }
    // Replays are idempotent; a different decision for the same window conflicts.
    let replay = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.reconciliation_id, receipt.reconciliation_id);
    assert!(matches!(
        reconcile(&fresh, w, Decision::RetireResolved, Actor::Owner).await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(settled, fixtures::snapshot(&fresh).await);

    // Another conversation with a saved input opens normally alongside.
    fresh
        .bootstrap_execution_window_authenticated(&w.browser_credential, &other, other_config())
        .await
        .unwrap();
    let admitted = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &other, &other_input)
        .await
        .unwrap();
    assert_eq!(admitted.status.generation, 1);
    assert_eq!(admitted.input_event_id, other_input.input_event_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_conversation_resumes_its_native_session_in_a_successor_window() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    let retired = fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    assert_eq!(retired.prior_run_id(), &p.deep.run.run_id);
    let mut request = input(&w.f, "after-abandon").await;
    request.expected_generation = 1;
    request.predecessor_window_id = Some(w.status.window_id);
    let next = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(next.status.generation, 2);
    let grant = retired
        .store()
        .issue_idle_execution_window_credential_authenticated(
            &w.browser_credential,
            next.status.window_id,
            2,
            "fresh-boot",
            next.status.expires_at_ms,
            &"c".repeat(64),
        )
        .await
        .unwrap();
    let (_, metadata) = fresh
        .reattach_terminal_supervisor(
            grant.credential(),
            fixtures::config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: retired.predecessor_incarnation().into(),
            }),
            &p.deep.run.run_id,
        )
        .await
        .unwrap();
    assert_eq!(
        metadata.binding().native_session_id,
        p.deep.binding.native_session_id
    );
    assert_eq!(metadata.binding().generation, p.deep.binding.generation + 1);
}

#[path = "stranded_decision_tests.rs"]
mod decisions;

#[path = "stranded_failure_tests.rs"]
mod failures;

#[path = "native_reset_tests.rs"]
mod native_reset_tests;
