//! Volatile retries only, never database/restart acceptance.
mod support;
use orkestr_runtime::{
    fake::FakeProvider,
    ports::*,
    supervisor::{self, Error, PendingObservation},
};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::runtime::SessionRole;
use support::*;
#[test]
fn fail_once_record_retries_same_terminal_after_provider_has_removed_turn() {
    for terminal in [
        ProviderEvent::CompletedProposal { synthetic: true },
        ProviderEvent::Failed,
        ProviderEvent::Lost,
    ] {
        let a = admission(SessionRole::Worker, 10);
        let store = Spy::new(a.clone());
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let mut pending = PendingObservation::default();
        p.start(&a).unwrap();
        assert_eq!(
            ready(supervisor::step(
                &store,
                &mut p,
                &provider_admission(&a),
                &mut pending
            )),
            Ok(true)
        );
        p.emit(&a, terminal.clone()).unwrap();
        store.state.lock().unwrap().fail_once = true;
        assert_eq!(
            ready(supervisor::step(
                &store,
                &mut p,
                &provider_admission(&a),
                &mut pending
            )),
            Err(Error::Store(RuntimeStoreError::Unavailable))
        );
        assert_eq!(p.poll(&a), Err(Blocker::UnknownSession));
        assert_eq!(
            ready(supervisor::step(
                &store,
                &mut p,
                &provider_admission(&a),
                &mut pending
            )),
            Ok(true)
        );
        let s = store.state.lock().unwrap();
        assert_eq!(
            s.accepted
                .iter()
                .map(|i| i.event.clone())
                .collect::<Vec<_>>(),
            vec![ProviderEvent::Started, terminal]
        );
        assert_eq!(s.attempts[1], s.attempts[2]);
        assert_eq!(s.attempts[0].sequence, 1);
        assert_eq!(s.attempts[1].sequence, 2);
        drop(s);
        assert_eq!(
            ready(supervisor::step(
                &store,
                &mut p,
                &provider_admission(&a),
                &mut pending
            )),
            Err(Error::Provider(Blocker::UnknownSession))
        );
    }
}
#[test]
fn stale_or_expired_discards_delivery_without_repoll_or_readmission() {
    for error in [
        RuntimeStoreError::StaleLease,
        RuntimeStoreError::Fenced,
        RuntimeStoreError::Expired,
    ] {
        let a = admission(SessionRole::Worker, 10);
        let store = Spy::new(a.clone());
        store.state.lock().unwrap().refusal = Some(error);
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let mut pending = PendingObservation::default();
        p.start(&a).unwrap();
        p.poll(&a).unwrap();
        p.emit(&a, ProviderEvent::Lost).unwrap();
        for _ in 0..2 {
            assert_eq!(
                ready(supervisor::step(
                    &store,
                    &mut p,
                    &provider_admission(&a),
                    &mut pending
                )),
                Err(Error::Store(error))
            );
        }
        assert!(pending.pending().is_none());
        let (original, evidence, refusal) = pending.rejected().unwrap();
        assert_eq!(original, &provider_admission(&a));
        assert_eq!(evidence.event, ProviderEvent::Lost);
        assert_eq!(evidence.sequence, 1);
        assert_eq!(refusal, error);
        let s = store.state.lock().unwrap();
        assert!(s.accepted.is_empty());
        assert_eq!(s.attempts.len(), 1);
    }
}
#[test]
fn retry_does_not_relabel_old_observation_with_new_admission() {
    let a = admission(SessionRole::Worker, 10);
    let store = Spy::new(a.clone());
    store.state.lock().unwrap().fail_once = true;
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let mut pending = PendingObservation::default();
    p.start(&a).unwrap();
    assert_eq!(
        ready(supervisor::step(
            &store,
            &mut p,
            &provider_admission(&a),
            &mut pending
        )),
        Err(Error::Store(RuntimeStoreError::Unavailable))
    );
    let mut newer = a.clone();
    newer.lease_generation += 1;
    assert_eq!(
        ready(supervisor::step(
            &store,
            &mut p,
            &provider_admission(&newer),
            &mut pending
        )),
        Err(Error::Store(RuntimeStoreError::StaleLease))
    );
    assert_eq!(
        ready(supervisor::step(
            &store,
            &mut p,
            &provider_admission(&a),
            &mut pending
        )),
        Ok(true)
    );
    assert_eq!(store.state.lock().unwrap().accepted.len(), 1);
}

