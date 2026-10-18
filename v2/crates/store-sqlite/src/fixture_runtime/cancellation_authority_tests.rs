//! Refusals and historical receipt authority, separate from happy-path control.
use super::dispatch_tests::{fixture, fixture_with_claim_duration};
use super::guard_tests::snapshot;
use super::observation_contract_tests::{consumed, input};
use super::*;
use orkestr_v2_application::runtime::*;
use std::time::Duration;

#[tokio::test]
async fn cancellation_principal_readiness_and_expiry_refusals_preserve_every_row() {
    let f = fixture_with_claim_duration(Duration::from_secs(1)).await;
    let p = consumed(&f).await;
    let other = bootstrap_fixture_supervisor(
        &f.b,
        &f.owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "unrelated-fixture".into(),
            supervisor_key: "fixture-worker".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        other
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::NotFound
    );
    assert_eq!(
        f.handle
            .request_cancel(&OwnerId(Uuid::new_v4()), &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::Unauthorized
    );
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &p.run.run_id, "bad key")
            .await
            .unwrap_err(),
        RuntimeStoreError::InvalidInput
    );
    assert!(before == snapshot(&f).await);
    sqlx::query("UPDATE fixture_readiness SET incarnation_id=? WHERE session_id=?")
        .bind(Uuid::new_v4().to_string())
        .bind(p.run.session_id.to_string())
        .execute(&f.a.pool)
        .await
        .unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert!(before == snapshot(&f).await);
    sqlx::query("UPDATE fixture_readiness SET incarnation_id=? WHERE session_id=?")
        .bind(f.handle.incarnation_id.to_string())
        .bind(p.run.session_id.to_string())
        .execute(&f.a.pool)
        .await
        .unwrap();
    let before = snapshot(&f).await;
    tokio::time::sleep(Duration::from_millis(1050)).await;
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::Expired
    );
    assert!(before == snapshot(&f).await);
    f.cleanup().await;
}

#[tokio::test]
async fn committed_cancel_and_stop_replay_after_takeover_without_new_authority() {
    for stopped_committed in [false, true] {
        let f = fixture().await;
        let p = consumed(&f).await;
        let receipt = f
            .handle
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap();
        let c = ProviderAdmission {
            run: receipt.new_fenced_admission.clone(),
            binding: p.binding.clone(),
        };
        let stopped = input(&c, 1, ProviderEvent::Stopped);
        let original = if stopped_committed {
            Some(
                f.handle
                    .append_provider_event(&f.owner, &c, &stopped)
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        // Unit-only expiry fixture; independent process acceptance uses a real
        // deadline/public test controls and never copies this SQL technique.
        sqlx::query("UPDATE fixture_supervisors SET lease_deadline_ms=0 WHERE context_id=?")
            .bind(f.handle.context_id.to_string())
            .execute(&f.a.pool)
            .await
            .unwrap();
        let before = snapshot(&f).await;
        assert_eq!(
            f.handle
                .request_cancel(&f.owner, &p.run.run_id, "cancel")
                .await
                .unwrap(),
            receipt
        );
        if original.is_none() {
            assert_eq!(
                f.handle
                    .append_provider_event(&f.owner, &c, &stopped)
                    .await
                    .unwrap_err(),
                RuntimeStoreError::Expired
            );
        }
        assert!(before == snapshot(&f).await);
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
            successor
                .request_cancel(&f.owner, &p.run.run_id, "cancel")
                .await
                .unwrap(),
            receipt
        );
        assert_eq!(
            f.handle
                .request_cancel(&f.owner, &p.run.run_id, "cancel")
                .await
                .unwrap(),
            receipt
        );
        if let Some(original) = original {
            let replay = successor
                .append_provider_event(&f.owner, &c, &stopped)
                .await
                .unwrap();
            assert_eq!(
                (
                    replay.event_id,
                    replay.scope_sequence,
                    replay.state,
                    replay.duplicate
                ),
                (
                    original.event_id,
                    original.scope_sequence,
                    RunState::Cancelled,
                    true
                )
            );
            assert_eq!(
                successor
                    .append_provider_event(&f.owner, &c, &input(&c, 1, ProviderEvent::Failed))
                    .await
                    .unwrap_err(),
                RuntimeStoreError::Conflict
            );
        } else {
            assert_eq!(
                successor
                    .append_provider_event(&f.owner, &c, &stopped)
                    .await
                    .unwrap_err(),
                RuntimeStoreError::Fenced
            );
        }
        assert_eq!(
            successor
                .append_provider_event(&f.owner, &c, &input(&c, 2, ProviderEvent::Stopped))
                .await
                .unwrap_err(),
            RuntimeStoreError::Fenced
        );
        assert!(before == snapshot(&f).await);
        f.cleanup().await;
    }
}

#[tokio::test]
async fn completion_and_cancellation_race_preserves_terminal_truth() {
    for _ in 0..4 {
        let f = fixture().await;
        let p = consumed(&f).await;
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
            .await
            .unwrap();
        let other = f.handle.reattach(&f.b).await.unwrap();
        let proposal = input(&p, 2, ProviderEvent::CompletedProposal { synthetic: true });
        let (completion, cancel) = tokio::join!(
            f.handle.append_provider_event(&f.owner, &p, &proposal),
            other.request_cancel(&f.owner, &p.run.run_id, "cancel")
        );
        match (completion, cancel) {
            (Ok(receipt), Err(RuntimeStoreError::Fenced)) => {
                assert_eq!(receipt.state, RunState::AwaitingAcceptance);
                let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM fixture_cancellations")
                    .fetch_one(&f.a.pool)
                    .await
                    .unwrap();
                assert_eq!(rows, 0);
            }
            (Err(RuntimeStoreError::Fenced), Ok(receipt)) => {
                assert_eq!(
                    (receipt.state, receipt.inflight_status),
                    (RunState::CancelRequested, InflightStatus::Unknown)
                );
                let rows: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM fixture_observations WHERE kind='completed_proposal'",
                )
                .fetch_one(&f.a.pool)
                .await
                .unwrap();
                assert_eq!(rows, 0);
            }
            other => panic!("terminal truth race: {other:?}"),
        }
        f.cleanup().await;
    }
}
