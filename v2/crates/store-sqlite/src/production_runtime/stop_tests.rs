use super::tests::{claim, ready, setup, snapshot};
use super::*;
use orkestr_v2_contracts::{ConversationId, ExecutionControlRequest, ExecutionStopOutcome};
#[tokio::test]
async fn stop_revision_cas_and_request_replay_are_atomic_and_owner_scoped() {
    let f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "run")
        .await
        .unwrap();
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    let mut input = ExecutionControlRequest {
        run_id: run.provider.run.run_id.clone(),
        expected_revision: revision - 1,
        request_key: "stop".into(),
    };
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .stop_execution(&f.owner, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    input.expected_revision = revision;
    assert!(matches!(
        f.handle
            .stop_execution(&OwnerId(Uuid::new_v4()), &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.handle
            .stop_execution(&f.owner, &ConversationId(Uuid::new_v4()), &input)
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert!(matches!(
        f.store
            .stop_execution(&f.owner, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&other).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle.stop_execution(&f.owner, &f.conversation, &input),
        attached.stop_execution(&f.owner, &f.conversation, &input)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a, b);
    assert!(a.is_valid());
    let json = serde_json::to_value(&a).unwrap();
    assert_eq!(
        serde_json::from_value::<orkestr_v2_contracts::ExecutionStopReceipt>(json).unwrap(),
        a
    );
    assert!(
        serde_json::from_value::<ExecutionStopOutcome>(serde_json::json!("confirmed")).is_err()
    );
    assert_eq!(a.outcome, ExecutionStopOutcome::NotDispatched);
    assert!(a.revision > revision);
    let after = snapshot(&f.store).await;
    input.expected_revision = a.revision;
    assert!(matches!(
        f.handle
            .stop_execution(&f.owner, &f.conversation, &input)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(snapshot(&f.store).await, after);
    input.expected_revision = revision;
    f.handle.heartbeat_supervisor().await.unwrap();
    let stable = snapshot(&f.store).await;
    assert_eq!(
        f.handle
            .stop_execution(&f.owner, &f.conversation, &input)
            .await
            .unwrap(),
        a
    );
    assert_eq!(snapshot(&f.store).await, stable);
}
