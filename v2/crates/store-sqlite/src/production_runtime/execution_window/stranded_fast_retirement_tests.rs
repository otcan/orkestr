//! Retire only the unconsumed input of an audited, never-dispatched Fast setup.
use super::*;
use orkestr_v2_contracts::{OwnerInputRetirementRequest, OwnerInputRetirementState};

fn retirement() -> OwnerInputRetirementRequest {
    OwnerInputRetirementRequest {
        request_key: "retire-reconciled-fast-source".into(),
        reason: "Expired input after failed setup; preserve evidence without replay".into(),
    }
}

async fn settle(w: &Window, consumed: bool, close: bool) -> (Store, RunId) {
    let admission = admitted_fast(w).await;
    if consumed {
        w.consume(&admission).await;
    } else {
        assert!(matches!(
            w.bound
                .claim_provider_dispatch(&admission, "retirement-reservation")
                .await
                .unwrap(),
            DispatchClaimResult::Reserved(_)
        ));
    }
    let fresh = restart(w, true).await;
    let run = admission.provider.run.run_id;
    sqlx::query("UPDATE production_runs SET lease_deadline_ms=lease_deadline_ms-120000 WHERE id=?")
        .bind(run.to_string())
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
    if close {
        reconcile_window(&fresh, w, w.status.window_id, 1, Actor::Owner)
            .await
            .unwrap();
    }
    (fresh, run)
}

async fn retire(
    store: &Store,
    w: &Window,
) -> Result<orkestr_v2_contracts::OwnerInputRetirementReceipt> {
    store
        .retire_owner_input_for_browser(
            &w.browser_credential,
            &w.f.conversation,
            &w.source.input_message_id,
            &retirement(),
        )
        .await
}

async fn evidence(store: &Store) -> String {
    sqlx::query_scalar("SELECT json_array((SELECT json_group_array(json_array(id,state,dispatch_state,event_id)) FROM production_runs),(SELECT json_group_array(json_array(run_id,window_id,cause,prior_state,evidence_event_id)) FROM production_run_lapses),(SELECT json_group_array(json_array(id,window_id,actor,decision,cause,restored_window_id)) FROM execution_window_open_failures))")
        .fetch_one(&store.pool).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_fast_input_retirement_is_durable_idempotent_and_never_replays() {
    let w = Window::open().await;
    let (fresh, _) = settle(&w, false, true).await;
    let before = evidence(&fresh).await;
    let receipt = retire(&fresh, &w).await.unwrap();
    assert_eq!(receipt.state, OwnerInputRetirementState::Retired);
    assert_eq!(receipt.message_id, w.source.input_message_id);
    assert_eq!(receipt.event_id, w.source.input_event_id);
    assert!(!receipt.duplicate);
    assert_eq!(before, evidence(&fresh).await);
    assert_eq!(
        scalar(
            &fresh,
            "SELECT state FROM reasoning_inbox WHERE event_id=?",
            &w.source.input_event_id.to_string()
        )
        .await,
        "retired"
    );
    // The unrelated unadmitted input remains available, with its history intact.
    assert_eq!(
        scalar(
            &fresh,
            "SELECT state FROM reasoning_inbox WHERE event_id=?",
            &w.old.input_event_id.to_string()
        )
        .await,
        "queued"
    );
    let reopened = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    let duplicate = retire(&reopened, &w).await.unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.retirement_id, receipt.retirement_id);
    let mut changed = retirement();
    changed.reason = "different decision".into();
    assert!(matches!(
        reopened
            .retire_owner_input_for_browser(
                &w.browser_credential,
                &w.f.conversation,
                &w.source.input_message_id,
                &changed
            )
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let mut retry = w.source.clone();
    retry.request_key = "forbidden-retired-source-window".into();
    retry.expected_generation = 1;
    retry.predecessor_window_id = Some(w.status.window_id);
    assert!(reopened
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &retry)
        .await
        .is_err());
    assert_eq!(before, evidence(&reopened).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_fast_retirement_refuses_consumed_unreconciled_and_foreign_inputs() {
    for consumed in [false, true] {
        let w = Window::open().await;
        let (fresh, _) = settle(&w, consumed, false).await;
        let before = fixtures::snapshot(&fresh).await;
        assert!(matches!(
            retire(&fresh, &w).await,
            Err(RuntimeStoreError::Conflict)
        ));
        assert_eq!(before, fixtures::snapshot(&fresh).await);
    }
    let w = Window::open().await;
    let (fresh, _) = settle(&w, false, true).await;
    let before = fixtures::snapshot(&fresh).await;
    assert!(matches!(
        fresh
            .retire_owner_input_for_browser(
                "invalid",
                &w.f.conversation,
                &w.source.input_message_id,
                &retirement()
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        fresh
            .retire_owner_input_for_browser(
                &w.browser_credential,
                &ConversationId(Uuid::new_v4()),
                &w.source.input_message_id,
                &retirement()
            )
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert!(fresh
        .retire_owner_input_for_browser(
            &w.browser_credential,
            &w.f.conversation,
            &MessageId(Uuid::new_v4()),
            &retirement()
        )
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&fresh).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_fast_retirement_refuses_new_active_window_or_queued_intent() {
    for queued in [false, true] {
        let w = Window::open().await;
        let (fresh, _) = settle(&w, false, true).await;
        let mut next = input(
            &w.f,
            if queued {
                "queued-other-input"
            } else {
                "active-other-input"
            },
        )
        .await;
        next.expected_generation = 1;
        next.predecessor_window_id = Some(w.status.window_id);
        if queued {
            fresh
                .enqueue_execution_window_authenticated(
                    &w.browser_credential,
                    &w.f.conversation,
                    &next,
                )
                .await
                .unwrap();
        } else {
            fresh
                .admit_execution_window_authenticated(
                    &w.browser_credential,
                    &w.f.conversation,
                    &next,
                )
                .await
                .unwrap();
        }
        let before = fixtures::snapshot(&fresh).await;
        assert!(matches!(
            retire(&fresh, &w).await,
            Err(RuntimeStoreError::Conflict)
        ));
        assert_eq!(before, fixtures::snapshot(&fresh).await);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_fast_retirement_never_covers_a_deep_turn() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Startup)
        .await
        .unwrap();
    let before = fixtures::snapshot(&fresh).await;
    assert!(matches!(
        retire(&fresh, w).await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(before, fixtures::snapshot(&fresh).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_fast_retirement_refuses_stale_lapse_authority() {
    let w = Window::open().await;
    let (fresh, run) = settle(&w, false, true).await;
    // A different generation is not the exact attempt the immutable lapse
    // settled, even when its state still says cancelled/reserved.
    sqlx::query("UPDATE production_runs SET lease_generation=lease_generation+1 WHERE id=?")
        .bind(run.to_string())
        .execute(&fresh.pool)
        .await
        .unwrap();
    let before = fixtures::snapshot(&fresh).await;
    assert!(matches!(
        retire(&fresh, &w).await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(before, fixtures::snapshot(&fresh).await);
}
