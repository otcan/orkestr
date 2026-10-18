//! Pending migration/DTO decision: ignored tests are NOT passing acceptance.
use super::dispatch_tests::{fixture, Fixture};
use super::guard_tests::snapshot;
use super::*;
use orkestr_v2_application::runtime::*;

async fn consumed(f: &Fixture) -> ProviderAdmission {
    let fresh = f.admit().await;
    let DispatchClaimResult::Reserved(claim) = f
        .handle
        .claim_provider_dispatch(&fresh, "reserve1")
        .await
        .unwrap()
    else {
        panic!("fresh fixture reservation")
    };
    assert_eq!(
        f.handle.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    claim.provider
}
fn input(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        sequence,
        event,
    }
}
#[tokio::test]
async fn current_append_is_explicitly_unavailable_and_preserves_rows() {
    let f = fixture().await;
    let p = consumed(&f).await;
    let before = snapshot(&f).await;
    for event in [
        ProviderEvent::Started,
        ProviderEvent::CompletedProposal { synthetic: true },
        ProviderEvent::Progress("synthetic text".into()),
        ProviderEvent::Stopped,
    ] {
        assert_eq!(
            f.handle
                .append_provider_event(&f.owner, &p, &input(&p, 1, event))
                .await
                .unwrap_err(),
            RuntimeStoreError::Unavailable
        );
        assert!(
            before == snapshot(&f).await,
            "unimplemented append mutated durable authority"
        );
    }
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "pending reviewed 0005 event/DTO extension and fixture observation adapter"]
async fn contiguous_receipts_and_proposal_never_mean_verified_success() {
    let f = fixture().await;
    let p = consumed(&f).await;
    let started = f
        .handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    assert_eq!(started.sequence, 1);
    assert_eq!(started.scope_sequence, f.claim.scope_sequence + 1);
    assert_eq!(started.state, RunState::Running);
    assert!(!started.duplicate);
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 3, ProviderEvent::ApprovalRequested)
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert!(before == snapshot(&f).await, "sequence gap wrote an event");
    let proposal = f
        .handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 2, ProviderEvent::CompletedProposal { synthetic: true }),
        )
        .await
        .unwrap();
    assert_eq!(proposal.state, RunState::AwaitingAcceptance);
    assert_eq!(proposal.scope_sequence, started.scope_sequence + 1);
    assert_ne!(proposal.event_id, started.event_id);
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "pending reviewed 0005 event/DTO extension and fixture observation adapter"]
async fn concurrent_identical_receipt_is_stable_and_changed_body_conflicts() {
    let f = fixture().await;
    let p = consumed(&f).await;
    let second = f.handle.reattach(&f.b).await.unwrap();
    let e = input(&p, 1, ProviderEvent::Started);
    let (a, b) = tokio::join!(
        f.handle.append_provider_event(&f.owner, &p, &e),
        second.append_provider_event(&f.owner, &p, &e)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(
        (a.event_id, a.scope_sequence, a.sequence, a.state),
        (b.event_id, b.scope_sequence, b.sequence, b.state)
    );
    assert_ne!(a.duplicate, b.duplicate);
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Lost))
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert!(before == snapshot(&f).await, "changed replay mutated state");
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "pending reviewed 0005 event/DTO extension and fixture observation adapter"]
async fn authenticated_committed_replay_precedes_expiry_and_fence_refusal() {
    let f = fixture().await;
    let p = consumed(&f).await;
    let e = input(&p, 1, ProviderEvent::Started);
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    sqlx::query("UPDATE fixture_supervisors SET lease_deadline_ms=0")
        .execute(&f.a.pool)
        .await
        .unwrap();
    let successor = bootstrap_fixture_supervisor(
        &f.b,
        &f.owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "explicit-fixture".into(),
            supervisor_key: "fixture-worker".into(),
            takeover: FixtureTakeover::ExpiredPredecessor {
                incarnation_id: f.handle.incarnation_id(),
            },
        },
    )
    .await
    .unwrap();
    let before = snapshot(&f).await;
    for handle in [&f.handle, &successor] {
        let replay = handle
            .append_provider_event(&f.owner, &p, &e)
            .await
            .unwrap();
        assert_eq!(
            (replay.event_id, replay.scope_sequence, replay.state),
            (
                receipt.event_id.clone(),
                receipt.scope_sequence,
                receipt.state
            )
        );
        assert!(replay.duplicate);
        assert!(handle
            .append_provider_event(&OwnerId(Uuid::new_v4()), &p, &e)
            .await
            .is_err());
        assert_eq!(
            handle
                .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Lost))
                .await
                .unwrap_err(),
            RuntimeStoreError::Conflict
        );
        assert!(handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::CompletedProposal { synthetic: true })
            )
            .await
            .is_err());
        assert!(
            before == snapshot(&f).await,
            "replay/refusal changed post-takeover rows"
        );
    }
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "pending reviewed 0005 event/DTO extension and fixture observation adapter"]
async fn undispatched_candidate_cannot_accept_provider_evidence() {
    let f = fixture().await;
    let fresh = f.admit().await;
    let before = snapshot(&f).await;
    assert!(f
        .handle
        .append_provider_event(
            &f.owner,
            &fresh.provider,
            &input(&fresh.provider, 1, ProviderEvent::Started)
        )
        .await
        .is_err());
    assert!(
        before == snapshot(&f).await,
        "undispatched event spent candidate"
    );
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "pending reviewed 0005 event/DTO extension and fixture observation adapter"]
async fn progress_and_stopped_remain_unavailable_without_payload_or_cancel_authority() {
    let f = fixture().await;
    let p = consumed(&f).await;
    let before = snapshot(&f).await;
    for event in [
        ProviderEvent::Progress("synthetic text".into()),
        ProviderEvent::Stopped,
    ] {
        assert_eq!(
            f.handle
                .append_provider_event(&f.owner, &p, &input(&p, 1, event))
                .await
                .unwrap_err(),
            RuntimeStoreError::Unavailable
        );
        assert!(
            before == snapshot(&f).await,
            "unsupported evidence changed rows"
        );
    }
    assert_eq!(
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 1, ProviderEvent::Progress("é".repeat(4097)))
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::InvalidInput
    );
    assert!(before == snapshot(&f).await);
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "pending reviewed 0005 event/DTO extension and fixture observation adapter"]
async fn projection_failure_rolls_back_event_outbox_and_sequence_then_retry_succeeds() {
    let f = fixture().await;
    let p = consumed(&f).await;
    sqlx::query("CREATE TRIGGER fixture_observation_projection_failure BEFORE UPDATE OF state ON fixture_runs BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END").execute(&f.a.pool).await.unwrap();
    let before = snapshot(&f).await;
    let e = input(&p, 1, ProviderEvent::Started);
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &p, &e)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert!(
        before == snapshot(&f).await,
        "projection failure left partial rows"
    );
    sqlx::query("DROP TRIGGER fixture_observation_projection_failure")
        .execute(&f.a.pool)
        .await
        .unwrap();
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    assert!(!receipt.duplicate);
    assert_eq!(receipt.sequence, 1);
    assert_eq!(receipt.scope_sequence, f.claim.scope_sequence + 1);
    f.cleanup().await;
}
