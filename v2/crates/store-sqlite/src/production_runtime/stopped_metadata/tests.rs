use super::*;
use crate::production_runtime::tests::{claim, ready, setup};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_setup_requires_canonical_stop_and_reserves_once() {
    let f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "stopped-resume")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&run, "reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(_) = f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let cancel = f
        .handle
        .request_cancel(&f.owner, &run.provider.run.run_id, "stop")
        .await
        .unwrap();
    assert!(matches!(
        f.handle
            .authorize_stopped_session_metadata(&f.token, &run.provider.run.run_id, &b)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    let mut control = run.provider.clone();
    control.run = cancel.new_fenced_admission;
    f.handle
        .append_provider_event(
            &f.owner,
            &control,
            &ProviderEventInput {
                run_id: control.run.run_id.clone(),
                session_id: control.run.session_id.clone(),
                sequence: 1,
                lease_generation: control.run.lease_generation,
                dispatch_fence: control.run.dispatch_fence,
                event: ProviderEvent::Stopped,
            },
        )
        .await
        .unwrap();
    let ready = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let grant = f
        .handle
        .authorize_stopped_session_metadata(&f.token, &run.provider.run.run_id, &ready)
        .await
        .unwrap();
    assert_eq!(grant.binding(), &ready);
    assert_eq!(
        f.handle
            .with_metadata_fence(&grant, || Ok::<_, ()>(1))
            .unwrap(),
        Ok(1)
    );
    assert!(matches!(
        f.handle
            .authorize_stopped_session_metadata(&f.token, &run.provider.run.run_id, &ready)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let transition = f
        .handle
        .confirm_metadata_session(
            grant,
            NativeSessionConfirmation {
                session_id: ready.session_id.clone(),
                expected_generation: ready.generation,
                native_session_id: ready.native_session_id.clone().unwrap(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "stopped-resume-ready".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(transition.binding(), &ready);
    use orkestr_v2_application::IntakeStore;
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &orkestr_v2_contracts::MessageInput {
                client_message_id: "explicit-after-stop".into(),
                text: "new owner turn".into(),
            },
        )
        .await
        .unwrap();
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &ready.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let next = f
        .handle
        .admit_run(
            &claim,
            &ready.session_id,
            ready.generation,
            "new-after-stop",
        )
        .await
        .unwrap();
    assert_ne!(next.provider.run.run_id, run.provider.run.run_id);
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&next, "next-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    transition.attach_execution(*cap).unwrap();
}

#[tokio::test]
async fn not_dispatched_cancellation_never_qualifies_for_resume() {
    let f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "queued-cancel")
        .await
        .unwrap();
    f.handle
        .request_cancel(&f.owner, &run.provider.run.run_id, "stop")
        .await
        .unwrap();
    let ready = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    assert!(matches!(
        f.handle
            .authorize_stopped_session_metadata(&f.token, &run.provider.run.run_id, &ready)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_setup_rechecks_revocation_and_obsolete_context_before_callbacks() {
    for revoke in [true, false] {
        let f = setup().await;
        let b = ready(&f).await;
        let claim = claim(&f, &b).await;
        let run = f
            .handle
            .admit_run(&claim, &b.session_id, b.generation, "auth-stop")
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = f
            .handle
            .claim_provider_dispatch(&run, "auth-reserve")
            .await
            .unwrap()
        else {
            panic!()
        };
        let ExecutionConsumption::Dispatch(_) =
            f.handle.consume_execution(&reservation).await.unwrap()
        else {
            panic!()
        };
        let cancel = f
            .handle
            .request_cancel(&f.owner, &run.provider.run.run_id, "auth-cancel")
            .await
            .unwrap();
        let mut control = run.provider.clone();
        control.run = cancel.new_fenced_admission;
        f.handle
            .append_provider_event(
                &f.owner,
                &control,
                &ProviderEventInput {
                    run_id: control.run.run_id.clone(),
                    session_id: control.run.session_id.clone(),
                    sequence: 1,
                    lease_generation: control.run.lease_generation,
                    dispatch_fence: control.run.dispatch_fence,
                    event: ProviderEvent::Stopped,
                },
            )
            .await
            .unwrap();
        let binding = f
            .handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap()
            .deep;
        let grant = f
            .handle
            .authorize_stopped_session_metadata(&f.token, &control.run.run_id, &binding)
            .await
            .unwrap();
        if revoke {
            f.store.revoke_session(&f.token).await.unwrap();
        } else {
            // Negative persisted-generation fixture, not a simulated cleanup or takeover proof.
            sqlx::query("UPDATE production_supervisors SET generation=generation+1")
                .execute(&f.store.pool)
                .await
                .unwrap();
        }
        let before = crate::production_runtime::tests::snapshot(&f.store).await;
        assert!(f
            .handle
            .authorize_stopped_session_metadata(&f.token, &control.run.run_id, &binding)
            .await
            .is_err());
        let mut calls = 0;
        assert!(f
            .handle
            .with_metadata_fence(&grant, || {
                calls += 1;
                Ok::<_, ()>(())
            })
            .is_err());
        assert_eq!(calls, 0);
        assert!(f
            .handle
            .confirm_metadata_session(
                grant,
                NativeSessionConfirmation {
                    session_id: binding.session_id,
                    expected_generation: binding.generation,
                    native_session_id: binding.native_session_id.unwrap(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "auth-stopped-confirm".into(),
                }
            )
            .await
            .is_err());
        assert_eq!(
            crate::production_runtime::tests::snapshot(&f.store).await,
            before
        );
        let state: String = sqlx::query_scalar("SELECT state FROM production_resume_metadata")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
        assert_eq!(state, "issued");
    }
}
