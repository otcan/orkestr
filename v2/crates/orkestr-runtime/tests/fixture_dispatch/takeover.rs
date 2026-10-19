//! Separate durable Candidate and DeliveryUnknown takeover cases; no process recovery.
use super::*;
use orkestr_v2_contracts::ProjectInput;
use orkestr_v2_store_sqlite::fixture_runtime::FixtureDispatchState;

async fn namespace_reservation(f: &Fixture) -> (FixtureSupervisorStore, DispatchClaim) {
    let owner = &f.claim.owner_id;
    let other = bootstrap_fixture_supervisor(
        &f.b,
        owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "unrelated-namespace".into(),
            // Same key deliberately tests namespace isolation rather than key isolation.
            supervisor_key: "runtime-dispatch".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    let conversation =
        f.a.create_project(
            owner,
            &ProjectInput {
                client_request_id: "namespace-project".into(),
                name: "Synthetic namespace".into(),
            },
        )
        .await
        .unwrap()
        .project
        .conversation_id;
    let roles =
        f.a.ensure_role_bindings(owner, &conversation)
            .await
            .unwrap();
    let binding = other
        .confirm_fixture_readiness(&roles.deep.session_id, 1)
        .await
        .unwrap();
    f.a.admit(
        owner,
        &conversation,
        &MessageInput {
            client_message_id: "namespace-message".into(),
            text: "Synthetic namespace input".into(),
        },
    )
    .await
    .unwrap();
    let claim =
        f.a.claim_next(
            owner,
            &conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let admitted = other
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "namespace-run",
        )
        .await
        .unwrap();
    let reserved = match other
        .claim_provider_dispatch(&admitted, "namespace-reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => *r,
        _ => panic!("independent namespace must reserve"),
    };
    (other, reserved)
}

async fn takeover_case(delivery_unknown: bool) {
    let f = Fixture::new().await;
    let candidate = f.admit(&f.handle).await;
    let initial = f
        .handle
        .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(initial.dispatch, FixtureDispatchState::Candidate);
    assert!(initial.inbox_acknowledged && initial.candidate_verifier_present);
    assert!(!initial.blocked && !initial.reservation_verifier_present);
    let reserved = if delivery_unknown {
        let claim = match f
            .handle
            .claim_provider_dispatch(&candidate, "synthetic-reserve")
            .await
            .unwrap()
        {
            DispatchClaimResult::Reserved(r) => *r,
            _ => panic!("first reservation"),
        };
        assert_eq!(
            f.handle.fixture_consume_without_reply(&claim).await,
            Err(RuntimeStoreError::Unavailable)
        );
        Some(claim)
    } else {
        None
    };
    let before = f
        .handle
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    assert_eq!(
        (
            before.attempts,
            before.acknowledged,
            before.reservations,
            before.delivery_unknown,
            before.quarantined
        ),
        (1, 1, 0, i64::from(delivery_unknown), 0)
    );
    let (other, other_claim) = namespace_reservation(&f).await;
    let other_conversation = &other_claim.provider.run.conversation_id;
    let other_before = other
        .inspect_fixture_attempt(other_conversation, "namespace-run")
        .await
        .unwrap()
        .unwrap();
    let scope_before = other
        .inspect_fixture_scope(other_conversation)
        .await
        .unwrap();
    assert_eq!(other_before.dispatch, FixtureDispatchState::Reserved);
    assert!(other_before.reservation_verifier_present);
    assert!(other
        .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
        .await
        .unwrap()
        .is_none());

    f.handle.fixture_expire_context().await.unwrap();
    assert_eq!(
        f.handle.validate_context().await,
        Err(RuntimeStoreError::Expired)
    );
    let replacement = bootstrap_fixture_supervisor(
        &f.b,
        &f.claim.owner_id,
        ExplicitFixtureSupervisorConfig {
            namespace: "runtime-synthetic".into(),
            supervisor_key: "runtime-dispatch".into(),
            takeover: FixtureTakeover::ExpiredPredecessor {
                incarnation_id: f.handle.incarnation_id(),
            },
        },
    )
    .await
    .unwrap();
    let after = replacement
        .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.run_id, initial.run_id);
    assert!(after.blocked && after.inbox_acknowledged);
    assert!(!after.candidate_verifier_present && !after.reservation_verifier_present);
    assert_eq!(
        after.dispatch,
        if delivery_unknown {
            FixtureDispatchState::DeliveryUnknown
        } else {
            FixtureDispatchState::Quarantined
        }
    );
    let scope = replacement
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    assert_eq!(
        (
            scope.attempts,
            scope.acknowledged,
            scope.reservations,
            scope.delivery_unknown,
            scope.quarantined
        ),
        (
            1,
            1,
            0,
            i64::from(delivery_unknown),
            i64::from(!delivery_unknown)
        )
    );
    assert_eq!(
        f.handle
            .claim_provider_dispatch(&candidate, "old-reserve")
            .await,
        Err(RuntimeStoreError::Fenced)
    );
    assert_eq!(
        replacement
            .claim_provider_dispatch(&candidate, "new-reserve")
            .await,
        Err(RuntimeStoreError::Fenced)
    );
    let replay = f.admit(&replacement).await;
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    assert_eq!(
        replacement
            .claim_provider_dispatch(&replay, "replay-reserve")
            .await,
        Err(RuntimeStoreError::Fenced)
    );
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    if let Some(claim) = reserved {
        assert_eq!(
            consume_then_fake(&replacement, &claim, &mut fake).await,
            Err(RuntimeStoreError::Fenced)
        );
    }
    assert_eq!(
        fake.poll(&candidate.provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );

    other.validate_context().await.unwrap();
    assert_eq!(
        other
            .inspect_fixture_attempt(other_conversation, "namespace-run")
            .await
            .unwrap()
            .unwrap(),
        other_before
    );
    assert_eq!(
        other
            .inspect_fixture_scope(other_conversation)
            .await
            .unwrap(),
        scope_before
    );
    // Retention means actual unspent authority, not merely unchanged diagnostics.
    assert!(consume_then_fake(&other, &other_claim, &mut fake)
        .await
        .unwrap());
    assert!(!consume_then_fake(&other, &other_claim, &mut fake)
        .await
        .unwrap());
    f.close().await;
}

#[tokio::test]
async fn candidate_expiry_takeover_quarantines_without_touching_other_namespace() {
    takeover_case(false).await;
}

#[tokio::test]
async fn unknown_expiry_takeover_preserves_uncertainty_and_other_namespace() {
    takeover_case(true).await;
}
