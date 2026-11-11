//! ORK-795: a timer occurrence joined a busy window and was still waiting
//! when that window ended in a turn reconciliation (2026-11-11: a chat's
//! daily check was released and never ran). Nothing of it ran, so it is queued
//! again exactly once, like after a failed open, and the successor window
//! takes it.
use super::*;
use crate::history_import::timers::{
    authority::DurableTimerEnable, TimerEnableRequest, TimerImportRequest, TimerSchedule,
    TimerTarget,
};
use orkestr_v2_contracts::EventId;

/// One due occurrence of a fresh timer, admitted with its queued window intent.
async fn fired(w: &Window) -> ExecutionWindowRequest {
    let f = &w.f;
    let namespace = Uuid::new_v4();
    f.store
        .import_dormant_timer_for(
            &w.browser_credential,
            &f.owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-v1".into(),
                source_timer_id: "timer-turn-retry".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval { every_ms: 60_000 },
            },
            &TimerTarget {
                conversation_id: f.conversation.clone(),
                label: "Synthetic turn retry".into(),
                source_thread_id: "synthetic-thread".into(),
            },
        )
        .await
        .unwrap();
    f.store
        .enable_durable_timer(
            &w.browser_credential,
            &f.owner,
            &DurableTimerEnable {
                timer: TimerEnableRequest {
                    namespace,
                    expected_revision: 1,
                    request_key: "enable-turn-retry".into(),
                    conversation_id: f.conversation.clone(),
                },
                instruction: "Synthetic scheduled task".into(),
            },
        )
        .await
        .unwrap();
    sqlx::query("UPDATE dormant_timers SET next_due_ms=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-1 WHERE namespace=?")
        .bind(namespace.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let issuer = w.bound.authorize_timer_scheduler(namespace).await.unwrap();
    let timer = w
        .bound
        .admit_authorized_timer_turn(&issuer, namespace, true)
        .await
        .unwrap();
    ExecutionWindowRequest {
        request_key: format!("timer-window:{}", timer.input.event_id.0),
        input_message_id: timer.input.message_id.clone(),
        input_event_id: timer.input.event_id.clone(),
        input_request_key: format!("timer:{}", timer.claim.claim_id),
        expected_generation: 1,
        window_id: None,
        predecessor_window_id: None,
    }
}

async fn queue(store: &Store, event: &EventId) -> (String, String, Option<String>) {
    sqlx::query_as(
        "SELECT state,request_key,window_id FROM execution_window_queue WHERE event_id=?",
    )
    .bind(event.to_string())
    .fetch_one(&store.pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timer_released_by_a_turn_reconciliation_is_queued_again_once() {
    let p = pending().await;
    let w = &p.w;
    // The occurrence joins the busy window, as the queue dispatcher does,
    // and waits behind the turn that is awaiting acceptance.
    let timer = fired(w).await;
    let event = timer.input_event_id.clone();
    w.f.store
        .admit_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ExecutionWindowRequest {
                window_id: Some(w.status.window_id),
                ..timer.clone()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        queue(&w.f.store, &event).await,
        (
            "dispatched".into(),
            timer.request_key.clone(),
            Some(w.status.window_id.to_string())
        )
    );
    // The window ends in a turn reconciliation; the occurrence never ran.
    let fresh = restart(w, true).await;
    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Abandoned);
    assert_eq!(receipt.released_input_event_ids, vec![event.clone()]);
    // Queued again under its first retry key, no longer tied to that window.
    let retry = format!("timer-window:{}:retry1", event.0);
    assert_eq!(
        queue(&fresh, &event).await,
        ("queued".into(), retry.clone(), None)
    );
    let listed = fresh
        .conversation_timer_inputs(&w.browser_credential, &w.f.owner, &w.f.conversation, 0, 10)
        .await
        .unwrap();
    assert_eq!(listed[0].window.as_deref(), Some("queued"));
    // The dispatcher opens the successor window for it: the same occurrence,
    // one queue row, and still no run of it.
    fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let next = fresh
        .admit_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ExecutionWindowRequest {
                request_key: retry.clone(),
                predecessor_window_id: Some(w.status.window_id),
                ..timer.clone()
            },
        )
        .await
        .unwrap();
    assert_eq!(next.status.generation, 2);
    assert_eq!(next.input_event_id, event);
    assert_eq!(
        queue(&fresh, &event).await,
        (
            "dispatched".into(),
            retry,
            Some(next.status.window_id.to_string())
        )
    );
    assert_eq!(
        count(
            &fresh,
            &format!(
                "SELECT count(*) FROM execution_window_queue WHERE event_id='{}'",
                event.0
            )
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &fresh,
            &format!(
                "SELECT count(*) FROM production_runs WHERE event_id='{}'",
                event.0
            )
        )
        .await,
        0
    );
}

/// An owner's message released the same way is not requeued by Core: its
/// sender (the adapter) decides, as after a failed open.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_reconciliation_requeues_only_timer_occurrences() {
    let p = pending().await;
    let w = &p.w;
    let mut follow_up = input(&w.f, "turn-released-follow-up").await;
    follow_up.expected_generation = 1;
    follow_up.window_id = Some(w.status.window_id);
    w.f.store
        .enqueue_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &follow_up,
        )
        .await
        .unwrap();
    w.f.store
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &follow_up)
        .await
        .unwrap();
    let fresh = restart(w, true).await;
    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(
        receipt.released_input_event_ids,
        vec![follow_up.input_event_id.clone()]
    );
    assert_eq!(
        queue(&fresh, &follow_up.input_event_id).await,
        (
            "dispatched".into(),
            follow_up.request_key.clone(),
            Some(w.status.window_id.to_string())
        )
    );
}
