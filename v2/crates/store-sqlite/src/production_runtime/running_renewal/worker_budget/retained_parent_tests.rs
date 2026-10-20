//! A budgeted Worker whose Deep parent already proposed. The parent no longer
//! renews itself, so the Worker's lease reaches the parent's last lease. Live:
//! the next renewal was refused, the transport was spent and the Worker's
//! final answer was lost although every tool call had succeeded.
use super::*;
use crate::production_runtime::observation_tests::input as event;
use orkestr_v2_contracts::{EventId, ExecutionAcceptanceRequest};

async fn parent_of(f: &Case, worker: &ProviderAdmission) -> ProviderAdmission {
    let row = sqlx::query("SELECT p.* FROM production_runs p JOIN worker_provider_delegations d ON d.parent_run_id=p.id WHERE d.admitted_run_id=?")
        .bind(worker.run.run_id.to_string()).fetch_one(&f.store.pool).await.unwrap();
    crate::production_runtime::admission::envelope(&row).unwrap()
}

/// Model the live timing: the parent's last lease is exactly where the
/// Worker's current lease ends (the Worker renewed up to it already).
async fn parent_lease_reached(f: &Case, parent: &ProviderAdmission) -> i64 {
    let worker: i64 = sqlx::query_scalar(
        "SELECT expires_at_ms FROM worker_provider_delegations WHERE parent_run_id=?",
    )
    .bind(parent.run.run_id.to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    for sql in [
        "UPDATE worker_provider_delegations SET parent_deadline_ms=? WHERE parent_run_id=?",
        "UPDATE production_run_leases SET lease_deadline_ms=? WHERE run_id=?",
        "UPDATE production_runs SET lease_deadline_ms=? WHERE id=?",
    ] {
        sqlx::query(sql)
            .bind(worker)
            .bind(parent.run.run_id.to_string())
            .execute(&f.store.pool)
            .await
            .unwrap();
    }
    worker
}

async fn accept(f: &Case, run: &ProviderAdmission, completion: EventId) {
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    f.store
        .accept_execution_authenticated(
            &f.token,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: run.run.run_id.clone(),
                completion_event_id: completion,
                expected_revision: revision,
                request_key: format!("accept:{}", run.run.run_id),
            },
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_renews_past_its_proposed_parent_and_delivers_its_answer() {
    let (f, cap) = worker().await;
    let mut authority = f
        .handle
        .authorize_worker_running_renewal(&cap, 120_000)
        .await
        .unwrap();
    started(&f, cap.provider()).await;
    let parent = parent_of(&f, cap.provider()).await;
    let parent_done = f
        .handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id;
    let reached = parent_lease_reached(&f, &parent).await;
    assert_eq!(cap.provider().run.lease_deadline_ms, reached);
    assert!(f.handle.worker_renewal_extends(&authority).await.unwrap());
    let transition = f.handle.renew_running(&mut authority).await.unwrap();
    let renewed = transition.current().clone();
    assert!(renewed.run.lease_deadline_ms > reached);
    // The retained parent's live lease is carried forward in place: same
    // generation and fence, so its proposal still names its current lease.
    let (state, generation, fence, deadline): (String, i64, i64, i64) = sqlx::query_as(
        "SELECT state,lease_generation,dispatch_fence,lease_deadline_ms FROM production_runs WHERE id=?",
    )
    .bind(parent.run.run_id.to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(state, "awaiting_acceptance");
    assert_eq!(generation as u64, parent.run.lease_generation);
    assert_eq!(fence as u64, parent.run.dispatch_fence);
    assert_eq!(deadline, renewed.run.lease_deadline_ms);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT state FROM worker_provider_delegations WHERE parent_run_id=?"
        )
        .bind(parent.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap(),
        "admitted"
    );
    // The Worker finishes normally and its final answer is delivered.
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            &renewed,
            &event(
                &renewed,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id;
    let state: String = sqlx::query_scalar("SELECT state FROM production_runs WHERE id=?")
        .bind(renewed.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "awaiting_acceptance");
    accept(&f, &renewed, done).await;
    accept(&f, &parent, parent_done).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lease_that_cannot_advance_is_reported_before_any_renewal_attempt() {
    let (f, cap) = worker().await;
    let mut authority = f
        .handle
        .authorize_worker_running_renewal(&cap, 120_000)
        .await
        .unwrap();
    started(&f, cap.provider()).await;
    // A Running parent still bounds its Worker: at its own lease, no advance.
    let parent = parent_of(&f, cap.provider()).await;
    parent_lease_reached(&f, &parent).await;
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    assert!(!f.handle.worker_renewal_extends(&authority).await.unwrap());
    assert_eq!(
        before,
        crate::production_runtime::tests::snapshot(&f.store).await
    );
    // This refusal is what spent the live transport; the probe avoids it.
    assert!(matches!(
        f.handle.renew_running(&mut authority).await,
        Err(RuntimeStoreError::Busy)
    ));
    // An expired retained parent is never revived by a Worker renewal.
    let generic = f.handle.authorize_running_renewal(&cap).await.unwrap();
    assert!(!f.handle.worker_renewal_extends(&generic).await.unwrap());
}
