use super::observation_tests::input;
use super::tests::{claim, setup, snapshot, Case};
use super::*;

async fn claude() -> Case {
    let mut f = setup().await;
    f.handle = f
        .store
        .authorize_supervisor(
            &f.token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Claude,
                namespace: "synthetic-claude".into(),
                supervisor_key: "claude-initialization".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    f
}
fn initialization(native: &str) -> ClaudeProcessInitialization {
    ClaudeProcessInitialization {
        requested_native_session_id: native.into(),
        protocol_version: "claude-control-v1".into(),
        source_event_key: "initialize:1".into(),
    }
}
async fn initialized(f: &Case) -> ReadySessionTransition {
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let metadata = f.handle.authorize_session_metadata(&binding).await.unwrap();
    f.handle
        .initialize_claude_session(metadata, initialization(&Uuid::new_v4().to_string()))
        .await
        .unwrap()
}
async fn consume(f: &Case, link: ReadySessionTransition) -> ConsumedProviderDispatch {
    let b = link.binding().clone();
    let claim = claim(f, &b).await;
    let run = f
        .handle
        .admit_run(&claim, &b.session_id, b.generation, "claude-run")
        .await
        .unwrap();
    // Identity evidence cannot arrive under an unconsumed candidate.
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .observe_claude_session(
                &run.provider,
                run.provider.run.native_session_id.as_deref().unwrap(),
                "init:1"
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(&run, "claude-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    link.attach_execution(*cap).unwrap()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn process_ack_reserves_but_never_observes_native_identity() {
    let f = claude().await;
    let link = initialized(&f).await;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM production_requested_native WHERE observed_run_id IS NULL AND observed_event_key IS NULL").fetch_one(&f.store.pool).await.unwrap();
    assert_eq!(count, 1);
    assert!(matches!(
        f.handle
            .with_metadata_fence(link.metadata(), || Ok::<_, ()>(())),
        Err(RuntimeStoreError::Fenced)
    ));
    let cap = consume(&f, link).await;
    let p = cap.provider();
    let before = snapshot(&f.store).await;
    for event in [
        ProviderEvent::Started,
        ProviderEvent::Progress("synthetic output".into()),
        ProviderEvent::CompletedProposal { synthetic: false },
    ] {
        assert!(matches!(
            f.handle
                .append_provider_event(&f.owner, p, &input(p, 1, event))
                .await,
            Err(RuntimeStoreError::Fenced)
        ));
        assert_eq!(snapshot(&f.store).await, before);
    }
    assert!(matches!(
        f.handle
            .observe_claude_session(p, &Uuid::new_v4().to_string(), "init:1")
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach_supervisor(&reopened).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle
            .observe_claude_session(p, p.run.native_session_id.as_deref().unwrap(), "init:1"),
        handle.observe_claude_session(p, p.run.native_session_id.as_deref().unwrap(), "init:1")
    );
    a.unwrap();
    b.unwrap();
    let observed = snapshot(&f.store).await;
    assert!(matches!(
        handle
            .observe_claude_session(
                p,
                p.run.native_session_id.as_deref().unwrap(),
                "changed-key"
            )
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(snapshot(&f.store).await, observed);
    let started = input(p, 1, ProviderEvent::Started);
    let receipt = handle
        .append_provider_event(&f.owner, p, &started)
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Running);
    assert_eq!(
        handle
            .append_provider_event(&f.owner, p, &started)
            .await
            .unwrap()
            .event_id,
        receipt.event_id
    );
    let done = handle
        .append_provider_event(
            &f.owner,
            p,
            &input(p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    assert_eq!(done.state, RunState::AwaitingAcceptance);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unobserved_identity_does_not_block_failure_or_issued_stop_cleanup() {
    for failed in [true, false] {
        let f = claude().await;
        let cap = consume(&f, initialized(&f).await).await;
        let p = cap.provider();
        if failed {
            assert_eq!(
                f.handle
                    .append_provider_event(&f.owner, p, &input(p, 1, ProviderEvent::Failed))
                    .await
                    .unwrap()
                    .state,
                RunState::Failed
            );
        } else {
            let receipt = f
                .handle
                .request_cancel(&f.owner, &p.run.run_id, "stop-before-init")
                .await
                .unwrap();
            let control = ProviderAdmission {
                run: receipt.new_fenced_admission,
                binding: p.binding.clone(),
            };
            assert_eq!(
                f.handle
                    .append_provider_event(
                        &f.owner,
                        &control,
                        &input(&control, 1, ProviderEvent::Stopped)
                    )
                    .await
                    .unwrap()
                    .state,
                RunState::Cancelled
            );
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_auth_and_exact_envelope_required_for_observed_identity() {
    let f = claude().await;
    let cap = consume(&f, initialized(&f).await).await;
    let p = cap.provider();
    let before = snapshot(&f.store).await;
    let mut forged = p.clone();
    forged.run.dispatch_fence += 1;
    assert!(matches!(
        f.handle
            .observe_claude_session(
                &forged,
                p.run.native_session_id.as_deref().unwrap(),
                "init:1"
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .observe_claude_session(p, p.run.native_session_id.as_deref().unwrap(), "init:1")
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(snapshot(&f.store).await, before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_resume_requires_a_new_observation_for_the_new_consumed_turn() {
    continuation(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirmed_stopped_resume_requires_new_observation_and_preserves_history() {
    continuation(true).await;
}
async fn continuation(stopped: bool) {
    use orkestr_v2_application::IntakeStore;
    use orkestr_v2_contracts::{ExecutionAcceptanceRequest, MessageInput};
    let f = claude().await;
    let cap = consume(&f, initialized(&f).await).await;
    let p = cap.provider();
    let native = p.run.native_session_id.as_deref().unwrap();
    f.handle
        .observe_claude_session(p, native, "first-init")
        .await
        .unwrap();
    f.handle
        .append_provider_event(&f.owner, p, &input(p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    if stopped {
        let cancel = f
            .handle
            .request_cancel(&f.owner, &p.run.run_id, "stop-first")
            .await
            .unwrap();
        let control = ProviderAdmission {
            run: cancel.new_fenced_admission,
            binding: p.binding.clone(),
        };
        f.handle
            .append_provider_event(
                &f.owner,
                &control,
                &input(&control, 2, ProviderEvent::Stopped),
            )
            .await
            .unwrap();
    } else {
        let done = f
            .handle
            .append_provider_event(
                &f.owner,
                p,
                &input(p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
            )
            .await
            .unwrap();
        let status = f
            .store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap();
        f.store
            .accept_execution_authenticated(
                &f.token,
                &f.conversation,
                &ExecutionAcceptanceRequest {
                    run_id: p.run.run_id.clone(),
                    completion_event_id: done.event_id,
                    expected_revision: status.revision,
                    request_key: "accept-first".into(),
                },
            )
            .await
            .unwrap();
    }
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let grant = if stopped {
        f.handle
            .authorize_stopped_session_metadata(&f.token, &p.run.run_id, &binding)
            .await
            .unwrap()
    } else {
        f.handle
            .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &binding)
            .await
            .unwrap()
    };
    let transition = f
        .handle
        .initialize_claude_session(grant, initialization(native))
        .await
        .unwrap();
    assert_eq!(transition.binding(), &binding);
    let reissue = if stopped {
        f.handle
            .authorize_stopped_session_metadata(&f.token, &p.run.run_id, &binding)
            .await
    } else {
        f.handle
            .authorize_accepted_session_metadata(&f.token, &p.run.run_id, &binding)
            .await
    };
    assert!(matches!(reissue, Err(RuntimeStoreError::Conflict)));
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "resume-message".into(),
                text: "synthetic continuation".into(),
            },
        )
        .await
        .unwrap();
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let run = f
        .handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "resume-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(&run, "resume-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(next) = f.handle.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    let next = transition.attach_execution(*next).unwrap();
    let next = next.provider();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .append_provider_event(&f.owner, next, &input(next, 1, ProviderEvent::Started))
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    f.handle
        .observe_claude_session(next, native, "resumed-init")
        .await
        .unwrap();
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, next, &input(next, 1, ProviderEvent::Started))
            .await
            .unwrap()
            .state,
        RunState::Running
    );
    // Original observation receipts remain historical; they do not touch successor.
    let before = snapshot(&f.store).await;
    assert!(
        f.handle
            .append_provider_event(&f.owner, p, &input(p, 1, ProviderEvent::Started))
            .await
            .unwrap()
            .duplicate
    );
    assert_eq!(snapshot(&f.store).await, before);
}
