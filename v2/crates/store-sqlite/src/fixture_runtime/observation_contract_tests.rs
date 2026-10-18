//! Actual fixture observation adapter acceptance.
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
    let canonical: i64 = sqlx::query_scalar("SELECT count(*) FROM fixture_observations o JOIN events e ON e.id=o.event_id JOIN outbox b ON b.event_id=e.id JOIN fixture_runs r ON r.id=o.run_id WHERE r.id=? AND e.kind='fixture_provider_observed' AND e.schema_version=2 AND e.message_id IS NULL AND e.conversation_id=r.conversation_id AND e.owner_id=r.owner_id")
        .bind(p.run.run_id.to_string()).fetch_one(&f.a.pool).await.unwrap();
    assert_eq!(canonical, 2);
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE conversation_id=?")
        .bind(f.conversation.to_string())
        .fetch_one(&f.a.pool)
        .await
        .unwrap();
    assert_eq!(
        messages, 1,
        "provider metadata must never become owner messages"
    );
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::CompletedProposal { synthetic: false })
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 3, ProviderEvent::Started))
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert!(before == snapshot(&f).await);

    f.cleanup().await;
}

#[tokio::test]
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

#[tokio::test]
async fn failed_before_started_is_terminal_replayable_and_never_releases_session() {
    use orkestr_v2_application::IntakeStore;
    use orkestr_v2_contracts::{ConversationEvent, MessageInput};
    use std::time::Duration;
    let f = fixture().await;
    let p = consumed(&f).await;
    let e = input(&p, 1, ProviderEvent::Failed);
    let failed = f
        .handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    assert_eq!(failed.state, RunState::Failed);
    f.a.admit(
        &f.owner,
        &f.conversation,
        &MessageInput {
            client_message_id: "followup".into(),
            text: "Synthetic followup".into(),
        },
    )
    .await
    .unwrap();
    let claim =
        f.a.claim_next(
            &f.owner,
            &f.conversation,
            &f.binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .admit_run(
                &claim,
                &f.binding.session_id,
                f.binding.generation,
                "second-run"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Busy
    );
    assert!(before == snapshot(&f).await);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach(&reopened).await.unwrap();
    let replay = handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(failed.event_id, replay.event_id);
    assert_eq!(replay.state, RunState::Failed);
    let events = reopened
        .events(&f.owner, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(events.len(), 3);
    assert!(matches!(&events[0], ConversationEvent::MessageAccepted(_)));
    let ConversationEvent::FixtureProviderObserved(observed) = &events[1] else {
        panic!("distinct canonical variant")
    };
    assert_eq!(observed.source_message_id, f.claim.message_id);
    assert_eq!(observed.source_event_id, f.claim.event_id);
    assert_eq!(observed.payload_ref_or_safe_payload.run_sequence, 1);
    assert!(matches!(&events[2], ConversationEvent::MessageAccepted(_)));
    assert_eq!(
        events
            .iter()
            .map(ConversationEvent::sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    reopened.close().await;
    f.cleanup().await;
}

#[tokio::test]
async fn forged_envelopes_cannot_read_committed_receipts_or_append_evidence() {
    let f = fixture().await;
    let p = consumed(&f).await;
    let e = input(&p, 1, ProviderEvent::Started);
    f.handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    let before = snapshot(&f).await;
    for (case, mutate, _) in super::guard_tests::provider_tampers() {
        let mut forged = p.clone();
        mutate(&mut forged);
        assert!(
            f.handle
                .append_provider_event(&f.owner, &forged, &e)
                .await
                .is_err(),
            "forged committed replay accepted: {case}"
        );
        assert!(
            before == snapshot(&f).await,
            "forged replay changed rows: {case}"
        );
        let unseen = input(&p, 2, ProviderEvent::ApprovalRequested);
        assert!(
            f.handle
                .append_provider_event(&f.owner, &forged, &unseen)
                .await
                .is_err(),
            "forged unseen evidence accepted: {case}"
        );
        assert!(
            before == snapshot(&f).await,
            "forged unseen changed rows: {case}"
        );
    }
    for (lease, fence) in [
        (p.run.lease_generation + 1, p.run.dispatch_fence),
        (p.run.lease_generation, p.run.dispatch_fence + 1),
    ] {
        let mut changed = e.clone();
        changed.lease_generation = lease;
        changed.dispatch_fence = fence;
        assert_eq!(
            f.handle
                .append_provider_event(&f.owner, &p, &changed)
                .await
                .unwrap_err(),
            RuntimeStoreError::Conflict
        );
        changed.sequence = 2;
        assert!(matches!(
            f.handle
                .append_provider_event(&f.owner, &p, &changed)
                .await
                .unwrap_err(),
            RuntimeStoreError::StaleLease | RuntimeStoreError::Fenced
        ));
        assert!(before == snapshot(&f).await);
    }
    f.cleanup().await;
}

#[tokio::test]
async fn ordinary_store_append_stays_unavailable_and_lease_expired_committed_retry_is_read_only() {
    use std::time::Duration;
    let mut f = fixture().await;
    // Test-only shorten the unadmitted claim; admission persists this exact deadline.
    let deadline = now(&mut f.a.pool.acquire().await.unwrap()).await.unwrap() + 1500;
    f.claim.lease_deadline_ms = deadline;
    sqlx::query("UPDATE reasoning_inbox SET claim_deadline_ms=? WHERE conversation_id=?")
        .bind(deadline)
        .bind(f.conversation.to_string())
        .execute(&f.a.pool)
        .await
        .unwrap();
    let p = consumed(&f).await;
    let e = input(&p, 1, ProviderEvent::Started);
    let before = snapshot(&f).await;
    assert_eq!(
        f.a.append_provider_event(&f.owner, &p, &e)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert!(before == snapshot(&f).await);
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let before = snapshot(&f).await;
    let duplicate = f
        .handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.event_id, receipt.event_id);
    assert_eq!(
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::ApprovalRequested)
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Expired
    );
    assert!(before == snapshot(&f).await);
    f.cleanup().await;
}