#[test]
fn busy_retries_same_event_and_conflict_blocks_without_ack() {
    for error in [RuntimeStoreError::Busy, RuntimeStoreError::Conflict] {
        let a = admission(SessionRole::Worker, 10);
        let store = Spy::new(a.clone());
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let mut pending = PendingObservation::default();
        p.start(&a).unwrap();
        store.state.lock().unwrap().refusal = Some(error);
        assert_eq!(
            ready(supervisor::step(
                &store,
                &mut p,
                &provider_admission(&a),
                &mut pending
            )),
            Err(Error::Store(error))
        );
        let original = pending.pending().unwrap().clone();
        store.state.lock().unwrap().refusal = None;
        let result = ready(supervisor::step(
            &store,
            &mut p,
            &provider_admission(&a),
            &mut pending,
        ));
        if error == RuntimeStoreError::Conflict {
            assert_eq!(result, Err(Error::Store(error)));
            assert_eq!(pending.pending(), Some(&original));
            assert_eq!(store.state.lock().unwrap().attempts.len(), 1);
        } else {
            assert_eq!(result, Ok(true));
            let state = store.state.lock().unwrap();
            assert_eq!(state.attempts[0], state.attempts[1]);
        }
    }
}
#[test]
fn committed_terminal_lost_ack_retries_original_key_without_duplicate() {
    let a = admission(SessionRole::Worker, 10);
    let store = Spy::new(a.clone());
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let mut pending = PendingObservation::default();
    p.start(&a).unwrap();
    p.poll(&a).unwrap();
    p.emit(&a, ProviderEvent::CompletedProposal { synthetic: true })
        .unwrap();
    store.state.lock().unwrap().lose_ack_once = true;
    assert_eq!(
        ready(supervisor::step(
            &store,
            &mut p,
            &provider_admission(&a),
            &mut pending
        )),
        Err(Error::Store(RuntimeStoreError::Unavailable))
    );
    assert_eq!(p.poll(&a), Err(Blocker::UnknownSession));
    assert_eq!(
        ready(supervisor::step(
            &store,
            &mut p,
            &provider_admission(&a),
            &mut pending
        )),
        Ok(true)
    );
    let state = store.state.lock().unwrap();
    assert_eq!(state.attempts[0], state.attempts[1]);
    assert_eq!(state.accepted.len(), 1);
    assert!(pending.pending().is_none());
}

#[test]
fn committed_lost_ack_replay_returns_receipt_after_authority_revoked() {
    for error in [RuntimeStoreError::Fenced, RuntimeStoreError::Expired] {
        let a = admission(SessionRole::Worker, 10);
        let store = Spy::new(a.clone());
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let mut pending = PendingObservation::default();
        p.start(&a).unwrap();
        p.poll(&a).unwrap();
        p.emit(&a, ProviderEvent::CompletedProposal { synthetic: true })
            .unwrap();
        store.state.lock().unwrap().lose_ack_once = true;
        assert_eq!(
            ready(supervisor::step(
                &store,
                &mut p,
                &provider_admission(&a),
                &mut pending
            )),
            Err(Error::Store(RuntimeStoreError::Unavailable))
        );
        store.state.lock().unwrap().refusal = Some(error);
        assert_eq!(
            ready(supervisor::step(
                &store,
                &mut p,
                &provider_admission(&a),
                &mut pending
            )),
            Ok(true)
        );
        assert!(pending.pending().is_none());
        assert!(pending.rejected().is_none());
        let state = store.state.lock().unwrap();
        assert_eq!(state.accepted.len(), 1);
        assert_eq!(state.attempts.len(), 2);
        assert_eq!(state.attempts[0], state.attempts[1]);
        assert_eq!(state.attempts[0].dispatch_fence, a.dispatch_fence);
    }
}

#[test]
fn committed_replay_authenticates_owner_and_rejects_changed_content() {
    use orkestr_v2_application::runtime::{ProviderEventInput, RuntimeStore};
    let a = admission(SessionRole::Worker, 10);
    let envelope = provider_admission(&a);
    let store = Spy::new(a.clone());
    let input = ProviderEventInput {
        run_id: a.run_id.clone(),
        session_id: a.session_id.clone(),
        lease_generation: a.lease_generation,
        dispatch_fence: a.dispatch_fence,
        sequence: 1,
        event: ProviderEvent::Started,
    };
    let receipt = ready(store.append_provider_event(&a.owner_id, &envelope, &input)).unwrap();
    assert!(!receipt.duplicate);
    let mut changed = input.clone();
    changed.event = ProviderEvent::Failed;
    assert_eq!(
        ready(store.append_provider_event(&a.owner_id, &envelope, &changed)),
        Err(RuntimeStoreError::Conflict)
    );
    let wrong_owner = serde_json::from_str("\"00000000-0000-4000-8000-000000000099\"").unwrap();
    assert_eq!(
        ready(store.append_provider_event(&wrong_owner, &envelope, &input)),
        Err(RuntimeStoreError::Unauthorized)
    );
    assert_eq!(store.state.lock().unwrap().accepted.len(), 1);
}

#[test]
fn progress_storage_unavailable_retains_exact_bounded_input() {
    let a = admission(SessionRole::Worker, 10);
    let store = Spy::new(a.clone());
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let mut pending = PendingObservation::default();
    p.start(&a).unwrap();
    ready(supervisor::step(
        &store,
        &mut p,
        &provider_admission(&a),
        &mut pending,
    ))
    .unwrap();
    p.emit(&a, ProviderEvent::Progress("é".repeat(4096)))
        .unwrap();
    for _ in 0..2 {
        assert_eq!(
            ready(supervisor::step(
                &store,
                &mut p,
                &provider_admission(&a),
                &mut pending
            )),
            Err(Error::Store(RuntimeStoreError::Unavailable))
        );
    }
    let state = store.state.lock().unwrap();
    assert_eq!(state.accepted.len(), 1);
    assert_eq!(state.attempts[1], state.attempts[2]);
    assert!(pending.pending().is_some());
}
