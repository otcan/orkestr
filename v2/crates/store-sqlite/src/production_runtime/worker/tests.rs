use super::*;
use crate::production_runtime::tests::{claim, ready, setup, snapshot};
fn input() -> WorkerAdmissionInput {
    WorkerAdmissionInput {
        worker_binding_id: SessionId(Uuid::new_v4()),
        expected_binding_generation: 1,
        source_message_id: MessageId(Uuid::new_v4()),
        source_event_id: EventId(Uuid::new_v4()),
        request_key: "worker-task".into(),
        lifetime_ms: 30_000,
    }
}
#[tokio::test]
async fn worker_parent_lookup_is_current_and_never_fabricates_grant() {
    let f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "parent")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reserved) = f
        .handle
        .claim_provider_dispatch(&run, "dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&reserved).await.unwrap()
    else {
        panic!()
    };
    let parent_run_id = cap.provider().run.run_id.clone();
    let provider = cap.provider().clone();
    drop(cap); // Models by-value native attachment; no capability reconstruction.
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .delegate_worker(&f.token, &parent_run_id, &input())
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    f.handle
        .append_provider_event(
            &f.owner,
            &provider,
            &crate::production_runtime::observation_tests::input(
                &provider,
                1,
                ProviderEvent::Started,
            ),
        )
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .delegate_worker(&f.token, &parent_run_id, &input())
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert!(matches!(
        f.handle
            .delegate_worker(&"cd".repeat(32), &parent_run_id, &input())
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.store
            .delegate_worker(&f.token, &parent_run_id, &input())
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert!(matches!(
        f.handle
            .delegate_worker(&f.token, &RunId(Uuid::new_v4()), &input())
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .delegate_worker(&f.token, &parent_run_id, &input())
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&f.store).await, before);
}
