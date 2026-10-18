//! Actual-store committed replay remains evidence, never renewed execution authority.
use super::*;

#[tokio::test]
async fn committed_receipt_survives_expiry_takeover_but_forgery_and_new_evidence_do_not() {
    let f = Fixture::new().await;
    let provider = consumed(&f).await;
    let mut input = failed(&provider);
    input.event = ProviderEvent::Started;
    let original = f
        .handle
        .append_provider_event(&f.claim.owner_id, &provider, &input)
        .await
        .unwrap();
    assert_eq!(original.state, RunState::Running);
    let events_before = serde_json::to_vec(
        &f.a.events(&f.claim.owner_id, &f.claim.conversation_id, 0, 100)
            .await
            .unwrap(),
    )
    .unwrap();
    f.handle.fixture_expire_context().await.unwrap();
    let mut successor = None;
    for taken_over in [false, true] {
        if taken_over {
            successor = Some(
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
                .unwrap(),
            );
        }
        let replay = f
            .handle
            .append_provider_event(&f.claim.owner_id, &provider, &input)
            .await
            .unwrap();
        assert!(replay.duplicate);
        assert_eq!(replay.event_id, original.event_id);
        assert_eq!(replay.sequence, original.sequence);
        assert_eq!(replay.scope_sequence, original.scope_sequence);
        assert_eq!(replay.state, RunState::Running); // Historical receipt, not current run state.
        let mut changed = input.clone();
        for event in [
            ProviderEvent::Failed,
            ProviderEvent::Stopped,
            ProviderEvent::Progress("synthetic".into()),
        ] {
            changed.event = event;
            assert_eq!(
                f.handle
                    .append_provider_event(&f.claim.owner_id, &provider, &changed)
                    .await,
                Err(RuntimeStoreError::Conflict)
            );
        }
        let mut forged = provider.clone();
        forged.run.role = Role::Worker;
        assert!(f
            .handle
            .append_provider_event(&f.claim.owner_id, &forged, &input)
            .await
            .is_err());
        let mut forged_owner = f.claim.owner_id.clone();
        // Another typed UUID already available, without inventing any store principal.
        forged_owner.0 = f.claim.conversation_id.0;
        assert_eq!(
            f.handle
                .append_provider_event(&forged_owner, &provider, &input)
                .await,
            Err(RuntimeStoreError::Unauthorized)
        );
        let mut unseen = input.clone();
        unseen.sequence = 2;
        unseen.event = ProviderEvent::ApprovalRequested;
        assert_eq!(
            f.handle
                .append_provider_event(&f.claim.owner_id, &provider, &unseen)
                .await,
            Err(if taken_over {
                RuntimeStoreError::Fenced
            } else {
                RuntimeStoreError::Expired
            })
        );
        let events_after = serde_json::to_vec(
            &f.a.events(&f.claim.owner_id, &f.claim.conversation_id, 0, 100)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(
            events_before == events_after,
            "refusal/replay changed canonical event bytes"
        );
    }
    let successor = successor.unwrap();
    let attempt = successor
        .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
        .await
        .unwrap()
        .unwrap();
    assert!(attempt.blocked && attempt.inbox_acknowledged);
    assert_eq!(
        attempt.dispatch,
        orkestr_v2_store_sqlite::fixture_runtime::FixtureDispatchState::DeliveryUnknown
    );
    assert!(!attempt.candidate_verifier_present && !attempt.reservation_verifier_present);
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    assert_eq!(
        fake.poll(&provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
    f.close().await;
}
