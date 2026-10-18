use super::tests::{claim, ready, setup};
use super::*;
use orkestr_v2_contracts::ExecutionControlRequest;

#[tokio::test]
async fn streaming_progress_preserves_exact_run_control_cas_and_original_replay() {
    let f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "stream-stop")
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
    let p = &run.provider;
    let event = |sequence, event| ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    };
    let before_started = f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &p.run.run_id)
        .await
        .unwrap()
        .unwrap();
    f.handle
        .append_provider_event(&f.owner, p, &event(1, ProviderEvent::Started))
        .await
        .unwrap();
    let status = f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &p.run.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(status.control_revision, before_started.control_revision);
    for sequence in 2..=66 {
        f.handle
            .append_provider_event(
                &f.owner,
                p,
                &event(
                    sequence,
                    ProviderEvent::Progress(format!("chunk {sequence}")),
                ),
            )
            .await
            .unwrap();
    }
    use orkestr_v2_application::IntakeStore;
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &orkestr_v2_contracts::MessageInput {
                client_message_id: "followup-during-stream".into(),
                text: "queued followup".into(),
            },
        )
        .await
        .unwrap();
    let after = f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &p.run.run_id)
        .await
        .unwrap()
        .unwrap();
    assert!(after.revision > status.revision);
    assert_eq!(after.control_revision, status.control_revision);
    let mut request = ExecutionControlRequest {
        run_id: p.run.run_id.clone(),
        expected_revision: status.revision,
        expected_control_revision: before_started.control_revision,
        request_key: "stream-stop".into(),
    };
    assert!(matches!(
        f.handle
            .stop_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    request.expected_control_revision = status.control_revision;
    let before_future = super::tests::snapshot(&f.store).await;
    for future in [after.revision + 1, i64::MAX] {
        request.expected_revision = future;
        assert!(matches!(
            f.handle
                .stop_execution_authenticated(&f.token, &f.conversation, &request)
                .await,
            Err(RuntimeStoreError::Conflict)
        ));
        assert_eq!(before_future, super::tests::snapshot(&f.store).await);
    }
    request.expected_revision = status.revision;
    let receipt = f
        .handle
        .stop_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let replay = f
        .handle
        .stop_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(receipt, replay);
    assert!(receipt.is_valid());
    let before_changed_replay = super::tests::snapshot(&f.store).await;
    request.expected_revision = i64::MAX;
    assert!(matches!(
        f.handle
            .stop_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(
        before_changed_replay,
        super::tests::snapshot(&f.store).await
    );
    request.expected_revision = status.revision;
    request.expected_control_revision = after.control_revision.map(|r| r + 1);
    assert!(matches!(
        f.handle
            .stop_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
}

#[tokio::test]
async fn sibling_progress_never_invalidates_worker_control_or_authorizes_another_run() {
    let f = setup().await;
    let (parent, input) = super::worker::tests::running(&f).await;
    let super::worker::WorkerDelegationResult::Fresh(grant) = f
        .handle
        .delegate_worker(&f.token, &parent.run.run_id, &input)
        .await
        .unwrap()
    else {
        panic!()
    };
    let child = f.handle.admit_worker(&f.token, grant).await.unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&child, "child-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(_) = f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let p = &child.provider;
    f.handle
        .append_provider_event(
            &f.owner,
            p,
            &ProviderEventInput {
                run_id: p.run.run_id.clone(),
                session_id: p.run.session_id.clone(),
                sequence: 1,
                lease_generation: p.run.lease_generation,
                dispatch_fence: p.run.dispatch_fence,
                event: ProviderEvent::Started,
            },
        )
        .await
        .unwrap();
    let status = f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &p.run.run_id)
        .await
        .unwrap()
        .unwrap();
    for sequence in 2..=10 {
        f.handle
            .append_provider_event(
                &f.owner,
                &parent,
                &ProviderEventInput {
                    run_id: parent.run.run_id.clone(),
                    session_id: parent.run.session_id.clone(),
                    sequence,
                    lease_generation: parent.run.lease_generation,
                    dispatch_fence: parent.run.dispatch_fence,
                    event: ProviderEvent::Progress("parent progress".into()),
                },
            )
            .await
            .unwrap();
    }
    let after = f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &p.run.run_id)
        .await
        .unwrap()
        .unwrap();
    assert!(after.revision > status.revision);
    assert_eq!(after.control_revision, status.control_revision);
    let request = ExecutionControlRequest {
        run_id: p.run.run_id.clone(),
        expected_revision: status.revision,
        expected_control_revision: status.control_revision,
        request_key: "child-stop".into(),
    };
    f.handle
        .stop_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let before = super::tests::snapshot(&f.store).await;
    let mut wrong = request.clone();
    wrong.run_id = parent.run.run_id.clone();
    // An existing child's request key never authenticates a different run's receipt.
    wrong.expected_control_revision = Some(999999);
    assert!(matches!(
        f.handle
            .stop_execution_authenticated(&f.token, &f.conversation, &wrong)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(before, super::tests::snapshot(&f.store).await);
}

#[tokio::test]
async fn committed_completion_conflicts_with_sampled_running_control_without_writes() {
    let f = setup().await;
    let (parent, _) = super::worker::tests::running(&f).await;
    let status = f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &parent.run.run_id)
        .await
        .unwrap()
        .unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            &parent,
            &ProviderEventInput {
                run_id: parent.run.run_id.clone(),
                session_id: parent.run.session_id.clone(),
                sequence: 2,
                lease_generation: parent.run.lease_generation,
                dispatch_fence: parent.run.dispatch_fence,
                event: ProviderEvent::CompletedProposal { synthetic: false },
            },
        )
        .await
        .unwrap();
    let before = super::tests::snapshot(&f.store).await;
    let request = ExecutionControlRequest {
        run_id: parent.run.run_id.clone(),
        expected_revision: status.revision,
        expected_control_revision: status.control_revision,
        request_key: "stop-after-proposal".into(),
    };
    assert!(matches!(
        f.handle
            .stop_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(before, super::tests::snapshot(&f.store).await);
}
