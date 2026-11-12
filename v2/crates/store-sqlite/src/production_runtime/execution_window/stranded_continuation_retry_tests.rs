//! ORK-783: host results handed back to a window's Deep turn joined that
//! window and were still waiting when it ended in a reconciliation. Core
//! claims only inputs of the current window and nothing re-admits a result,
//! so they stayed queued for good (about 860 on 2026-11-12). Each is queued
//! again exactly once; the next window takes it only while its source fence
//! holds, and one whose fence fails is retired with a receipt.
use super::*;
use orkestr_v2_contracts::{EventId, InputAuthor, MessageInput, QueuedWindowWithdrawal};

/// A result for `source`, admitted while it runs and joined to its window,
/// as the queue dispatcher does.
async fn handed_back(w: &Window, source: &ProviderAdmission, key: &str) -> ExecutionWindowRequest {
    let receipt =
        w.f.store
            .admit_authenticated_attributed(
                &w.browser_credential,
                &w.f.owner,
                &w.f.conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: format!("Synthetic host result {key}"),
                },
                None,
                Some(0),
                Some(&source.run.run_id),
                Some(InputAuthor::V1Agent),
                None,
            )
            .await
            .unwrap()
            .receipt;
    let request = ExecutionWindowRequest {
        request_key: format!("source-continuation:{}", receipt.event_id.0),
        input_message_id: receipt.message_id,
        input_event_id: receipt.event_id,
        input_request_key: key.into(),
        expected_generation: 1,
        window_id: Some(w.status.window_id),
        predecessor_window_id: None,
    };
    w.f.store
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    request
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

/// The dispatcher's next round for a requeued result: the same input under
/// its retry key, after the closed window.
fn retried(result: &ExecutionWindowRequest, w: &Window) -> ExecutionWindowRequest {
    ExecutionWindowRequest {
        request_key: format!("source-continuation:{}:retry1", result.input_event_id.0),
        window_id: None,
        predecessor_window_id: Some(w.status.window_id),
        ..result.clone()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_result_released_by_a_window_reconciliation_gets_one_more_window() {
    let p = pending().await;
    let w = &p.w;
    let result = handed_back(w, &p.deep, "automatic-host-result-synthetic-released").await;
    let event = result.input_event_id.clone();
    let fresh = restart(w, true).await;
    // The owner accepts both turns; the window then retires and releases the
    // result, which never ran.
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
    assert_eq!(receipt.released_input_event_ids, vec![event.clone()]);
    // Queued again under its first retry key, no longer tied to that window.
    let next = retried(&result, w);
    assert_eq!(
        queue(&fresh, &event).await,
        ("queued".into(), next.request_key.clone(), None)
    );
    // Its source turn was accepted and nothing used the session since: the
    // fence holds and the successor window takes it, once.
    fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let admitted = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &next)
        .await
        .unwrap();
    assert_eq!(admitted.status.generation, 2);
    assert_eq!(admitted.input_event_id, event);
    assert_eq!(
        queue(&fresh, &event).await,
        (
            "dispatched".into(),
            next.request_key.clone(),
            Some(admitted.status.window_id.to_string())
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
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn released_results_of_an_abandoned_turn_are_retired_not_stranded() {
    let p = pending().await;
    let w = &p.w;
    let first = handed_back(w, &p.deep, "automatic-host-result-synthetic-a").await;
    let second = handed_back(w, &p.deep, "automatic-host-result-synthetic-b").await;
    let fresh = restart(w, true).await;
    let receipt = reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Abandoned);
    let mut released = receipt.released_input_event_ids.clone();
    released.sort_by_key(|event| event.to_string());
    let mut expected = vec![first.input_event_id.clone(), second.input_event_id.clone()];
    expected.sort_by_key(|event| event.to_string());
    assert_eq!(released, expected);
    for result in [&first, &second] {
        let next = retried(result, w);
        assert_eq!(
            queue(&fresh, &result.input_event_id).await,
            ("queued".into(), next.request_key.clone(), None)
        );
        // The source turn was abandoned: the dispatcher's fence check fails
        // and it withdraws the intent, which now also retires the input.
        assert!(matches!(
            fresh
                .inspect_execution_window_request_authenticated(
                    &w.browser_credential,
                    &w.f.conversation,
                    &next,
                )
                .await,
            Err(RuntimeStoreError::Fenced)
        ));
        fresh
            .withdraw_queued_execution_window_authenticated(
                &w.browser_credential,
                &w.f.conversation,
                &next.request_key,
                QueuedWindowWithdrawal::InputUnavailable,
            )
            .await
            .unwrap();
    }
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM reasoning_inbox i JOIN owner_input_retirements r ON r.event_id=i.event_id WHERE i.state='retired' AND r.reason='source_superseded'"
        )
        .await,
        2
    );
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM reasoning_inbox i JOIN source_admission_fences f ON f.message_id=i.message_id WHERE i.state='queued'"
        )
        .await,
        0
    );
}
