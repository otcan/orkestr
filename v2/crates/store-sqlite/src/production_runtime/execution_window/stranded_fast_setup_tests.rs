use super::*;

#[path = "stranded_fast_bootstrap_tests.rs"]
mod bootstrap;
#[path = "stranded_fast_retirement_tests.rs"]
mod retirement;

async fn admitted_fast(w: &Window) -> RunAdmissionResult {
    let fast = w.ready_fast().await;
    w.activate().await;
    w.bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                fast_binding_id: fast.session_id,
                expected_binding_generation: fast.generation,
                request_key: "unstarted-fast-setup".into(),
            },
        )
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn never_dispatched_lapsed_fast_reconciles_as_failed_setup() {
    let w = Window::open().await;
    let admission = admitted_fast(&w).await;
    let DispatchClaimResult::Reserved(_) = w
        .bound
        .claim_provider_dispatch(&admission, "failed-setup-reservation")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let fresh = restart(&w, true).await;
    // A reservation without durable terminal/lapse evidence stays fenced.
    assert!(
        reconcile_window(&fresh, &w, w.status.window_id, 1, Actor::Owner)
            .await
            .is_err()
    );
    sqlx::query("UPDATE production_runs SET lease_deadline_ms=lease_deadline_ms-120000 WHERE id=?")
        .bind(admission.provider.run.run_id.to_string())
        .execute(&fresh.pool)
        .await
        .unwrap();
    let settled = fresh
        .settle_lapsed_runs_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
            Actor::Owner,
        )
        .await
        .unwrap();
    assert_eq!(settled, vec![admission.provider.run.run_id.clone()]);
    let before = scalar(&fresh, "SELECT r.state||':'||r.dispatch_state||':'||t.terminal_kind||':'||l.prior_state FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id JOIN production_run_lapses l ON l.run_id=r.id WHERE r.id=?", &admission.provider.run.run_id.to_string()).await;
    assert_eq!(before, "cancelled:reserved:failed:starting");
    let receipt = reconcile_window(&fresh, &w, w.status.window_id, 1, Actor::Owner)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.open_failure_cause, Some(Cause::SetupIncomplete));
    assert!(receipt.prior_run_id.is_none());
    assert_eq!(
        receipt.released_input_event_ids,
        vec![w.source.input_event_id.clone()]
    );
    assert_eq!(scalar(&fresh, "SELECT r.state||':'||r.dispatch_state||':'||t.terminal_kind||':'||l.prior_state FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id JOIN production_run_lapses l ON l.run_id=r.id WHERE r.id=?", &admission.provider.run.run_id.to_string()).await, before);
    assert!(
        reconcile_window(&fresh, &w, w.status.window_id, 1, Actor::Owner)
            .await
            .unwrap()
            .duplicate
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn consumed_fast_stays_ineligible_for_failed_setup() {
    let w = Window::open().await;
    let admission = admitted_fast(&w).await;
    let provider = w.consume(&admission).await.provider().clone();
    let fresh = restart(&w, true).await;
    sqlx::query("UPDATE production_runs SET lease_deadline_ms=lease_deadline_ms-120000 WHERE id=?")
        .bind(provider.run.run_id.to_string())
        .execute(&fresh.pool)
        .await
        .unwrap();
    fresh
        .settle_lapsed_runs_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
            Actor::Owner,
        )
        .await
        .unwrap();
    let before = fixtures::snapshot(&fresh).await;
    assert!(
        reconcile_window(&fresh, &w, w.status.window_id, 1, Actor::Owner)
            .await
            .is_err()
    );
    assert_eq!(before, fixtures::snapshot(&fresh).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lapsed_fast_setup_restores_successor_lineage() {
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
    let mut request = input(&w.f, "failed-fast-successor").await;
    request.expected_generation = 1;
    request.predecessor_window_id = Some(w.status.window_id);
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
            "failed-fast-boot",
            next.status.expires_at_ms,
            &"c".repeat(64),
        )
        .await
        .unwrap();
    let (bound, _) = fresh
        .reattach_terminal_supervisor(
            grant.credential(),
            fixtures::config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: retired.predecessor_incarnation().into(),
            }),
            &p.deep.run.run_id,
        )
        .await
        .unwrap();
    let fast = bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .fast;
    let setup = bound
        .authorize_bounded_fast_metadata(grant.credential(), &fast)
        .await
        .unwrap();
    let binding = setup.binding().clone();
    let fast = bound
        .confirm_metadata_session(
            setup,
            NativeSessionConfirmation {
                session_id: binding.session_id,
                expected_generation: binding.generation,
                native_session_id: "synthetic-failed-successor-fast".into(),
                protocol_version: "synthetic-codex-1".into(),
                source_event_key: "failed-successor-fast-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    bound
        .activate_execution_window(
            grant.credential(),
            next.status.window_id,
            2,
            "failed-fast-boot",
        )
        .await
        .unwrap();
    let admission = bound
        .admit_fast(
            grant.credential(),
            &FastAdmissionInput {
                source_message_id: request.input_message_id.clone(),
                source_event_id: request.input_event_id.clone(),
                fast_binding_id: fast.session_id,
                expected_binding_generation: fast.generation,
                request_key: "successor-reserved-fast".into(),
            },
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(_) = bound
        .claim_provider_dispatch(&admission, "successor-fast-reservation")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let fresh = restart_window(w, next.status.window_id, 2).await;
    sqlx::query("UPDATE production_runs SET lease_deadline_ms=lease_deadline_ms-120000 WHERE id=?")
        .bind(admission.provider.run.run_id.to_string())
        .execute(&fresh.pool)
        .await
        .unwrap();
    fresh
        .settle_lapsed_runs_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            next.status.window_id,
            2,
            Actor::Owner,
        )
        .await
        .unwrap();
    let receipt = reconcile_window(&fresh, w, next.status.window_id, 2, Actor::Owner)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.restored_window_id, Some(w.status.window_id));
    assert_eq!(
        receipt.released_input_event_ids,
        vec![request.input_event_id]
    );
    assert_eq!(window_state(&fresh, next.status.window_id).await, "closed");
    assert_eq!(
        scalar(
            &fresh,
            "SELECT state FROM production_runs WHERE id=?",
            &admission.provider.run.run_id.to_string()
        )
        .await,
        "cancelled"
    );
}
