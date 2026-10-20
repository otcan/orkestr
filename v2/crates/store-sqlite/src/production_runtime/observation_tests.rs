use super::*;
use crate::production_runtime::tests::{claim, ready, setup, snapshot, Case};
use orkestr_v2_application::IntakeStore;
pub(super) async fn consumed(f: &Case) -> ProviderAdmission {
    let b = ready(f).await;
    let claim = claim(f, &b).await;
    let run = f
        .handle
        .admit_run(&claim, &b.session_id, b.generation, "observation-run")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&run, "observation-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        f.handle.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    run.provider
}
pub(super) fn input(
    p: &ProviderAdmission,
    sequence: u64,
    event: ProviderEvent,
) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    }
}
#[tokio::test]
async fn concurrent_observations_have_one_receipt_and_completion_is_only_proposal() {
    let f = setup().await;
    let p = consumed(&f).await;
    let second = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&second).await.unwrap();
    let started = input(&p, 1, ProviderEvent::Started);
    let (a, b) = tokio::join!(
        f.handle.append_provider_event(&f.owner, &p, &started),
        attached.append_provider_event(&f.owner, &p, &started)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.event_id, b.event_id);
    assert_ne!(a.duplicate, b.duplicate);
    let done = input(&p, 2, ProviderEvent::CompletedProposal { synthetic: false });
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &p, &done)
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::AwaitingAcceptance);
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status.phase,
        orkestr_v2_contracts::ExecutionPhase::AwaitingAcceptance
    );
    let history = f
        .store
        .events(&f.owner, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(history[1].sse_name(), "provider_observed");
    assert!(
        matches!(&history[2],orkestr_v2_contracts::ConversationEvent::ProviderObserved(e) if e.schema_version==5 && e.is_valid())
    );
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 3, ProviderEvent::Failed))
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
}
#[tokio::test]
async fn committed_replay_survives_expiry_and_takeover_without_rewriting_terminal_history() {
    let f = setup().await;
    let p = consumed(&f).await;
    let failed = input(&p, 1, ProviderEvent::Failed);
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &p, &failed)
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Failed);
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let successor = f
        .store
        .authorize_supervisor(
            &f.token,
            super::tests::config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
            }),
        )
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    let replay = successor
        .append_provider_event(&f.owner, &p, &failed)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(receipt.event_id, replay.event_id);
    assert_eq!(replay.state, RunState::Failed);
    assert!(matches!(
        successor
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Lost))
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(matches!(
        successor
            .append_provider_event(&f.owner, &p, &input(&p, 2, ProviderEvent::Started))
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let status = reopened
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.phase, orkestr_v2_contracts::ExecutionPhase::Failed);
}
#[tokio::test]
async fn failure_class_is_closed_replay_stable_and_only_on_failed_status() {
    use orkestr_v2_contracts::{ExecutionFailure, ExecutionFailureClass, ExecutionPhase};
    let f = setup().await;
    let p = consumed(&f).await;
    let failed = input(
        &p,
        1,
        ProviderEvent::FailedWith(ExecutionFailureClass::Quota),
    );
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &p, &failed)
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Failed);
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.phase, ExecutionPhase::Failed);
    assert_eq!(
        status.failure,
        Some(ExecutionFailure {
            class: ExecutionFailureClass::Quota
        })
    );
    assert!(status.is_valid());
    let wire = serde_json::to_value(&status).unwrap();
    assert_eq!(wire["failure"], serde_json::json!({"class": "quota"}));
    // The class is part of the committed digest: a replay cannot relabel it.
    let before = snapshot(&f.store).await;
    let relabeled = input(
        &p,
        1,
        ProviderEvent::FailedWith(ExecutionFailureClass::Authentication),
    );
    assert!(matches!(
        f.handle
            .append_provider_event(&f.owner, &p, &relabeled)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(matches!(
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Failed))
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(
        f.handle
            .append_provider_event(&f.owner, &p, &failed)
            .await
            .unwrap()
            .duplicate
    );
    assert_eq!(snapshot(&f.store).await, before);
}
#[tokio::test]
async fn unclassified_failure_has_no_failure_field() {
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Failed))
        .await
        .unwrap();
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert!(status.failure.is_none());
    assert!(serde_json::to_value(&status)
        .unwrap()
        .get("failure")
        .is_none());
}
#[tokio::test]
async fn forgery_gaps_synthetic_and_unavailable_progress_do_not_spend_sequence() {
    let f = setup().await;
    let p = consumed(&f).await;
    let before = snapshot(&f.store).await;
    let mut forged = p.clone();
    forged.run.lease_deadline_ms += 1;
    assert!(matches!(
        f.handle
            .append_provider_event(&f.owner, &forged, &input(&p, 1, ProviderEvent::Started))
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    for (sequence, event) in [
        (2, ProviderEvent::Started),
        (1, ProviderEvent::CompletedProposal { synthetic: true }),
        (1, ProviderEvent::Progress("synthetic delta".into())),
        (1, ProviderEvent::Stopped),
    ] {
        assert!(f
            .handle
            .append_provider_event(&f.owner, &p, &input(&p, sequence, event))
            .await
            .is_err());
        assert_eq!(snapshot(&f.store).await, before);
    }
    let accepted = f
        .handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Failed))
        .await
        .unwrap();
    assert_eq!(accepted.state, RunState::Failed);
    let after = snapshot(&f.store).await;
    let mut forged = p.clone();
    forged.binding.generation += 1;
    assert!(matches!(
        f.handle
            .append_provider_event(&f.owner, &forged, &input(&p, 1, ProviderEvent::Failed))
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(snapshot(&f.store).await, after);
}
