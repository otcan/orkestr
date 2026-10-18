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
        ObservationKind::CompletedProposal { synthetic: true },
        ObservationKind::Failed,
        ObservationKind::Lost,
    ] {
        let a = admission(SessionRole::Worker, 10);
        let store = Spy::new(a.clone());
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let mut pending = PendingObservation::default();
        p.start(&a).unwrap();
        assert_eq!(
            ready(supervisor::step(&store, &mut p, &a, &mut pending)),
            Ok(true)
        );
        p.emit(&a, terminal.clone()).unwrap();
        store.state.lock().unwrap().fail_once = true;
        assert_eq!(
            ready(supervisor::step(&store, &mut p, &a, &mut pending)),
            Err(Error::Store(RuntimeStoreError::Unavailable))
        );
        assert_eq!(p.poll(&a), Err(Blocker::UnknownSession));
        assert_eq!(
            ready(supervisor::step(&store, &mut p, &a, &mut pending)),
            Ok(true)
        );
        let s = store.state.lock().unwrap();
        assert_eq!(
            s.accepted
                .iter()
                .map(|i| i.kind.clone())
                .collect::<Vec<_>>(),
            vec![ObservationKind::Started, terminal]
        );
        assert_eq!(s.attempts[1], s.attempts[2]);
        assert!(s.attempts[0].source_event_key.ends_with(":1"));
        assert!(s.attempts[1].source_event_key.ends_with(":2"));
        drop(s);
        assert_eq!(
            ready(supervisor::step(&store, &mut p, &a, &mut pending)),
            Err(Error::Provider(Blocker::UnknownSession))
        );
    }
}
#[test]
fn stale_or_expired_discards_delivery_without_repoll_or_readmission() {
    for error in [RuntimeStoreError::StaleLease, RuntimeStoreError::Expired] {
        let a = admission(SessionRole::Worker, 10);
        let store = Spy::new(a.clone());
        store.state.lock().unwrap().refusal = Some(error);
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let mut pending = PendingObservation::default();
        p.start(&a).unwrap();
        p.poll(&a).unwrap();
        p.emit(&a, ObservationKind::Lost).unwrap();
        for _ in 0..2 {
            assert_eq!(
                ready(supervisor::step(&store, &mut p, &a, &mut pending)),
                Err(Error::Store(error))
            );
        }
        assert!(pending.pending().is_none());
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
        ready(supervisor::step(&store, &mut p, &a, &mut pending)),
        Err(Error::Store(RuntimeStoreError::Unavailable))
    );
    let mut newer = a.clone();
    newer.lease_generation += 1;
    assert_eq!(
        ready(supervisor::step(&store, &mut p, &newer, &mut pending)),
        Err(Error::Store(RuntimeStoreError::StaleLease))
    );
    assert_eq!(
        ready(supervisor::step(&store, &mut p, &a, &mut pending)),
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
        assert_eq!(ready(supervisor::step(&store, &mut p, &a, &mut pending)), Err(Error::Store(error)));
        let original = pending.pending().unwrap().clone();
        store.state.lock().unwrap().refusal = None;
        let result = ready(supervisor::step(&store, &mut p, &a, &mut pending));
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
    p.emit(&a, ObservationKind::CompletedProposal { synthetic: true }).unwrap();
    store.state.lock().unwrap().lose_ack_once = true;
    assert_eq!(ready(supervisor::step(&store, &mut p, &a, &mut pending)), Err(Error::Store(RuntimeStoreError::Unavailable)));
    assert_eq!(p.poll(&a), Err(Blocker::UnknownSession));
    assert_eq!(ready(supervisor::step(&store, &mut p, &a, &mut pending)), Ok(true));
    let state = store.state.lock().unwrap();
    assert_eq!(state.attempts[0], state.attempts[1]);
    assert_eq!(state.accepted.len(), 1);
    assert!(pending.pending().is_none());
}
