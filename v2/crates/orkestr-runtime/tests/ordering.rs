//! Port ordering only, not durable acceptance.
mod support;
use orkestr_runtime::{
    ports::*,
    supervisor::{self, Error},
};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::runtime::SessionRole;
use support::*;
struct SpyProvider<'a> {
    store: &'a Spy,
    hung: bool,
}
impl Provider for SpyProvider<'_> {
    fn start(&mut self, _: &ProviderAdmission) -> Result<(), Blocker> {
        assert_eq!(self.store.state.lock().unwrap().calls, vec!["admitted"]);
        Ok(())
    }
    fn poll(&mut self, _: &ProviderAdmission) -> Result<Option<ProviderEvent>, Blocker> {
        Ok(if self.hung {
            None
        } else {
            Some(ProviderEvent::Started)
        })
    }
    fn interrupt(&mut self, control: &InterruptControl) -> Result<(), Blocker> {
        assert_eq!(control.fence_generation, 2);
        assert_eq!(control.original.fence_generation, 1);
        assert_eq!(
            self.store.state.lock().unwrap().calls.last(),
            Some(&"fenced")
        );
        Err(Blocker::Unsupported)
    }
}
#[test]
fn admission_precedes_start_and_running_needs_provider_event() {
    let store = Spy::new(admission(SessionRole::Deep, 10));
    let mut p = SpyProvider {
        store: &store,
        hung: true,
    };
    let mut pending = supervisor::PendingObservation::default();
    let a = ready(supervisor::start(
        &store,
        &mut p,
        &owner(),
        &input(&store.a),
        SessionRole::Deep,
    ))
    .unwrap();
    assert!(!ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)).unwrap());
    assert_eq!(store.state.lock().unwrap().calls, vec!["admitted"]);
    p.hung = false;
    assert!(ready(supervisor::step(&store, &mut p, &owner(), &a, &mut pending)).unwrap());
    assert_eq!(
        store.state.lock().unwrap().calls,
        vec!["admitted", "record"]
    );
}
#[test]
fn durable_fence_precedes_unsupported_interrupt() {
    let store = Spy::new(admission(SessionRole::Deep, 10));
    let mut p = SpyProvider {
        store: &store,
        hung: true,
    };
    let (receipt, interrupted) =
        ready(supervisor::cancel(&store, &mut p, &owner(), &store.a, 1)).unwrap();
    assert_eq!(interrupted, Err(Blocker::Unsupported));
    assert!(receipt.in_flight_effects_unknown);
    assert_eq!(store.state.lock().unwrap().calls, vec!["fenced"]);
}
#[test]
fn late_provider_event_cannot_bypass_store_fence() {
    let store = Spy::new(admission(SessionRole::Deep, 10));
    store.state.lock().unwrap().refusal = Some(RuntimeStoreError::Fenced);
    let mut p = SpyProvider {
        store: &store,
        hung: false,
    };
    let mut pending = supervisor::PendingObservation::default();
    assert_eq!(
        ready(supervisor::step(
            &store,
            &mut p,
            &owner(),
            &store.a,
            &mut pending
        )),
        Err(Error::Store(RuntimeStoreError::Fenced))
    );
    assert!(pending.pending().is_some());
}
