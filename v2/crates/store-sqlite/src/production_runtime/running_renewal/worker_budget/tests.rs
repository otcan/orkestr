use super::*;
use crate::production_runtime::{
    tests::{setup, Case},
    worker::tests::running,
};
use orkestr_v2_contracts::WorkerTaskCreateRequest;

async fn worker() -> (Case, Box<ConsumedProviderDispatch>) {
    worker_with_budget(Some(120_000)).await
}
async fn worker_with_budget(owner_budget: Option<u32>) -> (Case, Box<ConsumedProviderDispatch>) {
    let f = setup().await;
    let (parent, input) = running(&f).await;
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM production_control_revisions WHERE run_id=?")
            .bind(parent.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    f.handle
        .create_worker_task_authenticated(
            &f.token,
            &f.conversation,
            &WorkerTaskCreateRequest {
                parent_run_id: parent.run.run_id.clone(),
                expected_control_revision: revision,
                request_key: "budget-task".into(),
                title: "Synthetic task".into(),
                instructions: "Summarize synthetic bounded input".into(),
                lifetime_ms: 5000,
                execution_budget_ms: owner_budget,
            },
        )
        .await
        .unwrap();
    let task = f
        .handle
        .claim_worker_task(&f.token, &parent.run.run_id)
        .await
        .unwrap()
        .unwrap();
    let row = sqlx::query("SELECT * FROM session_bindings WHERE id=?")
        .bind(input.worker_binding_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let binding = crate::runtime::binding(&row).unwrap();
    let grant = f
        .handle
        .delegate_worker_task(&f.token, task, &binding)
        .await
        .unwrap();
    let run = f.handle.admit_worker(&f.token, grant).await.unwrap();
    let DispatchClaimResult::Reserved(res) = f
        .handle
        .claim_provider_dispatch(&run, "budget-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&res).await.unwrap()
    else {
        panic!()
    };
    (f, cap)
}
async fn started(f: &Case, p: &ProviderAdmission) {
    f.handle
        .append_provider_event(
            &f.owner,
            p,
            &crate::production_runtime::observation_tests::input(p, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
}
#[tokio::test]
async fn explicit_budget_extends_only_owner_task_and_keeps_tools_stale() {
    let (f, cap) = worker().await;
    let oldtool = f
        .handle
        .authorize_offline_python_parent(&f.token, &cap)
        .await
        .unwrap();
    let mut generic = f.handle.authorize_running_renewal(&cap).await.unwrap();
    let mut budget = f
        .handle
        .authorize_worker_running_renewal(&cap, 120_000)
        .await
        .unwrap();
    let anchor: i64 = sqlx::query_scalar("SELECT created_at_ms FROM worker_tasks")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let deadline: i64 = sqlx::query_scalar("SELECT deadline_ms FROM worker_running_budgets")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(deadline, anchor + 120_000);
    assert!(matches!(
        f.handle
            .authorize_worker_running_renewal(&cap, 180_000)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    started(&f, cap.provider()).await;
    assert!(matches!(
        f.handle.renew_running(&mut generic).await,
        Err(RuntimeStoreError::Busy)
    ));
    let transition = f.handle.renew_running(&mut budget).await.unwrap();
    assert!(
        transition.current().run.lease_deadline_ms > transition.previous().run.lease_deadline_ms
    );
    assert_eq!(
        transition.current().run.dispatch_fence,
        transition.previous().run.dispatch_fence
    );
    assert_eq!(
        transition.current().run.run_id,
        transition.previous().run.run_id
    );
    assert!(transition.current().run.lease_deadline_ms <= deadline);
    let tool = f
        .handle
        .authorize_offline_python_renewed_parent(&f.token, &budget)
        .await
        .unwrap();
    assert!(f
        .handle
        .delegate_offline_python_from_parent(&f.token, &oldtool, "old-tool", "print(1)", 1000)
        .await
        .is_err());
    f.handle
        .delegate_offline_python_from_parent(&f.token, &tool, "new-tool", "print(1)", 1000)
        .await
        .unwrap();
    assert!(f
        .handle
        .authorize_offline_python_renewed_parent(&"cd".repeat(32), &budget)
        .await
        .is_err());
    // A refreshed generic issuer cannot extend the now-current delegation bound.
    assert!(matches!(
        f.handle.renew_running(&mut generic).await,
        Err(RuntimeStoreError::StaleLease)
    ));
    let original: i64 =
        sqlx::query_scalar("SELECT original_delegation_deadline_ms FROM worker_running_budgets")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(original, transition.previous().run.lease_deadline_ms);
    let requests: i64 =
        sqlx::query_scalar("SELECT requested_lifetime_ms FROM worker_provider_delegations")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(requests, 5000);
}
#[tokio::test]
async fn budget_cas_one_winner_revoke_and_stop_refuse() {
    let (f, cap) = worker().await;
    let mut a = f
        .handle
        .authorize_worker_running_renewal(&cap, 120_000)
        .await
        .unwrap();
    let mut b = f
        .handle
        .authorize_worker_running_renewal(&cap, 120_000)
        .await
        .unwrap();
    started(&f, cap.provider()).await;
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach_supervisor(&other).await.unwrap();
    let (x, y) = tokio::join!(f.handle.renew_running(&mut a), handle.renew_running(&mut b));
    assert_eq!(usize::from(x.is_ok()) + usize::from(y.is_ok()), 1);
    let current = if x.is_ok() { &mut a } else { &mut b };
    let run = current.provider.run.run_id.clone();
    f.handle
        .request_cancel(&f.owner, &run, "budget-stop")
        .await
        .unwrap();
    assert!(f.handle.renew_running(current).await.is_err());
    assert!(f
        .handle
        .authorize_offline_python_renewed_parent(&f.token, current)
        .await
        .is_err());
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.handle.renew_running(current).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}
#[tokio::test]
async fn budget_bounds_expiry_and_non_task_refuse_without_rows() {
    let (f, cap) = worker().await;
    assert!(matches!(
        f.handle.authorize_worker_running_renewal(&cap, 0).await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    assert!(matches!(
        f.handle
            .authorize_worker_running_renewal(&cap, 3_600_001)
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    let mut authority = f.handle.authorize_worker_running_renewal(&cap, 1).await;
    if let Ok(ref mut authority) = authority {
        started(&f, cap.provider()).await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        assert!(matches!(
            f.handle.renew_running(authority).await,
            Err(RuntimeStoreError::Expired)
        ));
    } else {
        assert!(matches!(authority, Err(RuntimeStoreError::Expired)));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_running_budgets")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert!(count <= 1);
}

#[tokio::test]
async fn legacy_non_task_worker_and_parent_terminal_cannot_get_or_spend_budget() {
    let f = setup().await;
    let (parent, input) = running(&f).await;
    let grant = f
        .handle
        .delegate_worker(&f.token, &parent.run.run_id, &input)
        .await
        .unwrap();
    let crate::production_runtime::WorkerDelegationResult::Fresh(grant) = grant else {
        panic!()
    };
    let run = f.handle.admit_worker(&f.token, grant).await.unwrap();
    let DispatchClaimResult::Reserved(res) = f
        .handle
        .claim_provider_dispatch(&run, "legacy-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&res).await.unwrap()
    else {
        panic!()
    };
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .authorize_worker_running_renewal(&cap, 120_000)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(
        before,
        crate::production_runtime::tests::snapshot(&f.store).await
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_running_budgets")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);

    let (f, cap) = worker().await;
    let mut authority = f
        .handle
        .authorize_worker_running_renewal(&cap, 120_000)
        .await
        .unwrap();
    started(&f, cap.provider()).await;
    assert!(f
        .handle
        .authorize_offline_python_renewed_parent(&f.token, &authority)
        .await
        .is_err());
    let parentrow=sqlx::query("SELECT p.* FROM production_runs p JOIN worker_provider_delegations d ON d.parent_run_id=p.id WHERE d.admitted_run_id=?")
        .bind(cap.provider().run.run_id.to_string()).fetch_one(&f.store.pool).await.unwrap();
    let parent = crate::production_runtime::admission::envelope(&parentrow).unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            &parent,
            &crate::production_runtime::observation_tests::input(&parent, 2, ProviderEvent::Failed),
        )
        .await
        .unwrap();
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    assert!(f.handle.renew_running(&mut authority).await.is_err());
    assert_eq!(
        before,
        crate::production_runtime::tests::snapshot(&f.store).await
    );
}

#[tokio::test]
async fn owner_opt_in_required_and_host_cap_clamped() {
    let (f, cap) = worker_with_budget(None).await;
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .authorize_worker_running_renewal(&cap, 120_000)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(
        before,
        crate::production_runtime::tests::snapshot(&f.store).await
    );
    let (f, cap) = worker_with_budget(Some(60_000)).await;
    f.handle
        .authorize_worker_running_renewal(&cap, 120_000)
        .await
        .unwrap();
    let (anchor, deadline): (i64, i64) =
        sqlx::query_as("SELECT anchor_ms,deadline_ms FROM worker_running_budgets")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(deadline - anchor, 60_000);
    let (f, cap) = worker_with_budget(Some(120_000)).await;
    f.handle
        .authorize_worker_running_renewal(&cap, 60_000)
        .await
        .unwrap();
    let (anchor, deadline): (i64, i64) =
        sqlx::query_as("SELECT anchor_ms,deadline_ms FROM worker_running_budgets")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(deadline - anchor, 60_000);
}
