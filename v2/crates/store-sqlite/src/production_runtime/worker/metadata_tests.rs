use super::tests::{ledger, running};
use super::*;
use crate::production_runtime::observation_tests::input as event;
use crate::production_runtime::tests::setup;

fn evidence(b: &Binding) -> NativeSessionConfirmation {
    NativeSessionConfirmation {
        session_id: b.session_id.clone(),
        expected_generation: b.generation,
        native_session_id: "synthetic-parent-bound-worker".into(),
        protocol_version: "codex-rpc-1".into(),
        source_event_key: "parent-bound-ready".into(),
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_rechecks_parent_before_callback_and_atomic_confirmation() {
    let f = setup().await;
    let (parent, _) = running(&f).await;
    let b = f
        .handle
        .create_worker_binding(
            &f.owner,
            &f.conversation,
            Some(&parent.binding.session_id),
            "setup-worker",
        )
        .await
        .unwrap();
    let before = ledger(&f.store).await;
    assert!(matches!(
        f.handle.authorize_session_metadata(&b).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(matches!(
        f.handle.confirm_native_session(evidence(&b)).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(matches!(
        f.handle
            .authorize_worker_metadata(&"aa".repeat(32), &parent.run.run_id, &b)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(ledger(&f.store).await, before);
    assert!(matches!(
        f.handle
            .authorize_worker_metadata(&f.token, &RunId(Uuid::new_v4()), &b)
            .await,
        Err(RuntimeStoreError::NotFound)
    ));
    let mut forged = b.clone();
    forged.parent_session_id = None;
    assert!(matches!(
        f.handle
            .authorize_worker_metadata(&f.token, &parent.run.run_id, &forged)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(ledger(&f.store).await, before);
    let grant = f
        .handle
        .authorize_worker_metadata(&f.token, &parent.run.run_id, &b)
        .await
        .unwrap();
    assert_eq!(
        f.handle
            .with_metadata_fence(&grant, || Ok::<_, ()>(1))
            .unwrap(),
        Ok(1)
    );
    f.handle
        .append_provider_event(&f.owner, &parent, &event(&parent, 2, ProviderEvent::Failed))
        .await
        .unwrap();
    let before = ledger(&f.store).await;
    let mut called = false;
    assert!(matches!(
        f.handle.with_metadata_fence(&grant, || {
            called = true;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(!called);
    assert!(matches!(
        f.handle.confirm_metadata_session(grant, evidence(&b)).await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(ledger(&f.store).await, before);
}
#[tokio::test]
async fn exact_worker_status_never_replaces_deep_and_revocation_refuses_read() {
    let f = setup().await;
    let (parent, i) = running(&f).await;
    let WorkerDelegationResult::Fresh(d) = f
        .handle
        .delegate_worker(&f.token, &parent.run.run_id, &i)
        .await
        .unwrap()
    else {
        panic!()
    };
    let child = f.handle.admit_worker(&f.token, d).await.unwrap();
    let deep = f
        .handle
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deep.run_id.as_ref(), Some(&parent.run.run_id));
    let worker = f
        .handle
        .execution_run_status(
            &f.token,
            &f.owner,
            &f.conversation,
            &child.provider.run.run_id,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(worker.run_id.as_ref(), Some(&child.provider.run.run_id));
    assert_eq!(worker.phase, orkestr_v2_contracts::ExecutionPhase::Starting);
    assert!(worker.queue_age_ms.is_none());
    assert!(worker.is_valid());
    assert!(f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &RunId(Uuid::new_v4()))
        .await
        .unwrap()
        .is_none());
    assert!(matches!(
        f.handle
            .execution_run_status(
                &"aa".repeat(32),
                &f.owner,
                &f.conversation,
                &parent.run.run_id
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.handle
            .execution_run_status(&f.token, &f.owner, &f.conversation, &parent.run.run_id)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}

#[tokio::test]
async fn attachment_checks_consumed_durable_parent_even_with_identical_ready_binding() {
    for substitute_parent in [false, true] {
        let f = setup().await;
        let (parent, input) = running(&f).await;
        let WorkerDelegationResult::Fresh(delegation) = f
            .handle
            .delegate_worker(&f.token, &parent.run.run_id, &input)
            .await
            .unwrap()
        else {
            panic!()
        };
        let admission = f.handle.admit_worker(&f.token, delegation).await.unwrap();
        let DispatchClaimResult::Reserved(reservation) = f
            .handle
            .claim_provider_dispatch(&admission, "attachment")
            .await
            .unwrap()
        else {
            panic!()
        };
        let ExecutionConsumption::Dispatch(capability) =
            f.handle.consume_execution(&reservation).await.unwrap()
        else {
            panic!()
        };
        assert_eq!(capability.parent_run.as_ref(), Some(&parent.run.run_id));
        // Isolate the attachment boundary: both transitions carry the exact same
        // confirmed Ready binding/context; only the retained setup parent differs.
        let ready = capability.provider().binding.clone();
        let transition = crate::production_runtime::metadata::ReadySessionTransition {
            metadata: crate::production_runtime::metadata::BoundSessionMetadata {
                context: f.handle.context().unwrap().clone(),
                binding: ready.clone(),
                parent_run: Some(if substitute_parent {
                    RunId(Uuid::new_v4())
                } else {
                    parent.run.run_id.clone()
                }),
                resume: None,
            },
            ready,
        };
        let before = ledger(&f.store).await;
        let result = transition.attach_execution(*capability);
        if substitute_parent {
            assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
        } else {
            assert!(result.is_ok());
        }
        assert_eq!(ledger(&f.store).await, before);
    }
}
