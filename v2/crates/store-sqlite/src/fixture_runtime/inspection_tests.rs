use super::dispatch_tests::fixture;
use super::*;
use orkestr_v2_application::runtime::*;

#[tokio::test]
async fn inspection_is_scoped_and_never_returns_dispatch_authority() {
    let f = fixture().await;
    assert!(f
        .handle
        .inspect_fixture_attempt(&f.conversation, "run1")
        .await
        .unwrap()
        .is_none());
    let before = f
        .handle
        .inspect_fixture_scope(&f.conversation)
        .await
        .unwrap();
    assert_eq!(
        (before.attempts, before.acknowledged, before.reservations),
        (0, 0, 0)
    );
    let candidate = f.admit().await;
    let snapshot = f
        .handle
        .inspect_fixture_attempt(&f.conversation, "run1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.run_id, candidate.provider.run.run_id);
    assert_eq!(snapshot.dispatch, FixtureDispatchState::Candidate);
    assert!(snapshot.inbox_acknowledged && snapshot.candidate_verifier_present);
    assert!(!snapshot.reservation_verifier_present);
    let DispatchClaimResult::Reserved(claim) = f
        .handle
        .claim_provider_dispatch(&candidate, "reserve1")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let snapshot = f
        .handle
        .inspect_fixture_attempt(&f.conversation, "run1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.dispatch, FixtureDispatchState::Reserved);
    assert!(snapshot.reservation_verifier_present);
    assert!(matches!(
        f.handle.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    ));
    let snapshot = f
        .handle
        .inspect_fixture_attempt(&f.conversation, "run1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.dispatch, FixtureDispatchState::DeliveryUnknown);
    assert!(!snapshot.candidate_verifier_present && !snapshot.reservation_verifier_present);
    let other = bootstrap_fixture_supervisor(
        &f.b,
        &f.owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "other-fixture".into(),
            supervisor_key: "other-key".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    assert!(other
        .inspect_fixture_attempt(&f.conversation, "run1")
        .await
        .unwrap()
        .is_none());
    f.cleanup().await;
}

#[cfg(feature = "fixture-test-controls")]
#[tokio::test]
async fn explicit_controls_drop_reply_and_only_expire_bound_context() {
    let f = fixture().await;
    let candidate = f.admit().await;
    let DispatchClaimResult::Reserved(claim) = f
        .handle
        .claim_provider_dispatch(&candidate, "reserve1")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    assert_eq!(
        f.handle.fixture_consume_without_reply(&claim).await,
        Err(RuntimeStoreError::Unavailable)
    );
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach(&reopened).await.unwrap();
    assert!(matches!(
        attached.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    ));
    let other = bootstrap_fixture_supervisor(
        &f.b,
        &f.owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "other-fixture".into(),
            supervisor_key: "other-key".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    attached.fixture_expire_context().await.unwrap();
    assert_eq!(
        attached.validate_context().await,
        Err(RuntimeStoreError::Expired)
    );
    assert_eq!(
        attached.fixture_expire_context().await,
        Err(RuntimeStoreError::Expired)
    );
    other.validate_context().await.unwrap();
    let successor = bootstrap_fixture_supervisor(
        &f.a,
        &f.owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "explicit-fixture".into(),
            supervisor_key: "fixture-worker".into(),
            takeover: FixtureTakeover::ExpiredPredecessor {
                incarnation_id: attached.incarnation_id(),
            },
        },
    )
    .await
    .unwrap();
    successor.validate_context().await.unwrap();
    let counts = successor
        .inspect_fixture_scope(&f.conversation)
        .await
        .unwrap();
    assert_eq!(
        (
            counts.attempts,
            counts.acknowledged,
            counts.reservations,
            counts.delivery_unknown,
            counts.quarantined
        ),
        (1, 1, 0, 1, 0)
    );
    let prior = successor
        .inspect_fixture_attempt(&f.conversation, "run1")
        .await
        .unwrap()
        .unwrap();
    assert!(prior.blocked);
    assert_eq!(prior.dispatch, FixtureDispatchState::DeliveryUnknown);
    assert_eq!(
        attached.validate_context().await,
        Err(RuntimeStoreError::Fenced)
    );
    reopened.close().await;
    f.cleanup().await;
}
