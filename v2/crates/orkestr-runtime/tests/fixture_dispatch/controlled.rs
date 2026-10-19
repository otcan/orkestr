use super::*;
use orkestr_v2_store_sqlite::fixture_runtime::FixtureDispatchState;

async fn successor(f: &Fixture) -> FixtureSupervisorStore {
    bootstrap_fixture_supervisor(
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
    .unwrap()
}

#[tokio::test]
async fn core_drop_reply_control_persists_unknown_without_fake_io_after_reopen() {
    let f = Fixture::new().await;
    let reserved = f.reserve().await;
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
            before.delivery_unknown
        ),
        (1, 1, 1, 0)
    );
    assert_eq!(
        f.handle.fixture_consume_without_reply(&reserved).await,
        Err(RuntimeStoreError::Unavailable)
    );
    f.close().await;
    let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
    let attached = f.handle.reattach(&reopened).await.unwrap();
    let attempt = attached
        .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(attempt.dispatch, FixtureDispatchState::DeliveryUnknown);
    assert!(attempt.inbox_acknowledged);
    assert!(!attempt.candidate_verifier_present && !attempt.reservation_verifier_present);
    let scope = attached
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    assert_eq!(
        (
            scope.attempts,
            scope.acknowledged,
            scope.delivery_unknown,
            scope.reservations
        ),
        (1, 1, 1, 0)
    );
    let replay = f.admit(&attached).await;
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    assert_eq!(
        attached
            .claim_provider_dispatch(&replay, "replacement-reserve")
            .await
            .unwrap(),
        DispatchClaimResult::ReconciliationRequired
    );
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    assert!(!consume_then_fake(&attached, &reserved, &mut fake)
        .await
        .unwrap());
    assert_eq!(
        fake.poll(&reserved.provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
    reopened.close().await;
}

#[tokio::test]
async fn exact_predecessor_takeover_quarantines_reservation_and_preserves_other_key() {
    let f = Fixture::new().await;
    let reserved = f.reserve().await;
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
            before.delivery_unknown
        ),
        (1, 1, 1, 0)
    );
    let other = bootstrap_fixture_supervisor(
        &f.b,
        &f.claim.owner_id,
        ExplicitFixtureSupervisorConfig {
            namespace: "runtime-synthetic".into(),
            supervisor_key: "unrelated-key".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
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
    let replacement = successor(&f).await;
    other.validate_context().await.unwrap();
    assert_eq!(
        other
            .inspect_fixture_scope(&f.claim.conversation_id)
            .await
            .unwrap()
            .attempts,
        0
    );
    let attempt = replacement
        .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
        .await
        .unwrap()
        .unwrap();
    assert!(attempt.blocked && attempt.inbox_acknowledged);
    assert_eq!(attempt.dispatch, FixtureDispatchState::Quarantined);
    assert!(!attempt.candidate_verifier_present && !attempt.reservation_verifier_present);
    let scope = replacement
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    assert_eq!(
        (
            scope.attempts,
            scope.acknowledged,
            scope.quarantined,
            scope.reservations
        ),
        (1, 1, 1, 0)
    );
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    assert_eq!(
        consume_then_fake(&f.handle, &reserved, &mut fake).await,
        Err(RuntimeStoreError::Fenced)
    );
    assert_eq!(
        consume_then_fake(&replacement, &reserved, &mut fake).await,
        Err(RuntimeStoreError::Fenced)
    );
    assert_eq!(
        fake.poll(&reserved.provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
    assert_eq!(
        f.handle
            .inspect_fixture_scope(&f.claim.conversation_id)
            .await,
        Err(RuntimeStoreError::Fenced)
    );
    f.close().await;
}

#[tokio::test]
async fn takeover_preserves_delivery_unknown_and_never_redispatches() {
    let f = Fixture::new().await;
    let reserved = f.reserve().await;
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
            before.delivery_unknown
        ),
        (1, 1, 1, 0)
    );
    assert_eq!(
        f.handle.fixture_consume_without_reply(&reserved).await,
        Err(RuntimeStoreError::Unavailable)
    );
    f.handle.fixture_expire_context().await.unwrap();
    let replacement = successor(&f).await;
    let attempt = replacement
        .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
        .await
        .unwrap()
        .unwrap();
    assert!(attempt.blocked && attempt.inbox_acknowledged);
    assert_eq!(attempt.dispatch, FixtureDispatchState::DeliveryUnknown);
    let scope = replacement
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    assert_eq!(
        (
            scope.delivery_unknown,
            scope.quarantined,
            scope.reservations
        ),
        (1, 0, 0)
    );
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    assert_eq!(
        consume_then_fake(&replacement, &reserved, &mut fake).await,
        Err(RuntimeStoreError::Fenced)
    );
    assert_eq!(
        fake.poll(&reserved.provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
    f.close().await;
}
