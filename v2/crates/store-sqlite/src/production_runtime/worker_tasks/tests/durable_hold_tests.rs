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
    f.core.store.revoke_session(&f.browser).await.unwrap();
    assert_eq!(ledger(&f).await, before);
    cleanup(f).await;
}
