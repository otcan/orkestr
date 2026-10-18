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
