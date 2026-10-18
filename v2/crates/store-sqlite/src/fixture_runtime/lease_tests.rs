//! Store-clock renewal cannot recreate provider dispatch or rewrite receipt history.
use super::dispatch_tests::{fixture, fixture_with_claim_duration};
use super::guard_tests::snapshot;
use super::observation_contract_tests::{consumed, input};
use super::*;
use orkestr_v2_application::runtime::*;
use std::time::Duration;

#[tokio::test]
async fn independent_renewal_cas_has_one_winner_and_history_survives_reopen() {
    let f = fixture_with_claim_duration(Duration::from_secs(10)).await;
    let p = consumed(&f).await;
    let second = f.handle.reattach(&f.b).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle.renew_lease(&p.run, 1),
        second.renew_lease(&p.run, 1)
    );
    let renewed = match (a, b) {
        (Ok(run), Err(RuntimeStoreError::StaleLease))
        | (Err(RuntimeStoreError::StaleLease), Ok(run)) => run,
        other => panic!("one CAS winner: {other:?}"),
    };
    assert_eq!(renewed.lease_generation, 2);
    assert!(renewed.lease_deadline_ms > p.run.lease_deadline_ms);
    assert_eq!(renewed.dispatch_fence, p.run.dispatch_fence);
    let max: i64 = sqlx::query_scalar("SELECT lease_deadline_ms FROM fixture_supervisors")
        .fetch_one(&f.a.pool)
        .await
        .unwrap();
    assert!(renewed.lease_deadline_ms <= max);
    let mut active = p.clone();
    active.run = renewed.clone();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle.renew_lease(&renewed, 2).await.unwrap_err(),
        RuntimeStoreError::Busy
    );
    assert_eq!(
        f.handle.renew_lease(&p.run, 1).await.unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
            .await
            .unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    assert!(before == snapshot(&f).await);
    f.a.close().await;
    f.b.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach(&reopened).await.unwrap();
    let receipt = handle
        .append_provider_event(
            &f.owner,
            &active,
            &input(&active, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Running);
    assert_eq!(
        reopened.renew_lease(&renewed, 2).await.unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    reopened.close().await;
    f.cleanup().await;
}

#[tokio::test]
async fn historical_committed_evidence_replays_after_renewal_but_new_stale_input_cannot_write() {
    let f = fixture_with_claim_duration(Duration::from_secs(10)).await;
    let p = consumed(&f).await;
    let event = input(&p, 1, ProviderEvent::Started);
    let original = f
        .handle
        .append_provider_event(&f.owner, &p, &event)
        .await
        .unwrap();
    let renewed = f.handle.renew_lease(&p.run, 1).await.unwrap();
    let before = snapshot(&f).await;
    let retry = f
        .handle
        .append_provider_event(&f.owner, &p, &event)
        .await
        .unwrap();
    assert_eq!(retry.event_id, original.event_id);
    assert_eq!(retry.scope_sequence, original.scope_sequence);
    assert!(retry.duplicate);
    assert_eq!(retry.state, RunState::Running);
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Failed))
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 2, ProviderEvent::Failed))
            .await
            .unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    let mut forged = p.clone();
    forged.run.lease_deadline_ms += 1;
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &forged, &event)
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert!(before == snapshot(&f).await);
    let mut active = p.clone();
    active.run = renewed;
    let proposal = f
        .handle
        .append_provider_event(
            &f.owner,
            &active,
            &input(
                &active,
                2,
                ProviderEvent::CompletedProposal { synthetic: true },
            ),
        )
        .await
        .unwrap();
    assert_eq!(proposal.state, RunState::AwaitingAcceptance);
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle.renew_lease(&active.run, 2).await.unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert!(before == snapshot(&f).await);
    f.cleanup().await;
}

