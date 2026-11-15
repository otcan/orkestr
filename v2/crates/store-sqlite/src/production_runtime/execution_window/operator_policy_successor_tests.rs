//! ORK-837: the standing operator switch waits only for work ahead of or in
//! flight with its source. Synthetic Core rows; no native/provider process.
use super::*;
use orkestr_v2_contracts::{QueuedWindowState, QueuedWindowWithdrawal};

async fn queued_keys(store: &Store, w: &Window) -> Vec<String> {
    store
        .execution_window_queue_authenticated(&w.browser_credential, Some(&w.f.conversation))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.request_key)
        .collect()
}

async fn inbox_state(store: &Store, input: &ExecutionWindowRequest) -> String {
    sqlx::query_scalar("SELECT state FROM reasoning_inbox WHERE message_id=?")
        .bind(input.input_message_id.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

/// A host result handed back to the Deep run that asked for it: the original
/// intake evidence for that run and the current provider generation.
async fn fence(store: &Store, input: &ExecutionWindowRequest, run: &RunId) {
    sqlx::query("INSERT INTO source_admission_fences(message_id,expected_provider_generation,source_run_id,source_native_session_id,source_provider,source_binding_generation) SELECT ?,s.provider_generation,r.id,r.native_session_id,r.provider_kind,r.binding_generation FROM production_runs r JOIN conversation_settings s ON s.conversation_id=r.conversation_id WHERE r.id=?")
        .bind(input.input_message_id.to_string()).bind(run.to_string())
        .execute(&store.pool).await.unwrap();
}

#[tokio::test]
async fn operator_policy_handoff_admits_source_first_and_withdraws_superseded_successors() {
    let (p, store, source, proof, request) = super::operator_tests::ready().await;
    let w = &p.w;
    let (browser, conversation) = (&w.browser_credential, &w.f.conversation);
    // Matched while the window was active: the source queued first, and the
    // inputs that inherited its match queued behind it.
    store
        .enqueue_execution_window_authenticated(browser, conversation, &source)
        .await
        .unwrap();
    let mut results = Vec::new();
    for key in ["synthetic-host-result-one", "synthetic-host-result-two"] {
        let result = input(&w.f, key).await;
        store
            .enqueue_execution_window_authenticated(browser, conversation, &result)
            .await
            .unwrap();
        fence(&store, &result, &p.deep.run.run_id).await;
        results.push(result);
    }
    let timer = input(&w.f, "synthetic-timer-firing").await;
    store
        .enqueue_execution_window_authenticated(browser, conversation, &timer)
        .await
        .unwrap();
    // Nobody requested a window for this one: neither ahead nor in flight.
    let unscheduled = input(&w.f, "synthetic-unscheduled-input").await;
    assert!(
        store
            .handoff_provider_authenticated(browser, conversation, &request)
            .await
            .is_err(),
        "the owner's own handoff still requires an empty queue"
    );
    let (receipt, superseded) = store
        .handoff_provider_for_operator_policy(browser, conversation, &request, &proof)
        .await
        .unwrap();
    assert_eq!(receipt.to_provider, ConversationProvider::Codex);
    assert_eq!(
        superseded,
        results
            .iter()
            .map(|result| result.input_event_id.clone())
            .collect::<Vec<_>>()
    );
    for result in &results {
        let row = store
            .queued_execution_window_authenticated(browser, conversation, result)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (row.state, row.withdrawal),
            (
                QueuedWindowState::Withdrawn,
                Some(QueuedWindowWithdrawal::InputUnavailable)
            )
        );
        assert!(store
            .execution_window_input_retired_authenticated(browser, conversation, result)
            .await
            .unwrap());
    }
    assert_eq!(
        count(
            &store,
            "SELECT count(*) FROM owner_input_retirements WHERE reason='source_superseded'"
        )
        .await,
        2
    );
    // Successors keep their order behind the source; others are untouched.
    assert_eq!(
        queued_keys(&store, w).await,
        vec![source.request_key.clone(), timer.request_key.clone()]
    );
    assert_eq!(inbox_state(&store, &unscheduled).await, "queued");
    // A replay reports the same switch and settles nothing again.
    assert_eq!(
        store
            .handoff_provider_for_operator_policy(browser, conversation, &request, &proof)
            .await
            .unwrap(),
        (receipt.clone(), Vec::new())
    );
    assert!(store
        .execution_window_provider_handoff_pending_authenticated(browser, conversation)
        .await
        .unwrap());
    // The source opens the successor window first, under the new provider.
    let mut first = source.clone();
    first.expected_generation = w.status.generation;
    first.predecessor_window_id = Some(w.status.window_id);
    let opened = store
        .admit_execution_window_capped_authenticated(browser, conversation, &first, 8)
        .await
        .unwrap()
        .status;
    assert_eq!(opened.generation, w.status.generation + 1);
    let settings = store
        .conversation_settings(browser, &w.f.owner, conversation)
        .await
        .unwrap();
    assert_eq!(
        (settings.provider, settings.provider_generation),
        (ConversationProvider::Codex, receipt.provider_generation)
    );
    assert_eq!(
        queued_keys(&store, w).await,
        vec![timer.request_key.clone()]
    );
    // Then the next successor joins it, in order.
    sqlx::query("UPDATE execution_windows SET state='active' WHERE id=?")
        .bind(opened.window_id.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    let mut next = timer.clone();
    next.expected_generation = opened.generation;
    next.window_id = Some(opened.window_id);
    store
        .admit_execution_window_capped_authenticated(browser, conversation, &next, 8)
        .await
        .unwrap();
    assert!(queued_keys(&store, w).await.is_empty());
}

#[tokio::test]
async fn operator_policy_handoff_waits_for_work_ahead_or_in_flight_never_for_unscheduled_input() {
    let (p, store, earlier, mut proof, request) = super::operator_tests::ready().await;
    let w = &p.w;
    let (browser, conversation) = (&w.browser_credential, &w.f.conversation);
    let source = input(&w.f, "synthetic-later-policy-source").await;
    proof.source_message_id = source.input_message_id.clone();
    // An intent queued before the source's own is work ahead of it.
    for queued in [&earlier, &source] {
        store
            .enqueue_execution_window_authenticated(browser, conversation, queued)
            .await
            .unwrap();
    }
    assert!(matches!(
        store
            .handoff_provider_for_operator_policy(browser, conversation, &request, &proof)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    // Withdrawn, the earlier input is an inbox row nobody admits: an older
    // input without a window intent is not ahead of the source.
    store
        .withdraw_queued_execution_window_authenticated(
            browser,
            conversation,
            &earlier.request_key,
            QueuedWindowWithdrawal::InputUnavailable,
        )
        .await
        .unwrap();
    // A claimed input is in flight, wherever it is in the sequence.
    let claimed = input(&w.f, "synthetic-claimed-input").await;
    sqlx::query("UPDATE reasoning_inbox SET state='claimed',claimant_session_id=?,claim_deadline_ms=1 WHERE message_id=?")
        .bind(p.deep.binding.session_id.to_string()).bind(claimed.input_message_id.to_string())
        .execute(&store.pool).await.unwrap();
    assert!(matches!(
        store
            .handoff_provider_for_operator_policy(browser, conversation, &request, &proof)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(
        count(
            &store,
            "SELECT count(*) FROM conversation_provider_handoffs"
        )
        .await,
        0
    );
    sqlx::query("UPDATE reasoning_inbox SET state='queued',claimant_session_id=NULL,claim_deadline_ms=NULL WHERE message_id=?")
        .bind(claimed.input_message_id.to_string())
        .execute(&store.pool).await.unwrap();
    let (receipt, superseded) = store
        .handoff_provider_for_operator_policy(browser, conversation, &request, &proof)
        .await
        .unwrap();
    assert_eq!(receipt.to_provider, ConversationProvider::Codex);
    assert!(superseded.is_empty());
    // Unscheduled inputs, older or newer, are left exactly as they were.
    assert_eq!(inbox_state(&store, &earlier).await, "queued");
    assert_eq!(inbox_state(&store, &claimed).await, "queued");
    assert_eq!(
        queued_keys(&store, w).await,
        vec![source.request_key.clone()]
    );
}
