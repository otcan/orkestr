use super::*;

async fn pending_pair() -> (Fixture, WorkerTaskClaim) {
    let mut f = fixture().await;
    create(&f).await;
    let claim = claim(&f).await;
    f.request.request_key = "second-pending-task".into();
    create(&f).await;
    assert_eq!(
        ledger(&f).await,
        vec![("claimed".into(), true), ("queued".into(), false)]
    );
    (f, claim)
}

async fn ledger(f: &Fixture) -> Vec<(String, bool)> {
    sqlx::query_as("SELECT state,claim_hash IS NOT NULL FROM worker_tasks ORDER BY ordinal")
        .fetch_all(&f.core.store.pool)
        .await
        .unwrap()
}

async fn assert_held_before_any_read_or_scheduler(f: &Fixture) {
    // Inspect the actual durable ledger before a status projection or scheduler
    // call can conceal a missing transition with a computed Held presentation.
    assert_eq!(
        ledger(f).await,
        vec![("held".into(), false), ("held".into(), false)]
    );
}

#[tokio::test]
async fn durable_parent_stop_clears_queued_and_claimed_authority_atomically() {
    let (f, claimed) = pending_pair().await;
    f.core
        .handle
        .request_cancel(&f.core.owner, &f.parent.run.run_id, "durable-task-stop")
        .await
        .unwrap();
    assert_held_before_any_read_or_scheduler(&f).await;
    assert!(matches!(
        f.core
            .handle
            .delegate_worker_task(&f.core.token, claimed, &f.binding)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    cleanup(f).await;
}

#[tokio::test]
async fn durable_machine_revocation_clears_queued_and_claimed_authority_atomically() {
    let (f, claimed) = pending_pair().await;
    f.core.store.revoke_session(&f.core.token).await.unwrap();
    assert_held_before_any_read_or_scheduler(&f).await;
    assert!(matches!(
        f.core
            .handle
            .delegate_worker_task(&f.core.token, claimed, &f.binding)
            .await,
        Err(RuntimeStoreError::Fenced | RuntimeStoreError::Unauthorized)
    ));
    cleanup(f).await;
}

#[tokio::test]
async fn durable_parent_proposal_clears_queued_and_claimed_authority_atomically() {
    let (f, _claimed) = pending_pair().await;
    f.core
        .handle
        .append_provider_event(
            &f.core.owner,
            &f.parent,
            &observation(
                &f.parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    assert_held_before_any_read_or_scheduler(&f).await;
    cleanup(f).await;
}

#[tokio::test]
async fn durable_parent_failure_clears_queued_and_claimed_authority_atomically() {
    let (f, _claimed) = pending_pair().await;
    f.core
        .handle
        .append_provider_event(
            &f.core.owner,
            &f.parent,
            &observation(&f.parent, 2, ProviderEvent::Failed),
        )
        .await
        .unwrap();
    assert_held_before_any_read_or_scheduler(&f).await;
    cleanup(f).await;
}

#[tokio::test]
async fn progress_and_unrelated_browser_revocation_preserve_pending_tasks() {
    let (f, _claimed) = pending_pair().await;
    let before = ledger(&f).await;
    f.core
        .handle
        .append_provider_event(
            &f.core.owner,
            &f.parent,
            &observation(
                &f.parent,
                2,
                ProviderEvent::Progress("synthetic progress".into()),
            ),
        )
        .await
        .unwrap();
    f.core.handle.heartbeat_supervisor().await.unwrap();
    f.core
        .handle
        .renew_lease(&f.parent.run, f.parent.run.lease_generation)
        .await
        .unwrap();
    f.core.store.revoke_session(&f.browser).await.unwrap();
    let unrelated_machine = "cd".repeat(32);
    f.core
        .store
        .save_session(&unrelated_machine, &f.core.owner)
        .await
        .unwrap();
    f.core
        .store
        .revoke_session(&unrelated_machine)
        .await
        .unwrap();
    assert_eq!(ledger(&f).await, before);
    cleanup(f).await;
}

#[tokio::test]
async fn task_hold_failure_rolls_back_the_whole_parent_stop() {
    let (f, _claimed) = pending_pair().await;
    sqlx::query("CREATE TRIGGER refuse_task_hold BEFORE UPDATE ON worker_tasks WHEN NEW.state='held' BEGIN SELECT RAISE(ABORT,'synthetic hold failure'); END")
        .execute(&f.core.store.pool).await.unwrap();
    let before = audit(&f).await;
    assert!(f
        .core
        .handle
        .request_cancel(&f.core.owner, &f.parent.run.run_id, "atomic-task-stop")
        .await
        .is_err());
    assert_eq!(audit(&f).await, before);
    sqlx::query("DROP TRIGGER refuse_task_hold")
        .execute(&f.core.store.pool)
        .await
        .unwrap();
    f.core
        .handle
        .request_cancel(&f.core.owner, &f.parent.run.run_id, "atomic-task-stop")
        .await
        .unwrap();
    assert_held_before_any_read_or_scheduler(&f).await;
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_claim_and_parent_stop_leave_no_claim_authority() {
    let (f, _claimed) = pending_pair().await;
    let other = Store::open(&f.core.root.join("core.sqlite3"))
        .await
        .unwrap();
    let handle = f.core.handle.reattach_supervisor(&other).await.unwrap();
    let (claimed, stopped) = tokio::join!(
        handle.claim_worker_task(&f.core.token, &f.parent.run.run_id),
        f.core
            .handle
            .request_cancel(&f.core.owner, &f.parent.run.run_id, "concurrent-task-stop")
    );
    stopped.unwrap();
    assert!(matches!(claimed, Ok(_) | Err(RuntimeStoreError::Fenced)));
    assert_held_before_any_read_or_scheduler(&f).await;
    other.close().await;
    cleanup(f).await;
}

#[tokio::test]
async fn delegated_task_evidence_is_not_rewritten_as_unissued_work() {
    let mut f = fixture().await;
    create(&f).await;
    let run = candidate(&f).await;
    f.request.request_key = "queued-beside-issued-worker".into();
    create(&f).await;
    f.core
        .handle
        .request_cancel(
            &f.core.owner,
            &f.parent.run.run_id,
            "stop-with-issued-worker",
        )
        .await
        .unwrap();
    assert_eq!(
        ledger(&f).await,
        vec![("delegated".into(), false), ("held".into(), false)]
    );
    let linked: String = sqlx::query_scalar("SELECT d.admitted_run_id FROM worker_tasks t JOIN worker_provider_delegations d ON d.id=t.delegation_id WHERE t.state='delegated'")
        .fetch_one(&f.core.store.pool).await.unwrap();
    assert_eq!(linked, run.provider.run.run_id.to_string());
    cleanup(f).await;
}

#[tokio::test]
async fn clock_expiry_reconciliation_is_negative_scoped_and_never_reissues() {
    let (f, _claimed) = pending_pair().await;
    let mut other_config = crate::production_runtime::tests::config(ProductionTakeover::First);
    other_config.supervisor_key = "unrelated-synthetic-supervisor".into();
    let unrelated = f
        .core
        .store
        .authorize_supervisor(&f.core.token, other_config)
        .await
        .unwrap();
    assert_eq!(
        unrelated
            .reconcile_worker_task_holds(&f.parent.run.run_id)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        f.core
            .handle
            .reconcile_worker_task_holds(&f.parent.run.run_id)
            .await
            .unwrap(),
        0
    );
    assert!(f
        .core
        .store
        .reconcile_worker_task_holds(&f.parent.run.run_id)
        .await
        .is_err());
    let before = ledger(&f).await;
    sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()+1 WHERE token_hash=?")
        .bind(crate::digest(&f.core.token))
        .execute(&f.core.store.pool)
        .await
        .unwrap();
    assert_eq!(ledger(&f).await, before);
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert_eq!(
        ledger(&f).await,
        before,
        "elapsed time alone cannot run a SQLite trigger"
    );
    assert_eq!(
        unrelated
            .reconcile_worker_task_holds(&f.parent.run.run_id)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        f.core
            .handle
            .reconcile_worker_task_holds(&f.parent.run.run_id)
            .await
            .unwrap(),
        2
    );
    assert_held_before_any_read_or_scheduler(&f).await;
    assert_eq!(
        f.core
            .handle
            .reconcile_worker_task_holds(&f.parent.run.run_id)
            .await
            .unwrap(),
        0
    );
    f.core
        .store
        .save_session(&f.core.token, &f.core.owner)
        .await
        .unwrap();
    assert!(f
        .core
        .handle
        .claim_worker_task(&f.core.token, &f.parent.run.run_id)
        .await
        .unwrap()
        .is_none());
    assert_held_before_any_read_or_scheduler(&f).await;
    cleanup(f).await;
}
