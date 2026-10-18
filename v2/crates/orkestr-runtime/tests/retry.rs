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
        ProviderEvent::Completed { synthetic: true },
        ProviderEvent::Failed,
        ProviderEvent::Lost,
    ] {
        let a = admission(SessionRole::Worker, 10);
        let store = Spy::new(a.clone());
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let mut pending = PendingObservation::default();
        p.start(&a).unwrap();
        assert_eq!(
            ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)),
            Ok(true)
        );
        p.emit(&a, terminal.clone()).unwrap();
        store.state.lock().unwrap().fail_once = true;
        assert_eq!(
            ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)),
            Err(Error::Store(RuntimeStoreError::Unavailable))
        );
        assert_eq!(p.poll(&a), Err(Blocker::UnknownSession));
        assert_eq!(
            ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)),
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
        assert_eq!(s.attempts[0].provider_sequence, 1);
        assert_eq!(s.attempts[1].provider_sequence, 2);
        drop(s);
        assert_eq!(
            ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)),
            Err(Error::Provider(Blocker::UnknownSession))
        );
    }
}
#[test]
fn stale_or_fenced_refusal_retains_original_for_reconciliation() {
    for error in [RuntimeStoreError::StaleLease, RuntimeStoreError::Fenced] {
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
                ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)),
                Err(Error::Store(error))
            );
        }
        assert_eq!(pending.pending().unwrap().event, ProviderEvent::Lost);
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
        ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)),
        Err(Error::Store(RuntimeStoreError::Unavailable))
    );
    let mut newer = a.clone();
    newer.lease_generation += 1;
    assert_eq!(
        ready(supervisor::step(
            &store,
            &mut p,
            &owner(),
            &newer,
            &mut pending
        )),
        Err(Error::Store(RuntimeStoreError::StaleLease))
    );
    assert_eq!(
        ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)),
        Ok(true)
    );
    assert_eq!(store.state.lock().unwrap().accepted.len(), 1);
}
