//! ORK-798: the two shapes the ORK-783 clean-up left behind, built the way
//! production built them. A window's Deep turn gets three host results
//! handed back: one a Deep session claimed, one Fast answered on its own
//! (Fast once ran on every input), one nothing touched. The window then ends
//! in a reconciliation. The first two stay in it for good (claimed / with a
//! run, so never queued again) and count as eligible input; the third is
//! queued again for the dispatcher. Only the first two may be settled.
use super::*;
use orkestr_v2_contracts::{
    OwnerInputRetirementReceipt, OwnerInputRetirementRequest, OwnerInputRetirementState,
    StaleInputSettlementRequest, STALE_INPUT_SETTLEMENT_REASON,
};

struct Stale {
    w: Window,
    fresh: Store,
    claimed: ExecutionWindowRequest,
    fast_done: ExecutionWindowRequest,
    untouched: Option<ExecutionWindowRequest>,
    fast_run: String,
}

fn settle(key: &str) -> StaleInputSettlementRequest {
    StaleInputSettlementRequest {
        request_key: key.into(),
    }
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
                request_key: format!("owner-accept-{}", run.run.run_id),
            },
        )
        .await
        .unwrap();
}

/// Deep answers the window's input; results come back for it. A Deep claim
/// takes the first and lapses, Fast answers the second, a third (only with
/// `untouched`) waits. The owner accepts both turns, then the window is
/// reconciled and closed.
async fn stale(untouched: bool) -> Stale {
    let w = Window::open().await;
    let fast = w.ready_fast().await;
    w.activate().await;
    let deep = deep_dispatch(&w, "stale-source-deep")
        .await
        .provider()
        .clone();
    let deep_done = propose(&w, &deep).await;
    let claimed = handed_back(&w, &deep, "automatic-host-result-synthetic-claimed").await;
    let fast_done = handed_back(&w, &deep, "automatic-host-result-synthetic-fast").await;
    let untouched = if untouched {
        Some(handed_back(&w, &deep, "automatic-host-result-synthetic-untouched").await)
    } else {
        None
    };
    let admission = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: fast_done.input_message_id.clone(),
                source_event_id: fast_done.input_event_id.clone(),
                fast_binding_id: fast.session_id.clone(),
                expected_binding_generation: fast.generation,
                request_key: "stale-result-fast".into(),
            },
        )
        .await
        .unwrap();
    let fast_run = w.consume(&admission).await.provider().clone();
    let fast_completed = propose(&w, &fast_run).await;
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
    assert_eq!(claim.event_id, claimed.input_event_id);
    let fresh = restart(&w, true).await;
    for (run, done) in [(&fast_run, &fast_completed), (&deep, &deep_done)] {
        accept(&fresh, &w, run, done).await;
    }
    // The claim lapsed long ago (its 30 s lease), as on the live rows.
    sqlx::query(
        "UPDATE reasoning_inbox SET claim_deadline_ms=claim_deadline_ms-86400000 WHERE event_id=?",
    )
    .bind(claimed.input_event_id.to_string())
    .execute(&fresh.pool)
    .await
    .unwrap();
    let receipt = reconcile(&fresh, &w, Decision::RetireResolved, Actor::Owner)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::Accepted);
    assert_eq!(
        receipt.released_input_event_ids.len(),
        2 + usize::from(untouched.is_some())
    );
    assert_eq!(window_state(&fresh, w.status.window_id).await, "closed");
    Stale {
        w,
        fresh,
        claimed,
        fast_done,
        untouched,
        fast_run: fast_run.run.run_id.to_string(),
    }
}

