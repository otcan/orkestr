//! Volatile retry tests only; no database/process-restart acceptance is implied.
use orkestr_runtime::{
    fake::FakeProvider,
    ports::*,
    supervisor::{self, PendingObservation},
};
use std::cell::{Cell, RefCell};

fn admission() -> Admission {
    Admission {
        run_id: "retry-run".into(),
        session_id: "retry-session".into(),
        native_session_id: "FAKE-retry".into(),
        generation: 1,
        role: Role::Worker,
    }
}
struct RecordStore {
    next_error: Cell<bool>,
    stale: bool,
    accepted: RefCell<Vec<ProviderEvent>>,
}
impl SessionStore for RecordStore {
    fn admit(&self, _: &str, _: Role, _: &str) -> Result<Admission, Blocker> {
        unreachable!()
    }
    fn record(&self, _: &Admission, event: ProviderEvent) -> Result<(), Blocker> {
        if self.stale {
            return Err(Blocker::StaleLease);
        }
        // A non-stale store error. Shared core port supplies Unavailable on handoff.
        if self.next_error.replace(false) {
            return Err(Blocker::Protocol);
        }
        self.accepted.borrow_mut().push(event);
        Ok(())
    }
    fn request_cancel(&self, _: &str) -> Result<Admission, Blocker> {
        unreachable!()
    }
    fn recover(&self) -> Result<Vec<Admission>, Blocker> {
        unreachable!()
    }
}

#[test]
fn fail_once_record_retries_same_terminal_after_provider_has_removed_turn() {
    for terminal in [
        ProviderEvent::Completed { synthetic: true },
        ProviderEvent::Failed,
        ProviderEvent::Lost,
    ] {
        let a = admission();
        let store = RecordStore {
            next_error: Cell::new(false),
            stale: false,
            accepted: RefCell::new(vec![]),
        };
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let mut pending = PendingObservation::default();
        p.start(&a).unwrap();
        assert_eq!(supervisor::step(&store, &mut p, &a, &mut pending), Ok(true));
        p.emit(&a, terminal.clone()).unwrap();
        store.next_error.set(true);
        assert_eq!(
            supervisor::step(&store, &mut p, &a, &mut pending),
            Err(Blocker::Protocol)
        );
        assert_eq!(p.poll(&a), Err(Blocker::UnknownSession));
        assert_eq!(supervisor::step(&store, &mut p, &a, &mut pending), Ok(true));
        assert_eq!(
            *store.accepted.borrow(),
            vec![ProviderEvent::Started, terminal]
        );
        // A further step cannot produce another successful record from the retry.
        assert_eq!(
            supervisor::step(&store, &mut p, &a, &mut pending),
            Err(Blocker::UnknownSession)
        );
    }
}

#[test]
fn store_stale_refusal_explicitly_discards_pending_event() {
    let a = admission();
    let store = RecordStore {
        next_error: Cell::new(false),
        stale: true,
        accepted: RefCell::new(vec![]),
    };
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let mut pending = PendingObservation::default();
    p.start(&a).unwrap();
    p.poll(&a).unwrap();
    p.emit(&a, ProviderEvent::Lost).unwrap();
    assert_eq!(
        supervisor::step(&store, &mut p, &a, &mut pending),
        Err(Blocker::StaleLease)
    );
    assert_eq!(
        supervisor::step(&store, &mut p, &a, &mut pending),
        Err(Blocker::UnknownSession)
    );
    assert!(store.accepted.borrow().is_empty());
}

#[test]
fn retry_does_not_relabel_old_observation_with_new_admission() {
    let a = admission();
    let store = RecordStore {
        next_error: Cell::new(true),
        stale: false,
        accepted: RefCell::new(vec![]),
    };
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let mut pending = PendingObservation::default();
    p.start(&a).unwrap();
    assert_eq!(
        supervisor::step(&store, &mut p, &a, &mut pending),
        Err(Blocker::Protocol)
    );
    let mut newer = a.clone();
    newer.generation += 1;
    assert_eq!(
        supervisor::step(&store, &mut p, &newer, &mut pending),
        Err(Blocker::StaleLease)
    );
    assert_eq!(supervisor::step(&store, &mut p, &a, &mut pending), Ok(true));
    assert_eq!(*store.accepted.borrow(), vec![ProviderEvent::Started]);
}
