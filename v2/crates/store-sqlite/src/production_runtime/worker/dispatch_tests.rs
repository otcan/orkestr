use super::tests::{ledger, running};
use super::*;
use crate::production_runtime::observation_tests::input as event;
use crate::production_runtime::tests::setup;
async fn fresh(
    f: &crate::production_runtime::tests::Case,
    p: &ProviderAdmission,
    i: &WorkerAdmissionInput,
) -> WorkerDelegation {
    let WorkerDelegationResult::Fresh(d) = f
        .handle
        .delegate_worker(&f.token, &p.run.run_id, i)
        .await
        .unwrap()
    else {
        panic!()
    };
    d
}
async fn consume(
    f: &crate::production_runtime::tests::Case,
    run: &RunAdmissionResult,
) -> Box<ConsumedProviderDispatch> {
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(run, "worker-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    cap
}
pub(super) async fn inbox(store: &Store) -> Vec<String> {
    sqlx::query_scalar("SELECT json_object('sequence',sequence,'state',state,'claim',claim_generation,'consumer',claimant_session_id,'run',admitted_run_id) FROM reasoning_inbox ORDER BY sequence").fetch_all(&store.pool).await.unwrap()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_worker_admits_consumes_and_parent_terminal_fences_without_losing_truth() {
    let f = setup().await;
    let (parent, i) = running(&f).await;
    let original_inbox = inbox(&f.store).await;
    let d = fresh(&f, &parent, &i).await;
    let worker = f.handle.admit_worker(&f.token, d).await.unwrap();
    assert_eq!(worker.provider.run.role, Role::Worker);
    assert_eq!(worker.provider.binding.role, Role::Worker);
    assert_eq!(
        worker.provider.binding.parent_session_id,
        Some(parent.run.session_id.clone())
    );
    assert_ne!(worker.provider.run.session_id, parent.run.session_id);
    assert_ne!(
        worker.provider.run.native_session_id,
        parent.run.native_session_id
    );
    assert_eq!(inbox(&f.store).await, original_inbox);
    let cap = consume(&f, &worker).await;
    assert_eq!(cap.text(), "synthetic execution payload");
    let w = cap.provider().clone();
    drop(cap);
    assert_eq!(
        f.handle
            .with_execution_fence(&w, || Ok::<_, ()>(1))
            .unwrap(),
        Ok(1)
    );
    let accepted = f
        .handle
        .append_provider_event(&f.owner, &w, &event(&w, 1, ProviderEvent::Started))
        .await
        .unwrap();
    f.handle
        .append_provider_event(&f.owner, &parent, &event(&parent, 2, ProviderEvent::Failed))
        .await
        .unwrap();
    let states: Vec<String> = sqlx::query_scalar("SELECT state FROM production_runs ORDER BY role")
        .fetch_all(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(states, vec!["failed", "blocked"]);
    let before = ledger(&f.store).await;
    let mut calls = 0;
    assert!(matches!(
        f.handle.with_execution_fence(&w, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(calls, 0);
    assert!(matches!(
        f.handle
            .append_provider_event(
                &f.owner,
                &w,
                &event(&w, 2, ProviderEvent::CompletedProposal { synthetic: false })
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    let replay = f
        .handle
        .append_provider_event(&f.owner, &w, &event(&w, 1, ProviderEvent::Started))
        .await
        .unwrap();
    assert_eq!(replay.event_id, accepted.event_id);
    assert!(replay.duplicate);
    assert_eq!(ledger(&f.store).await, before);
    assert_eq!(inbox(&f.store).await, original_inbox);
}
#[tokio::test]
async fn worker_grant_is_single_use_and_parent_cancel_erases_child_locator() {
    let f = setup().await;
    let (parent, i) = running(&f).await;
    let mut d = fresh(&f, &parent, &i).await;
    let id = d._id;
    let locator = d._locator.clone();
    d._locator = "cd".repeat(32);
    let before = ledger(&f.store).await;
    assert!(matches!(
        f.handle.admit_worker(&f.token, d).await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(ledger(&f.store).await, before);
    let d = WorkerDelegation {
        _id: id,
        _locator: locator.clone(),
    };
    let run = f.handle.admit_worker(&f.token, d).await.unwrap();
    let before = ledger(&f.store).await;
    assert!(matches!(
        f.handle
            .admit_worker(
                &f.token,
                WorkerDelegation {
                    _id: id,
                    _locator: locator
                }
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(ledger(&f.store).await, before);
    f.handle
        .request_cancel(&f.owner, &parent.run.run_id, "parent-stop")
        .await
        .unwrap();
    let before = ledger(&f.store).await;
    assert!(matches!(
        f.handle.claim_provider_dispatch(&run, "late-child").await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(ledger(&f.store).await, before);
    let locators:i64=sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE role='worker' AND (candidate_hash IS NOT NULL OR reservation_hash IS NOT NULL OR reserve_key IS NOT NULL)").fetch_one(&f.store.pool).await.unwrap();
    assert_eq!(locators, 0);
}
#[tokio::test]
async fn worker_stopped_requires_its_own_control_and_does_not_stop_parent() {
    let f = setup().await;
    let (parent, i) = running(&f).await;
    let d = fresh(&f, &parent, &i).await;
    let worker = f.handle.admit_worker(&f.token, d).await.unwrap();
    let cap = consume(&f, &worker).await;
    let w = cap.provider().clone();
    drop(cap);
    let stop = f
        .handle
        .request_cancel(&f.owner, &w.run.run_id, "child-stop")
        .await
        .unwrap();
    let mut control = w.clone();
    control.run = stop.new_fenced_admission;
    let before = ledger(&f.store).await;
    assert!(f
        .handle
        .append_provider_event(&f.owner, &w, &event(&w, 1, ProviderEvent::Stopped))
        .await
        .is_err());
    assert_eq!(ledger(&f.store).await, before);
    let receipt = f
        .handle
        .append_provider_event(
            &f.owner,
            &control,
            &event(&control, 1, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Cancelled);
    let state: String = sqlx::query_scalar("SELECT state FROM production_runs WHERE id=?")
        .bind(parent.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "running");
}

#[tokio::test]
async fn separate_pools_have_one_admission_and_dispatch_winner_without_reissue() {
    let f = setup().await;
    let (parent, i) = running(&f).await;
    let d = fresh(&f, &parent, &i).await;
    // Adversarial duplicate delivery of the same issued private grant.
    let duplicate = WorkerDelegation {
        _id: d._id,
        _locator: d._locator.clone(),
    };
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let other = f.handle.reattach_supervisor(&reopened).await.unwrap();
    let before_inbox = inbox(&f.store).await;
    let (a, b) = tokio::join!(
        f.handle.admit_worker(&f.token, d),
        other.admit_worker(&f.token, duplicate)
    );
    let admitted = match (a, b) {
        (Ok(run), Err(RuntimeStoreError::Fenced)) | (Err(RuntimeStoreError::Fenced), Ok(run)) => {
            run
        }
        result => panic!("unexpected admission race: {result:?}"),
    };
    let (a, b) = tokio::join!(
        f.handle.claim_provider_dispatch(&admitted, "dispatch"),
        other.claim_provider_dispatch(&admitted, "dispatch")
    );
    let reserved = match (a.unwrap(), b.unwrap()) {
        (DispatchClaimResult::Reserved(r), DispatchClaimResult::Replay)
        | (DispatchClaimResult::Replay, DispatchClaimResult::Reserved(r)) => r,
        result => panic!("unexpected reservation race: {result:?}"),
    };
    let (a, b) = tokio::join!(
        f.handle.consume_execution(&reserved),
        other.consume_execution(&reserved)
    );
    let cap = match (a.unwrap(), b.unwrap()) {
        (ExecutionConsumption::Dispatch(c), ExecutionConsumption::ReconciliationRequired)
        | (ExecutionConsumption::ReconciliationRequired, ExecutionConsumption::Dispatch(c)) => c,
        _ => panic!("consume did not have exactly one winner"),
    };
    drop(cap);
    let before = ledger(&f.store).await;
    let WorkerDelegationResult::Existing(receipt) = other
        .delegate_worker(&f.token, &parent.run.run_id, &i)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(receipt.admitted_run_id, Some(admitted.provider.run.run_id));
    assert_eq!(receipt.state, WorkerDelegationState::Admitted);
    assert_eq!(ledger(&f.store).await, before);
    assert_eq!(inbox(&f.store).await, before_inbox);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_worker_tool_parent_survives_cap_move_but_not_stop_or_revocation() {
    for revoke in [false, true] {
        let f = setup().await;
        let (parent, i) = running(&f).await;
        let d = fresh(&f, &parent, &i).await;
        let worker = f.handle.admit_worker(&f.token, d).await.unwrap();
        let cap = consume(&f, &worker).await;
        let retained = f
            .handle
            .authorize_offline_python_parent(&f.token, &cap)
            .await
            .unwrap();
        drop(cap); // Models by-value inference attachment, not cap reconstruction.
        let grant = f
            .handle
            .delegate_offline_python_from_parent(
                &f.token,
                &retained,
                "native-call-1",
                "print('synthetic')",
                5000,
            )
            .await
            .unwrap();
        assert!(matches!(grant, OfflinePythonAdmission::Fresh(_)));
        assert!(matches!(
            f.handle
                .delegate_offline_python_from_parent(
                    &f.token,
                    &retained,
                    "native-call-1",
                    "print('synthetic')",
                    5000,
                )
                .await,
            Ok(OfflinePythonAdmission::Existing(_))
        ));
        if revoke {
            f.store.revoke_session(&f.token).await.unwrap();
        } else {
            f.handle
                .request_cancel(&f.owner, &parent.run.run_id, "stop-tool-parent")
                .await
                .unwrap();
        }
        let before = ledger(&f.store).await;
        assert!(f
            .handle
            .delegate_offline_python_from_parent(
                &f.token,
                &retained,
                "native-call-2",
                "print('synthetic')",
                5000,
            )
            .await
            .is_err());
        assert_eq!(ledger(&f.store).await, before);
        f.store.close().await;
        std::fs::remove_dir_all(f.root).unwrap();
    }
}
