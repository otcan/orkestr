//! A finished Worker is an owner decision, not fresh descendant execution.
use super::*;
use crate::production_runtime::{observation_tests::input as event, tests::setup};
use orkestr_v2_contracts::ExecutionAcceptanceRequest;

pub(super) type Case = crate::production_runtime::tests::Case;

pub(super) async fn consumed_worker(f: &Case) -> (ProviderAdmission, ProviderAdmission) {
    let (parent, input) = super::tests::running(f).await;
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
        .claim_provider_dispatch(&admission, "completed-worker")
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
    let worker = cap.provider().clone();
    drop(cap);
    (parent, worker)
}

pub(super) async fn running_worker(f: &Case) -> (ProviderAdmission, ProviderAdmission) {
    let (parent, worker) = consumed_worker(f).await;
    f.handle
        .append_provider_event(
            &f.owner,
            &worker,
            &event(&worker, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    (parent, worker)
}

pub(super) async fn completed_worker(f: &Case) -> (ProviderAdmission, ProviderAdmission, EventId) {
    let (parent, worker) = running_worker(f).await;
    let proposal = f
        .handle
        .append_provider_event(
            &f.owner,
            &worker,
            &event(
                &worker,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    (parent, worker, proposal.event_id)
}

pub(super) async fn decision(
    f: &Case,
    provider: &ProviderAdmission,
    completion: EventId,
) -> ExecutionAcceptanceRequest {
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    ExecutionAcceptanceRequest {
        run_id: provider.run.run_id.clone(),
        completion_event_id: completion,
        expected_revision: revision,
        request_key: format!("accept:{}", provider.run.run_id),
    }
}

pub(super) async fn state(f: &Case, worker: &ProviderAdmission) -> (String, String, String) {
    sqlx::query_as("SELECT r.state,b.state,d.state FROM production_runs r JOIN session_bindings b ON b.id=r.session_id JOIN worker_provider_delegations d ON d.id=r.worker_delegation_id WHERE r.id=?")
        .bind(worker.run.run_id.to_string()).fetch_one(&f.store.pool).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
pub(super) async fn completed_worker_remains_owner_decidable_after_parent_proposal() {
    let f = setup().await;
    let (parent, worker, completion) = completed_worker(&f).await;
    let parent_completion = f
        .handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id;
    assert_eq!(
        state(&f, &worker).await,
        (
            "awaiting_acceptance".into(),
            "busy".into(),
            "admitted".into()
        )
    );
    let parent_request = decision(&f, &parent, parent_completion.clone()).await;
    assert!(
        matches!(
            f.store
                .accept_execution_authenticated(&f.token, &f.conversation, &parent_request)
                .await,
            Err(RuntimeStoreError::Busy)
        ),
        "parent must still wait for its unaccepted descendant"
    );
    let before = super::tests::ledger(&f.store).await;
    let mut calls = 0;
    assert!(f
        .handle
        .with_execution_fence(&worker, || {
            calls += 1;
            Ok::<_, ()>(())
        })
        .is_err());
    assert_eq!(
        calls, 0,
        "retained output cannot regain execution authority"
    );
    assert!(f
        .handle
        .append_provider_event(
            &f.owner,
            &worker,
            &event(&worker, 3, ProviderEvent::Progress("late".into()))
        )
        .await
        .is_err());
    assert!(f
        .handle
        .delegate_worker(
            &f.token,
            &parent.run.run_id,
            &WorkerAdmissionInput {
                worker_binding_id: worker.run.session_id.clone(),
                expected_binding_generation: worker.binding.generation,
                source_message_id: MessageId(
                    sqlx::query_scalar::<_, String>(
                        "SELECT message_id FROM production_runs WHERE id=?"
                    )
                    .bind(worker.run.run_id.to_string())
                    .fetch_one(&f.store.pool)
                    .await
                    .unwrap()
                    .parse()
                    .unwrap()
                ),
                source_event_id: EventId(
                    sqlx::query_scalar::<_, String>(
                        "SELECT event_id FROM production_runs WHERE id=?"
                    )
                    .bind(worker.run.run_id.to_string())
                    .fetch_one(&f.store.pool)
                    .await
                    .unwrap()
                    .parse()
                    .unwrap()
                ),
                request_key: "new-after-proposal".into(),
                lifetime_ms: 1000,
            }
        )
        .await
        .is_err());
    assert_eq!(super::tests::ledger(&f.store).await, before);
    // Expired execution leases cannot erase already completed output. No renewed
    // provider grant is minted; owner acceptance uses current browser auth.
    sqlx::query("UPDATE worker_provider_delegations SET expires_at_ms=1 WHERE admitted_run_id=?")
        .bind(worker.run.run_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let request = decision(&f, &worker, completion).await;
    let accepted = f
        .store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(accepted.run_id, worker.run.run_id);
    assert_eq!(
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await
            .unwrap(),
        accepted
    );
    let request = decision(&f, &parent, parent_completion).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
}

#[tokio::test]
pub(super) async fn completed_worker_after_parent_proposal_still_requires_current_owner_auth() {
    let f = setup().await;
    let (parent, worker, completion) = completed_worker(&f).await;
    f.handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let request = decision(&f, &worker, completion).await;
    f.store.revoke_session(&f.token).await.unwrap();
    let before = super::tests::ledger(&f.store).await;
    assert!(matches!(
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(super::tests::ledger(&f.store).await, before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
pub(super) async fn running_worker_finishes_after_parent_proposal_without_new_parent_execution() {
    let f = setup().await;
    let (parent, worker) = running_worker(&f).await;
    let parent_completion = f
        .handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id;
    assert_eq!(
        state(&f, &worker).await,
        ("running".into(), "busy".into(), "admitted".into())
    );
    let request = decision(&f, &parent, parent_completion.clone()).await;
    assert!(matches!(
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Busy)
    ));
    let before = super::tests::ledger(&f.store).await;
    let mut parent_writes = 0;
    assert!(f
        .handle
        .with_execution_fence(&parent, || {
            parent_writes += 1;
            Ok::<_, ()>(())
        })
        .is_err());
    assert_eq!(parent_writes, 0);
    assert_eq!(super::tests::ledger(&f.store).await, before);
    assert_eq!(
        f.handle
            .with_execution_fence(&worker, || Ok::<_, ()>("original-child-only"))
            .unwrap(),
        Ok("original-child-only")
    );
    f.handle
        .append_provider_event(
            &f.owner,
            &worker,
            &event(&worker, 2, ProviderEvent::Progress("child finishes".into())),
        )
        .await
        .unwrap();
    let completion = f
        .handle
        .append_provider_event(
            &f.owner,
            &worker,
            &event(
                &worker,
                3,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id;
    let request = decision(&f, &parent, parent_completion.clone()).await;
    assert!(matches!(
        f.store
            .accept_execution_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Busy)
    ));
    let request = decision(&f, &worker, completion).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let request = decision(&f, &parent, parent_completion).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
}

#[tokio::test]
async fn parent_proposal_never_admits_or_consumes_an_unissued_worker() {
    for admitted in [false, true] {
        let f = setup().await;
        let (parent, input) = super::tests::running(&f).await;
        let WorkerDelegationResult::Fresh(delegation) = f
            .handle
            .delegate_worker(&f.token, &parent.run.run_id, &input)
            .await
            .unwrap()
        else {
            panic!()
        };
        let (pending, candidate) = if admitted {
            (
                None,
                Some(f.handle.admit_worker(&f.token, delegation).await.unwrap()),
            )
        } else {
            (Some(delegation), None)
        };
        f.handle
            .append_provider_event(
                &f.owner,
                &parent,
                &event(
                    &parent,
                    2,
                    ProviderEvent::CompletedProposal { synthetic: false },
                ),
            )
            .await
            .unwrap();
        let before = super::tests::ledger(&f.store).await;
        if let Some(delegation) = pending {
            assert!(f.handle.admit_worker(&f.token, delegation).await.is_err());
        }
        if let Some(candidate) = candidate {
            assert!(f
                .handle
                .claim_provider_dispatch(&candidate, "late-start")
                .await
                .is_err());
        }
        assert_eq!(super::tests::ledger(&f.store).await, before);
    }
}

#[tokio::test]
async fn running_child_can_still_be_stopped_after_parent_proposal() {
    let f = setup().await;
    let (parent, worker) = running_worker(&f).await;
    let parent_completion = f
        .handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id;
    let stop = f
        .handle
        .request_cancel(&f.owner, &worker.run.run_id, "child-stop")
        .await
        .unwrap();
    let mut control = worker.clone();
    control.run = stop.new_fenced_admission;
    assert!(f
        .handle
        .append_provider_event(
            &f.owner,
            &worker,
            &event(&worker, 2, ProviderEvent::Stopped)
        )
        .await
        .is_err());
    let receipt = f
        .handle
        .append_provider_event(
            &f.owner,
            &control,
            &event(&control, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Cancelled);
    let request = decision(&f, &parent, parent_completion).await;
    f.store
        .accept_execution_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
}

#[tokio::test]
async fn consumed_child_may_report_started_after_parent_proposal() {
    let f = setup().await;
    let (parent, worker) = consumed_worker(&f).await;
    f.handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        state(&f, &worker).await,
        ("starting".into(), "busy".into(), "admitted".into())
    );
    let receipt = f
        .handle
        .append_provider_event(
            &f.owner,
            &worker,
            &event(&worker, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Running);
    let receipt = f
        .handle
        .append_provider_event(
            &f.owner,
            &worker,
            &event(
                &worker,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::AwaitingAcceptance);
}
