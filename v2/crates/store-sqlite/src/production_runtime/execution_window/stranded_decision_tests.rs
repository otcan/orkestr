//! Owner decisions, deadline gating and refusal of uncertain turns.
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accept_then_retire_closes_without_abandoning() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    assert!(matches!(
        reconcile(&fresh, w, Decision::RetireResolved, Actor::Owner).await,
        Err(RuntimeStoreError::Fenced)
    ));
    for (run, done) in [(&p.fast, &p.fast_done), (&p.deep, &p.deep_done)] {
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
                .bind(w.f.conversation.to_string())
                .fetch_one(&fresh.pool)
                .await
                .unwrap();
        fresh
            .accept_execution_authenticated(
                &w.browser_credential,
                &w.f.conversation,
                &ExecutionAcceptanceRequest {
                    run_id: run.run.run_id.clone(),
                    completion_event_id: done.clone(),
                    expected_revision: revision,
                    request_key: format!("owner-accept-{}", run.run.run_id),
                },
            )
            .await
            .unwrap();
    }
    let receipt = reconcile(&fresh, w, Decision::RetireResolved, Actor::Owner)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Accepted);
    assert!(receipt.abandoned_run_ids.is_empty());
    assert_eq!(window_state(&fresh, w.status.window_id).await, "closed");
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM production_graceful_retirements"
        )
        .await,
        1
    );
    let (other, _) = other_conversation(w).await;
    fresh
        .bootstrap_execution_window_authenticated(&w.browser_credential, &other, other_config())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_waits_for_deadline_but_owner_may_abandon_explicitly() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, false).await;
    let before = fixtures::snapshot(&fresh).await;
    assert!(matches!(
        reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup).await,
        Err(RuntimeStoreError::Fenced)
    ));
    let StrandedExecutionWindow::Pending(plan) = fresh
        .plan_stranded_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
            Decision::AbandonUnaccepted,
            Actor::Owner,
        )
        .await
        .unwrap()
    else {
        panic!("pending plan")
    };
    assert!(!plan.hard_deadline_passed);
    assert!(matches!(
        fresh
            .reconcile_stranded_execution_window_authenticated(
                "not-a-browser-session",
                &plan,
                Decision::AbandonUnaccepted,
                Actor::Owner,
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    // A plan that no longer matches Core (e.g. concurrent acceptance) conflicts.
    let mut stale = plan.clone();
    stale.outcome = Outcome::Accepted;
    assert!(matches!(
        fresh
            .reconcile_stranded_execution_window_authenticated(
                &w.browser_credential,
                &stale,
                Decision::AbandonUnaccepted,
                Actor::Owner,
            )
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    assert_eq!(receipt.actor, Actor::Owner);
    assert_eq!(receipt.outcome, Outcome::Abandoned);
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM execution_window_reconciliations WHERE actor='owner' AND hard_deadline_passed=0"
        )
        .await,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uncertain_running_turn_is_never_abandoned_or_rerun() {
    let w = Window::open().await;
    w.activate().await;
    let deep = deep_dispatch(&w, "stranded-running").await;
    w.bound
        .append_provider_event(
            &w.f.owner,
            deep.provider(),
            &observation(deep.provider(), 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let fresh = restart(&w, true).await;
    let before = fixtures::snapshot(&fresh).await;
    for decision in [Decision::AbandonUnaccepted, Decision::RetireResolved] {
        assert!(matches!(
            reconcile(&fresh, &w, decision, Actor::Owner).await,
            Err(RuntimeStoreError::Fenced)
        ));
    }
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    assert_eq!(
        window_state(&fresh, w.status.window_id).await,
        "reconciliation_required"
    );
}
