use super::*;
use crate::production_runtime::{tests::setup, worker::tests::running};
#[tokio::test]
async fn discovery_is_authenticated_scoped_read_only_and_preserves_parent_truth() {
    let f = setup().await;
    let (parent, input) = running(&f).await;
    let WorkerDelegationResult::Fresh(grant) = f
        .handle
        .delegate_worker(&f.token, &parent.run.run_id, &input)
        .await
        .unwrap()
    else {
        panic!()
    };
    let admitted = f.handle.admit_worker(&f.token, grant).await.unwrap();
    let token = format!("browser:{}", "ab".repeat(32));
    f.store.save_session(&token, &f.owner).await.unwrap();
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    let page = f
        .handle
        .worker_executions_authenticated(&token, &f.conversation, None, 1)
        .await
        .unwrap();
    assert!(page.is_valid());
    assert_eq!(page.workers.len(), 1);
    let worker = &page.workers[0];
    assert_eq!(worker.run_id, admitted.provider.run.run_id);
    assert_eq!(worker.parent_run_id, parent.run.run_id);
    assert_eq!(worker.parent_session_id, parent.binding.session_id);
    assert_eq!(worker.source_message_id, input.source_message_id);
    assert_eq!(worker.source_event_id, input.source_event_id);
    assert_eq!(worker.state, RunState::Starting);
    assert_eq!(
        worker.recovery,
        WorkerRecoveryDisposition::CurrentIncarnation
    );
    assert_eq!(page.next_after, None);
    assert!(f
        .handle
        .worker_executions_authenticated(&token, &f.conversation, Some(&worker.run_id), 1)
        .await
        .unwrap()
        .workers
        .is_empty());
    assert_eq!(
        crate::production_runtime::tests::snapshot(&f.store).await,
        before
    );
    f.handle
        .request_cancel(&f.owner, &parent.run.run_id, "parent-stop")
        .await
        .unwrap();
    let blocked = f
        .handle
        .worker_executions_authenticated(&token, &f.conversation, None, 100)
        .await
        .unwrap();
    assert_eq!(blocked.workers[0].state, RunState::Blocked);
    assert_eq!(
        blocked.workers[0].recovery,
        WorkerRecoveryDisposition::ReconciliationRequired
    );
    assert!(matches!(
        f.handle
            .worker_executions_authenticated(&token, &ConversationId(Uuid::new_v4()), None, 100)
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert!(matches!(
        f.handle
            .worker_executions_authenticated(&token, &f.conversation, None, 101)
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    let foreign_token = format!("browser:{}", "cd".repeat(32));
    assert!(matches!(
        f.handle
            .worker_executions_authenticated(&foreign_token, &f.conversation, None, 100)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    f.store.revoke_session(&token).await.unwrap();
    assert!(matches!(
        f.handle
            .worker_executions_authenticated(&token, &f.conversation, None, 100)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(f
        .store
        .worker_executions_authenticated(&f.token, &f.conversation, None, 100)
        .await
        .is_err());
}