#[tokio::test]
async fn renewal_refuses_tampered_identity_purpose_generation_readiness_without_consuming_authority(
) {
    let f = fixture_with_claim_duration(Duration::from_secs(10)).await;
    let p = consumed(&f).await;
    let before = snapshot(&f).await;
    for (name, tamper, dispatch_error) in super::guard_tests::provider_tampers() {
        let mut changed = p.clone();
        tamper(&mut changed);
        // renew takes RunAdmission, not the separately supplied binding snapshot.
        if changed.run == p.run {
            continue;
        }
        let expected = if name == "purpose" {
            RuntimeStoreError::Fenced
        } else {
            dispatch_error
        };
        assert_eq!(
            f.handle.renew_lease(&changed.run, 1).await.unwrap_err(),
            expected,
            "{name}"
        );
        assert!(before == snapshot(&f).await, "{name}");
    }
    assert_eq!(
        f.handle.renew_lease(&p.run, 0).await.unwrap_err(),
        RuntimeStoreError::InvalidInput
    );
    assert_eq!(
        f.handle.renew_lease(&p.run, 2).await.unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    assert!(before == snapshot(&f).await);
    sqlx::query("UPDATE fixture_readiness SET incarnation_id='synthetic-unavailable'")
        .execute(&f.a.pool)
        .await
        .unwrap();
    let damaged = snapshot(&f).await;
    assert_eq!(
        f.handle.renew_lease(&p.run, 1).await.unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert!(damaged == snapshot(&f).await);
    sqlx::query("UPDATE fixture_readiness SET incarnation_id=?")
        .bind(f.handle.incarnation_id().to_string())
        .execute(&f.a.pool)
        .await
        .unwrap();
    assert_eq!(
        f.handle
            .renew_lease(&p.run, 1)
            .await
            .unwrap()
            .lease_generation,
        2
    );
    f.cleanup().await;
}

#[tokio::test]
async fn renewal_failure_rolls_back_and_never_reissues_or_consumes_dispatch_locator() {
    let f = fixture_with_claim_duration(Duration::from_secs(10)).await;
    let fresh = f.admit().await;
    let DispatchClaimResult::Reserved(mut claim) = f
        .handle
        .claim_provider_dispatch(&fresh, "reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    sqlx::query("CREATE TRIGGER fixture_fail_renew BEFORE INSERT ON fixture_run_leases WHEN NEW.generation>1 BEGIN SELECT RAISE(ABORT,'synthetic renewal failure'); END").execute(&f.a.pool).await.unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .renew_lease(&fresh.provider.run, 1)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert!(before == snapshot(&f).await);
    sqlx::query("DROP TRIGGER fixture_fail_renew")
        .execute(&f.a.pool)
        .await
        .unwrap();
    let renewed = f.handle.renew_lease(&fresh.provider.run, 1).await.unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .consume_provider_dispatch(&claim)
            .await
            .unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    assert!(before == snapshot(&f).await);
    claim.provider.run = renewed;
    assert_eq!(
        f.handle.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    assert_eq!(
        f.handle.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    );
    f.cleanup().await;
}

#[tokio::test]
async fn expired_or_terminal_run_cannot_renew_and_full_supervisor_bound_cannot_extend() {
    let f = fixture_with_claim_duration(Duration::from_secs(1)).await;
    let p = consumed(&f).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle.renew_lease(&p.run, 1).await.unwrap_err(),
        RuntimeStoreError::Expired
    );
    assert!(before == snapshot(&f).await);
    f.cleanup().await;
    for terminal in [ProviderEvent::Failed, ProviderEvent::Lost] {
        let f = fixture_with_claim_duration(Duration::from_secs(10)).await;
        let p = consumed(&f).await;
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, terminal))
            .await
            .unwrap();
        let before = snapshot(&f).await;
        assert_eq!(
            f.handle.renew_lease(&p.run, 1).await.unwrap_err(),
            RuntimeStoreError::Fenced
        );
        assert!(before == snapshot(&f).await);
        f.cleanup().await;
    }
    let f = fixture().await;
    let fresh = f.admit().await;
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .renew_lease(&fresh.provider.run, 1)
            .await
            .unwrap_err(),
        RuntimeStoreError::Busy
    );
    assert!(before == snapshot(&f).await);
    f.cleanup().await;
}

#[tokio::test]
async fn another_namespace_or_expired_incarnation_cannot_renew_authority() {
    let f = fixture_with_claim_duration(Duration::from_secs(10)).await;
    let p = consumed(&f).await;
    let other = bootstrap_fixture_supervisor(
        &f.b,
        &f.owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "other-fixture".into(),
            supervisor_key: "fixture-worker".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        other.renew_lease(&p.run, 1).await.unwrap_err(),
        RuntimeStoreError::NotFound
    );
    assert!(before == snapshot(&f).await);
    // Core-only damage fixture: no arbitrary expiry setter in normal builds.
    sqlx::query("UPDATE fixture_supervisors SET lease_deadline_ms=0 WHERE incarnation_id=?")
        .bind(f.handle.incarnation_id().to_string())
        .execute(&f.a.pool)
        .await
        .unwrap();
    let expired = snapshot(&f).await;
    assert_eq!(
        f.handle.renew_lease(&p.run, 1).await.unwrap_err(),
        RuntimeStoreError::Expired
    );
    assert!(expired == snapshot(&f).await);
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
    assert_eq!(
        f.handle.renew_lease(&p.run, 1).await.unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        successor.renew_lease(&p.run, 1).await.unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert!(before == snapshot(&f).await);
    other.validate_context().await.unwrap();
    f.cleanup().await;
}
