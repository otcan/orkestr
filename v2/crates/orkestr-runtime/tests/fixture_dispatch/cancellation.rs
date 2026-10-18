//! Public fixture cancellation envelopes; no production dispatch or process-crash claim.
use super::*;
use orkestr_runtime::supervisor::{self, PendingObservation};

fn event(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
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
async fn concurrent_cancel_erases_candidate_and_reservation_without_fake_delivery() {
    for reserved in [false, true] {
        let f = Fixture::new().await;
        let fresh = f.admit(&f.handle).await;
        let reservation = if reserved {
            let DispatchClaimResult::Reserved(r) = f
                .handle
                .claim_provider_dispatch(&fresh, "reserve")
                .await
                .unwrap()
            else {
                panic!("reservation")
            };
            Some(r)
        } else {
            None
        };
        let independent = f.handle.reattach(&f.b).await.unwrap();
        let (a, b) = tokio::join!(
            f.handle
                .request_cancel(&f.claim.owner_id, &fresh.provider.run.run_id, "cancel"),
            independent.request_cancel(&f.claim.owner_id, &fresh.provider.run.run_id, "cancel")
        );
        let receipt = a.unwrap();
        assert_eq!(receipt, b.unwrap());
        assert_eq!(receipt.state, RunState::Cancelled);
        assert_eq!(receipt.inflight_status, InflightStatus::NotDispatched);
        assert!(f
            .handle
            .claim_provider_dispatch(&fresh, "later")
            .await
            .is_err());
        if let Some(r) = reservation {
            assert!(f.handle.consume_provider_dispatch(&r).await.is_err());
        }
        let attempt = f
            .handle
            .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
            .await
            .unwrap()
            .unwrap();
        assert!(!attempt.candidate_verifier_present);
        assert!(!attempt.reservation_verifier_present);
        let mut fake = FakeProvider::fixture_only(true).unwrap();
        assert_eq!(
            fake.poll(&fresh.provider.run),
            Err(orkestr_runtime::ports::Blocker::UnknownSession)
        );
        f.close().await;
    }
}

#[tokio::test]
async fn control_cannot_start_or_poll_and_stopped_replays_after_pool_reopen() {
    let f = Fixture::new().await;
    let reservation = f.reserve().await;
    assert_eq!(
        f.handle
            .consume_provider_dispatch(&reservation)
            .await
            .unwrap(),
        DispatchConsumption::DispatchNow
    );
    let p = reservation.provider;
    let started = event(&p, 1, ProviderEvent::Started);
    let original = f
        .handle
        .append_provider_event(&f.claim.owner_id, &p, &started)
        .await
        .unwrap();
    let receipt = f
        .handle
        .request_cancel(&f.claim.owner_id, &p.run.run_id, "cancel")
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::CancelRequested);
    assert_eq!(receipt.inflight_status, InflightStatus::Unknown);
    let control = ProviderAdmission {
        run: receipt.new_fenced_admission.clone(),
        binding: p.binding.clone(),
    };
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    assert!(fake.start(&control.run).is_err());
    assert!(fake.poll(&control.run).is_err());
    let mut cursor = PendingObservation::default();
    assert!(
        supervisor::step(&f.handle, &mut fake, &control, &mut cursor)
            .await
            .is_err()
    );
    assert!(cursor.pending().is_none());
    let stopped = event(&control, 2, ProviderEvent::Stopped);
    // Original execution token cannot confirm cancellation.
    assert!(f
        .handle
        .append_provider_event(&f.claim.owner_id, &p, &event(&p, 2, ProviderEvent::Stopped))
        .await
        .is_err());
    let confirmed = f
        .handle
        .append_provider_event(&f.claim.owner_id, &control, &stopped)
        .await
        .unwrap();
    assert_eq!(confirmed.state, RunState::Cancelled);
    f.close().await;
    let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
    let handle = f.handle.reattach(&reopened).await.unwrap();
    assert_eq!(
        handle
            .request_cancel(&f.claim.owner_id, &p.run.run_id, "cancel")
            .await
            .unwrap(),
        receipt
    );
    let replay = handle
        .append_provider_event(&f.claim.owner_id, &control, &stopped)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.event_id, confirmed.event_id);
    assert_eq!(replay.scope_sequence, confirmed.scope_sequence);
    let historical = handle
        .append_provider_event(&f.claim.owner_id, &p, &started)
        .await
        .unwrap();
    assert!(historical.duplicate);
    assert_eq!(historical.event_id, original.event_id);
    let before = serde_json::to_vec(
        &reopened
            .events(&f.claim.owner_id, &f.claim.conversation_id, 0, 100)
            .await
            .unwrap(),
    )
    .unwrap();
    for input in [
        event(&control, 2, ProviderEvent::Failed),
        event(&control, 3, ProviderEvent::Stopped),
        event(&p, 3, ProviderEvent::Started),
    ] {
        let envelope = if input.lease_generation == control.run.lease_generation {
            &control
        } else {
            &p
        };
        assert!(handle
            .append_provider_event(&f.claim.owner_id, envelope, &input)
            .await
            .is_err());
        assert_eq!(
            serde_json::to_vec(
                &reopened
                    .events(&f.claim.owner_id, &f.claim.conversation_id, 0, 100)
                    .await
                    .unwrap()
            )
            .unwrap(),
            before
        );
    }
    reopened.close().await;
}

#[tokio::test]
async fn pending_execution_observation_keeps_identity_when_cancellation_fences_retry() {
    let f = Fixture::new().await;
    let reservation = f.reserve().await;
    assert_eq!(
        f.handle
            .consume_provider_dispatch(&reservation)
            .await
            .unwrap(),
        DispatchConsumption::DispatchNow
    );
    let p = reservation.provider;
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    fake.start(&p.run).unwrap(); // Explicit consumed fixture boundary only.
    f.a.close().await;
    let mut cursor = PendingObservation::default();
    assert_eq!(
        supervisor::step(&f.handle, &mut fake, &p, &mut cursor).await,
        Err(supervisor::Error::Store(RuntimeStoreError::Unavailable))
    );
    let pending = cursor.pending().unwrap().clone();
    assert_eq!(pending.event, ProviderEvent::Started);
    let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
    let handle = f.handle.reattach(&reopened).await.unwrap();
    handle
        .request_cancel(&f.claim.owner_id, &p.run.run_id, "cancel")
        .await
        .unwrap();
    let before = serde_json::to_vec(
        &reopened
            .events(&f.claim.owner_id, &f.claim.conversation_id, 0, 100)
            .await
            .unwrap(),
    )
    .unwrap();
    let failure = supervisor::step(&handle, &mut fake, &p, &mut cursor).await;
    assert!(matches!(
        failure,
        Err(supervisor::Error::Store(
            RuntimeStoreError::StaleLease | RuntimeStoreError::Fenced
        ))
    ));
    let (original, rejected, _) = cursor.rejected().unwrap();
    assert_eq!(original, &p);
    assert_eq!(rejected, &pending);
    assert_eq!(
        supervisor::step(&handle, &mut fake, &p, &mut cursor).await,
        failure
    );
    assert_eq!(
        serde_json::to_vec(
            &reopened
                .events(&f.claim.owner_id, &f.claim.conversation_id, 0, 100)
                .await
                .unwrap()
        )
        .unwrap(),
        before
    );
    reopened.close().await;
    f.b.close().await;
}
