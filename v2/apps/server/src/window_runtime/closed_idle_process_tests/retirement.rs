//! Typed Store retirement models original native reap; never native acceptance.
use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn close(
    bound: &Store,
    store: &Store,
    browser: &str,
    owner: &OwnerId,
    conv: &ConversationId,
    binding: &Binding,
    credential: &str,
    window: &ExecutionWindowStatus,
) {
    let claim = bound
        .claim_next(owner, conv, &binding.session_id, Duration::from_secs(30))
        .await
        .unwrap()
        .unwrap();
    let run = bound
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "independent-terminal-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&run, "independent-dispatch")
        .await
        .unwrap()
    else {
        panic!("dispatch not reserved")
    };
    let ExecutionConsumption::Dispatch(dispatch) =
        bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!("dispatch not consumed")
    };
    let p = dispatch.provider();
    let event = |sequence, event| ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    };
    bound
        .append_provider_event(owner, p, &event(1, ProviderEvent::Started))
        .await
        .unwrap();
    let done = bound
        .append_provider_event(
            owner,
            p,
            &event(2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    bound
        .begin_execution_window_retirement(
            credential,
            window.window_id,
            window.generation,
            "seed-boot",
        )
        .await
        .unwrap();
    assert!(bound
        .retire_execution_window(
            credential,
            window.window_id,
            window.generation,
            "seed-boot",
            &p.run.run_id
        )
        .await
        .is_err());
    let status = store.execution_status(owner, conv).await.unwrap().unwrap();
    assert_eq!(status.phase, ExecutionPhase::AwaitingAcceptance);
    store
        .accept_execution_authenticated(
            browser,
            conv,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id,
                expected_revision: status.revision,
                request_key: "independent-owner-accept".into(),
            },
        )
        .await
        .unwrap();
    // Trusted typed Store teardown MODELS original native reap. No Runtime proof is fabricated.
    bound
        .retire_terminal_supervisor(credential, &p.run.run_id)
        .await
        .unwrap();
    let (_retired, _handoff) = bound
        .retire_execution_window(
            credential,
            window.window_id,
            window.generation,
            "seed-boot",
            &p.run.run_id,
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .execution_window_status_authenticated(browser, conv)
            .await
            .unwrap()
            .unwrap()
            .state,
        ExecutionWindowState::Closed
    );
}
