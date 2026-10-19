//! Port-order tests only. This spy is not a store implementation or durability test.
use orkestr_runtime::{ports::*, supervisor};
use std::cell::RefCell;
struct SpyStore {
    calls: RefCell<Vec<&'static str>>,
    stale: bool,
}
fn a() -> Admission {
    Admission {
        run_id: "run".into(),
        session_id: "session".into(),
        native_session_id: "native".into(),
        generation: 1,
        role: Role::Deep,
    }
}
impl SessionStore for SpyStore {
    fn admit(&self, _: &str, _: Role, _: &str) -> Result<Admission, Blocker> {
        self.calls.borrow_mut().push("admitted");
        Ok(a())
    }
    fn record(&self, _: &Admission, _: ProviderEvent) -> Result<(), Blocker> {
        self.calls.borrow_mut().push("record");
        if self.stale {
            Err(Blocker::StaleLease)
        } else {
            Ok(())
        }
    }
    fn request_cancel(&self, _: &str) -> Result<Admission, Blocker> {
        self.calls.borrow_mut().push("fenced");
        let mut admission = a();
        admission.generation += 1;
        Ok(admission)
    }
    fn recover(&self) -> Result<Vec<Admission>, Blocker> {
        Err(Blocker::Unsupported)
    }
}
struct SpyProvider<'a> {
    store: &'a SpyStore,
    hung: bool,
}
impl Provider for SpyProvider<'_> {
    fn start(&mut self, _: &Admission) -> Result<(), Blocker> {
        assert_eq!(*self.store.calls.borrow(), vec!["admitted"]);
        Ok(())
    }
    fn poll(&mut self, _: &Admission) -> Result<Option<ProviderEvent>, Blocker> {
        Ok(if self.hung {
            None
        } else {
            Some(ProviderEvent::Started)
        })
    }
    fn interrupt(&mut self, admission: &Admission) -> Result<(), Blocker> {
        assert_eq!(admission.generation, 2);
        assert_eq!(self.store.calls.borrow().last(), Some(&"fenced"));
        Err(Blocker::Unsupported)
    }
}
#[test]
fn admission_precedes_start_and_running_needs_provider_event() {
    let store = SpyStore {
        calls: RefCell::new(vec![]),
        stale: false,
    };
    let mut p = SpyProvider {
        store: &store,
        hung: true,
    };
    let mut pending = supervisor::PendingObservation::default();
    let admission = supervisor::start(&store, &mut p, "scope", Role::Deep, "run").unwrap();
    assert!(!supervisor::step(&store, &mut p, &admission, &mut pending).unwrap());
    assert_eq!(*store.calls.borrow(), vec!["admitted"]);
    p.hung = false;
    assert!(supervisor::step(&store, &mut p, &admission, &mut pending).unwrap());
    assert_eq!(*store.calls.borrow(), vec!["admitted", "record"]);
}
#[test]
fn durable_fence_precedes_unsupported_interrupt() {
    let store = SpyStore {
        calls: RefCell::new(vec![]),
        stale: false,
    };
    let mut p = SpyProvider {
        store: &store,
        hung: true,
    };
    assert_eq!(cancel(&store, &mut p, "run"), Err(Blocker::Unsupported));
    assert_eq!(*store.calls.borrow(), vec!["fenced"]);
}
#[test]
fn late_provider_event_cannot_bypass_store_fence() {
    let store = SpyStore {
        calls: RefCell::new(vec![]),
        stale: true,
    };
    let mut p = SpyProvider {
        store: &store,
        hung: false,
    };
    let mut pending = supervisor::PendingObservation::default();
    assert_eq!(
        supervisor::step(&store, &mut p, &a(), &mut pending),
        Err(Blocker::StaleLease)
    );
}
