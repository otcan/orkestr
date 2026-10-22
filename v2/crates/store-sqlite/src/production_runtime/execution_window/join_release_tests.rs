//! A follow-up joined to a window that never ran it (PA gen 21, 2026-10-22):
//! it keeps the window busy, a refused join is withdrawn, and a clean close
//! hands it to the successor window instead of stranding it.
use super::tests::{browser, input};
use super::*;
use crate::production_runtime::{observation_tests::input as observation, tests as fixtures};
use orkestr_v2_contracts::ExecutionAcceptanceRequest;
use std::time::Duration;

async fn window_inputs(f: &fixtures::Case, event: &EventId) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM execution_window_inputs WHERE event_id=?")
        .bind(event.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unstarted_follow_up_blocks_idle_switch_and_is_handed_to_the_successor_on_close() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let binding = fixtures::ready(&f).await;
    let request = input(&f, "join-first").await;
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
            "join-boot",
            a.status.expires_at_ms,
            &"c".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &cap)
        .await
        .unwrap();
    bound
        .activate_execution_window(cap.credential(), a.status.window_id, 1, "join-boot")
        .await
        .unwrap();
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
        .admit_run(&claim, &binding.session_id, binding.generation, "join-run")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&run, "join-dispatch")
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
    let p = dispatch.provider();
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
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    f.store
        .accept_execution_authenticated(
            &browser,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id.clone(),
                expected_revision: status.revision,
                request_key: "join-accept".into(),
            },
        )
        .await
        .unwrap();
    assert!(f
        .store
        .execution_window_switch_ready_authenticated(&browser, &f.conversation)
        .await
        .unwrap());

    // The follow-up joins after the last turn was accepted, but no run takes it.
    let mut follow = input(&f, "join-follow-up").await;
    follow.expected_generation = 1;
    follow.window_id = Some(a.status.window_id);
    f.store
        .admit_execution_window_authenticated(&browser, &f.conversation, &follow)
        .await
        .unwrap();
    // Not idle: an idle reclaim must not stop this window under it.
    assert!(!f
        .store
        .execution_window_switch_ready_authenticated(&browser, &f.conversation)
        .await
        .unwrap());

    bound
        .begin_execution_window_retirement(cap.credential(), a.status.window_id, 1, "join-boot")
        .await
        .unwrap();
    bound
        .retire_terminal_supervisor(cap.credential(), &p.run.run_id)
        .await
        .unwrap();
    bound
        .retire_execution_window(
            cap.credential(),
            a.status.window_id,
            1,
            "join-boot",
            &p.run.run_id,
        )
        .await
        .unwrap();
    // The close released the unstarted follow-up; the consumed input stays.
    assert_eq!(window_inputs(&f, &follow.input_event_id).await, 0);
    assert_eq!(window_inputs(&f, &request.input_event_id).await, 1);

    // The same input now opens the successor window.
    let mut next = follow.clone();
    next.request_key = "window:join-follow-up-successor".into();
    next.window_id = None;
    next.predecessor_window_id = Some(a.status.window_id);
    let b = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &next)
        .await
        .unwrap();
    assert_eq!(b.status.generation, 2);
    assert_eq!(b.status.input_event_id, follow.input_event_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_follow_up_join_is_withdrawn_unless_a_run_took_it() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let binding = fixtures::ready(&f).await;
    let request = input(&f, "withdraw-first").await;
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
            "withdraw-boot",
            a.status.expires_at_ms,
            &"d".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &cap)
        .await
        .unwrap();
    bound
        .activate_execution_window(cap.credential(), a.status.window_id, 1, "withdraw-boot")
        .await
        .unwrap();

    let mut follow = input(&f, "withdraw-follow-up").await;
    follow.expected_generation = 1;
    follow.window_id = Some(a.status.window_id);
    f.store
        .admit_execution_window_authenticated(&browser, &f.conversation, &follow)
        .await
        .unwrap();
    // A different body under the same key is never withdrawn.
    let mut changed = follow.clone();
    changed.input_request_key = "changed".into();
    assert!(matches!(
        f.store
            .withdraw_unstarted_window_join_authenticated(&browser, &f.conversation, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(f
        .store
        .withdraw_unstarted_window_join_authenticated(&browser, &f.conversation, &follow)
        .await
        .unwrap());
    assert_eq!(window_inputs(&f, &follow.input_event_id).await, 0);
    // Idempotent; the receipt is gone so a retry admits afresh.
    assert!(f
        .store
        .withdraw_unstarted_window_join_authenticated(&browser, &f.conversation, &follow)
        .await
        .unwrap());
    let again = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &follow)
        .await
        .unwrap();
    assert!(!again.duplicate);

    // Once a Deep run has taken it, the follow-up belongs to this window.
    sqlx::query("UPDATE reasoning_inbox SET state='claimed' WHERE event_id=?")
        .bind(follow.input_event_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(!f
        .store
        .withdraw_unstarted_window_join_authenticated(&browser, &f.conversation, &follow)
        .await
        .unwrap());
    assert_eq!(window_inputs(&f, &follow.input_event_id).await, 1);
    let _ = (binding, bound);
}
