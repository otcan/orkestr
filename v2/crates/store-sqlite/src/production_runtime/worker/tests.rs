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
        Err(RuntimeStoreError::Conflict)
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

pub(in crate::production_runtime) async fn running(
    f: &crate::production_runtime::tests::Case,
) -> (ProviderAdmission, WorkerAdmissionInput) {
    let b = ready(f).await;
    let c = claim(f, &b).await;
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
    assert_eq!(cap.message_id(), &c.message_id);
    assert_eq!(cap.source_event_id(), &c.event_id);
    let p = cap.provider().clone();
    drop(cap);
    f.handle
        .append_provider_event(
            &f.owner,
            &p,
            &crate::production_runtime::observation_tests::input(&p, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let worker = f
        .handle
        .create_worker_binding(
            &f.owner,
            &f.conversation,
            Some(&b.session_id),
            "independent-worker",
        )
        .await
        .unwrap();
    let metadata = f
        .handle
        .authorize_worker_metadata(&f.token, &p.run.run_id, &worker)
        .await
        .unwrap();
    let worker = f
        .handle
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: worker.session_id,
                expected_generation: worker.generation,
                native_session_id: "synthetic-native-worker".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "worker-ready".into(),
            },
        )
        .await
        .unwrap();
    let worker = worker.binding().clone();
    assert_ne!(worker.session_id, b.session_id);
    assert_ne!(worker.native_session_id, b.native_session_id);
    (
        p,
        WorkerAdmissionInput {
            worker_binding_id: worker.session_id,
            expected_binding_generation: worker.generation,
            source_message_id: c.message_id,
            source_event_id: c.event_id,
            request_key: "one-worker".into(),
            lifetime_ms: 30_000,
        },
    )
}
pub(super) async fn ledger(store: &Store) -> Vec<String> {
    let mut result = snapshot(store).await;
    let rows:Vec<String>=sqlx::query_scalar("SELECT json_object('id',id,'parent',parent_run_id,'worker',worker_session_id,'digest',input_digest,'deadline',expires_at_ms,'state',state,'grant',grant_hash,'admitted',admitted_run_id) FROM worker_provider_delegations ORDER BY id").fetch_all(&store.pool).await.unwrap();
    result.push(format!("worker-delegations:{rows:?}"));
    result
}
#[tokio::test]
async fn worker_delegation_has_one_issuance_replay_and_parent_terminal_fence() {
    let f = setup().await;
    let (p, input) = running(&f).await;
    let before = super::dispatch_tests::inbox(&f.store).await;
    let (a, b) = tokio::join!(
        f.handle.delegate_worker(&f.token, &p.run.run_id, &input),
        f.handle.delegate_worker(&f.token, &p.run.run_id, &input)
    );
    let results = [a.unwrap(), b.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, WorkerDelegationResult::Fresh(_)))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, WorkerDelegationResult::Existing(_)))
            .count(),
        1
    );
    assert_eq!(super::dispatch_tests::inbox(&f.store).await, before); // No Deep inbox write.
    let current = ledger(&f.store).await;
    let mut changed = WorkerAdmissionInput {
        request_key: input.request_key.clone(),
        ..input
    };
    changed.lifetime_ms -= 1;
    assert!(matches!(
        f.handle
            .delegate_worker(&f.token, &p.run.run_id, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(ledger(&f.store).await, current);
    let mut original = changed;
    original.lifetime_ms += 1;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&reopened).await.unwrap();
    assert!(matches!(
        attached
            .delegate_worker(&f.token, &p.run.run_id, &original)
            .await,
        Ok(WorkerDelegationResult::Existing(_))
    ));
    assert_eq!(ledger(&f.store).await, current);
    f.handle
        .append_provider_event(
            &f.owner,
            &p,
            &crate::production_runtime::observation_tests::input(&p, 2, ProviderEvent::Failed),
        )
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM worker_provider_delegations")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "blocked");
    let grant: Option<String> =
        sqlx::query_scalar("SELECT grant_hash FROM worker_provider_delegations")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert!(grant.is_none());
    let before = ledger(&f.store).await;
    assert!(matches!(
        f.handle
            .delegate_worker(&f.token, &p.run.run_id, &original)
            .await,
        Ok(WorkerDelegationResult::Existing(_))
    ));
    assert_eq!(ledger(&f.store).await, before);
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.handle
            .delegate_worker(&f.token, &p.run.run_id, &original)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(ledger(&f.store).await, before);
}
