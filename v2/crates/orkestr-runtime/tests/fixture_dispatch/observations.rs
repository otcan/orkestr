//! Actual Core fixture observation acceptance; no production provider dispatch.
use super::*;

fn failed(provider: &ProviderAdmission) -> ProviderEventInput {
    ProviderEventInput {
        run_id: provider.run.run_id.clone(),
        session_id: provider.run.session_id.clone(),
        lease_generation: provider.run.lease_generation,
        dispatch_fence: provider.run.dispatch_fence,
        sequence: 1,
        event: ProviderEvent::Failed,
    }
}

async fn consumed(f: &Fixture) -> ProviderAdmission {
    let reserved = f.reserve().await;
    assert_eq!(
        f.handle.consume_provider_dispatch(&reserved).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    // Deliberately no provider start or invented Started observation.
    reserved.provider
}

#[tokio::test]
async fn consumed_starting_failure_is_first_event_and_replays_original_receipt() {
    let f = Fixture::new().await;
    let provider = consumed(&f).await;
    let input = failed(&provider);
    let receipt = f
        .handle
        .append_provider_event(&f.claim.owner_id, &provider, &input)
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Failed);
    assert_eq!(receipt.sequence, 1);
    assert_eq!(receipt.scope_sequence, f.claim.scope_sequence + 1);
    assert!(!receipt.duplicate);
    // Reopen independent pool using original live authority, not process recovery.
    f.close().await;
    let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
    let attached = f.handle.reattach(&reopened).await.unwrap();
    let duplicate = attached
        .append_provider_event(&f.claim.owner_id, &provider, &input)
        .await
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.event_id, receipt.event_id);
    assert_eq!(duplicate.scope_sequence, receipt.scope_sequence);
    assert_eq!(duplicate.sequence, receipt.sequence);
    assert_eq!(duplicate.state, RunState::Failed);
    let mut changed = input.clone();
    changed.event = ProviderEvent::Started;
    assert_eq!(
        attached
            .append_provider_event(&f.claim.owner_id, &provider, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    );
    reopened.close().await;
}

#[tokio::test]
async fn failed_session_cannot_admit_another_turn_or_spend_its_inbox_claim() {
    let f = Fixture::new().await;
    let provider = consumed(&f).await;
    let receipt = f
        .handle
        .append_provider_event(&f.claim.owner_id, &provider, &failed(&provider))
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Failed);
    f.a.admit(
        &f.claim.owner_id,
        &f.claim.conversation_id,
        &MessageInput {
            client_message_id: "after-failed".into(),
            text: "Synthetic later input".into(),
        },
    )
    .await
    .unwrap();
    let next =
        f.a.claim_next(
            &f.claim.owner_id,
            &f.claim.conversation_id,
            &f.binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let before = f
        .handle
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    for _ in 0..2 {
        assert_eq!(
            f.handle
                .admit_run(
                    &next,
                    &f.binding.session_id,
                    f.binding.generation,
                    "after-failed-run"
                )
                .await,
            Err(RuntimeStoreError::Busy)
        );
        assert_eq!(
            f.handle
                .inspect_fixture_scope(&f.claim.conversation_id)
                .await
                .unwrap(),
            before
        );
        assert!(f
            .handle
            .inspect_fixture_attempt(&f.claim.conversation_id, "after-failed-run")
            .await
            .unwrap()
            .is_none());
    }
    assert_eq!(before.attempts, 1);
    assert_eq!(before.acknowledged, 1);
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    assert_eq!(
        fake.poll(&provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
    f.close().await;
}

#[cfg(feature = "fixture-test-controls")]
#[path = "observation_replay.rs"]
mod authority;

#[path = "observation_matrix.rs"]
mod matrix;