async fn inbox(store: &Store, event: &EventId) -> (String, Option<String>) {
    sqlx::query_as("SELECT state,claimant_session_id FROM reasoning_inbox WHERE event_id=?")
        .bind(event.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

async fn eligible(s: &Stale) -> bool {
    s.fresh
        .held_owner_inputs_for_browser(&s.w.browser_credential, &s.w.f.conversation, 0, 50)
        .await
        .unwrap()
        .eligible_input_available
}

/// Everything settling must never create.
async fn effects(store: &Store) -> String {
    sqlx::query_scalar("SELECT json_array((SELECT count(*) FROM messages),(SELECT count(*) FROM events),(SELECT count(*) FROM outbox),(SELECT count(*) FROM production_runs),(SELECT count(*) FROM fixture_runs),(SELECT count(*) FROM execution_windows),(SELECT count(*) FROM execution_window_queue),(SELECT count(*) FROM execution_window_inputs))")
        .fetch_one(&store.pool).await.unwrap()
}

async fn settled(
    s: &Stale,
    input: &ExecutionWindowRequest,
    key: &str,
) -> Result<OwnerInputRetirementReceipt> {
    s.fresh
        .settle_stale_input_for_browser(
            &s.w.browser_credential,
            &s.w.f.conversation,
            &input.input_message_id,
            &settle(key),
        )
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_claim_and_finished_fast_result_settle_once_and_stop_counting_as_eligible() {
    let s = stale(false).await;
    let fresh = &s.fresh;
    // The ordinary owner input the window never admitted is retired the
    // ordinary way, so only the two stale results remain eligible.
    fresh
        .retire_owner_input_for_browser(
            &s.w.browser_credential,
            &s.w.f.conversation,
            &s.w.old.input_message_id,
            &OwnerInputRetirementRequest {
                request_key: "retire-unadmitted".into(),
                reason: "Synthetic obsolete input".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        inbox(fresh, &s.claimed.input_event_id).await,
        (
            "claimed".into(),
            Some(s.w.roles.deep.session_id.to_string())
        )
    );
    assert_eq!(inbox(fresh, &s.fast_done.input_event_id).await.0, "queued");
    assert!(
        eligible(&s).await,
        "the stale results count as eligible input"
    );
    let before = effects(fresh).await;
    let mut receipts = Vec::new();
    for (input, key) in [
        (&s.claimed, "ork798:claimed"),
        (&s.fast_done, "ork798:fast"),
    ] {
        let receipt = settled(&s, input, key).await.unwrap();
        assert!(!receipt.duplicate);
        assert_eq!(receipt.reason, STALE_INPUT_SETTLEMENT_REASON);
        assert_eq!(receipt.message_id, input.input_message_id);
        assert_eq!(receipt.event_id, input.input_event_id);
        assert_eq!(receipt.state, OwnerInputRetirementState::Retired);
        assert_eq!(
            inbox(fresh, &input.input_event_id).await,
            ("retired".into(), None)
        );
        receipts.push(receipt);
    }
    assert!(
        !eligible(&s).await,
        "settled results never count as eligible input"
    );
    assert_eq!(effects(fresh).await, before);
    // The Fast run and the window queue history are kept as they were.
    assert_eq!(
        scalar(
            fresh,
            "SELECT state FROM production_runs WHERE id=?",
            &s.fast_run
        )
        .await,
        "succeeded"
    );
    assert_eq!(
        count(
            fresh,
            "SELECT count(*) FROM owner_input_retirements WHERE reason='operator_settled_stale'"
        )
        .await,
        2
    );
    // Idempotent by request key, also after a reopen; a changed decision
    // under a key, or a second key for a settled input, conflicts.
    let reopened = Store::open(&s.w.f.root.join("core.sqlite3")).await.unwrap();
    let mut again = reopened
        .settle_stale_input_for_browser(
            &s.w.browser_credential,
            &s.w.f.conversation,
            &s.claimed.input_message_id,
            &settle("ork798:claimed"),
        )
        .await
        .unwrap();
    assert!(again.duplicate);
    again.duplicate = false;
    assert_eq!(again, receipts[0]);
    for (input, key) in [
        (&s.fast_done, "ork798:claimed"),
        (&s.claimed, "ork798:other-key"),
        (&s.w.old, "retire-unadmitted"),
    ] {
        assert!(matches!(
            settled(&s, input, key).await,
            Err(RuntimeStoreError::Conflict)
        ));
    }
    // Receipts and the terminal state are immutable.
    for sql in [
        "UPDATE reasoning_inbox SET state='queued' WHERE state='retired'",
        "UPDATE owner_input_retirements SET reason='changed'",
        "DELETE FROM owner_input_retirements",
    ] {
        assert!(
            sqlx::query(sql).execute(&fresh.pool).await.is_err(),
            "{sql}"
        );
    }
    assert_eq!(effects(fresh).await, before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settlement_refuses_live_unfinished_queued_or_ordinary_input_without_writes() {
    let s = stale(true).await;
    let fresh = &s.fresh;
    let untouched = s.untouched.as_ref().unwrap();
    let before = effects(fresh).await;
    let conflict =
        |r: Result<OwnerInputRetirementReceipt>| matches!(r, Err(RuntimeStoreError::Conflict));
    // A claim that has not lapsed yet.
    let event = s.claimed.input_event_id.to_string();
    sqlx::query("UPDATE reasoning_inbox SET claim_deadline_ms=claim_deadline_ms+2*86400000 WHERE event_id=?")
        .bind(&event).execute(&fresh.pool).await.unwrap();
    assert!(conflict(settled(&s, &s.claimed, "k:live-claim").await));
    sqlx::query("UPDATE reasoning_inbox SET claim_deadline_ms=claim_deadline_ms-2*86400000 WHERE event_id=?")
        .bind(&event).execute(&fresh.pool).await.unwrap();
    // A Fast run that has not finished.
    for state in ["running", "awaiting_acceptance", "blocked"] {
        sqlx::query("UPDATE production_runs SET state=? WHERE id=?")
            .bind(state)
            .bind(&s.fast_run)
            .execute(&fresh.pool)
            .await
            .unwrap();
        assert!(
            conflict(settled(&s, &s.fast_done, "k:fast-unfinished").await),
            "{state}"
        );
    }
    sqlx::query("UPDATE production_runs SET state='succeeded' WHERE id=?")
        .bind(&s.fast_run)
        .execute(&fresh.pool)
        .await
        .unwrap();
    // A window that is not closed (still retiring).
    sqlx::query("UPDATE execution_windows SET state='retiring' WHERE id=?")
        .bind(s.w.status.window_id.to_string())
        .execute(&fresh.pool)
        .await
        .unwrap();
    for (input, key) in [(&s.claimed, "k:open-a"), (&s.fast_done, "k:open-b")] {
        assert!(conflict(settled(&s, input, key).await));
    }
    sqlx::query("UPDATE execution_windows SET state='closed' WHERE id=?")
        .bind(s.w.status.window_id.to_string())
        .execute(&fresh.pool)
        .await
        .unwrap();
    // A result queued again for the dispatcher, the window's own input
    // (consumed by Deep) and an ordinary owner message without a fence.
    assert_eq!(queue(fresh, &untouched.input_event_id).await.0, "queued");
    for (input, key) in [
        (untouched, "k:in-line"),
        (&s.w.source, "k:deep-consumed"),
        (&s.w.old, "k:ordinary"),
    ] {
        assert!(conflict(settled(&s, input, key).await));
    }
    // Only the owner's own browser session settles.
    let service = "browser:synthetic-service-session";
    sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at,kind) VALUES(?,?,unixepoch()+600,'service_browser')")
        .bind(crate::digest(service)).bind(s.w.f.owner.to_string())
        .execute(&fresh.pool).await.unwrap();
    for credential in [service, s.w.f.token.as_str(), "", "browser:unknown"] {
        assert!(matches!(
            fresh
                .settle_stale_input_for_browser(
                    credential,
                    &s.w.f.conversation,
                    &s.claimed.input_message_id,
                    &settle("k:auth")
                )
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
    }
    assert!(matches!(
        s.w.bound
            .settle_stale_input_for_browser(
                &s.w.browser_credential,
                &s.w.f.conversation,
                &s.claimed.input_message_id,
                &settle("k:auth")
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        fresh
            .settle_stale_input_for_browser(
                &s.w.browser_credential,
                &ConversationId(Uuid::new_v4()),
                &s.claimed.input_message_id,
                &settle("k:scope")
            )
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert!(matches!(
        fresh
            .settle_stale_input_for_browser(
                &s.w.browser_credential,
                &s.w.f.conversation,
                &s.claimed.input_message_id,
                &settle("not a key")
            )
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    assert_eq!(
        count(fresh, "SELECT count(*) FROM owner_input_retirements").await,
        0
    );
    assert_eq!(effects(fresh).await, before);
    // With every guard restored, the same two inputs do settle.
    for (input, key) in [(&s.claimed, "k:claimed"), (&s.fast_done, "k:fast")] {
        settled(&s, input, key).await.unwrap();
    }
}
