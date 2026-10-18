//! Spy ordering and fail-closed dispatch only, not durable acceptance.
mod support;
use orkestr_runtime::{
    ports::*,
    supervisor::{self, Error},
};
use orkestr_v2_application::runtime::{InflightStatus, RuntimeStoreError};
use orkestr_v2_contracts::runtime::Role;
use support::*;
struct SpyProvider<'a> {
    store: &'a Spy,
    starts: usize,
    hung: bool,
}
impl Provider for SpyProvider<'_> {
    fn start(&mut self, _: &RunAdmission) -> Result<(), Blocker> {
        self.starts += 1;
        Ok(())
    }
    fn poll(&mut self, _: &RunAdmission) -> Result<Option<ProviderEvent>, Blocker> {
        Ok(if self.hung {
            None
        } else {
            Some(ProviderEvent::Started)
        })
    }
    fn interrupt(&mut self, control: &InterruptControl) -> Result<(), Blocker> {
        assert_eq!(control.cancellation.dispatch_fence, 2);
        assert_eq!(control.original.dispatch_fence, 1);
        assert_eq!(
            self.store.state.lock().unwrap().calls.last(),
            Some(&"fenced")
        );
        Err(Blocker::Unsupported)
    }
}
#[test]
fn mismatched_authoritative_role_never_starts_provider() {
    let store = Spy::new(admission(Role::Deep, 10));
    let mut p = SpyProvider {
        store: &store,
        starts: 0,
        hung: true,
    };
    for wrong in [Role::Fast, Role::Worker] {
        assert_eq!(
            ready(supervisor::start(
                &store,
                &mut p,
                &claim(&store.a),
                &store.a.session_id,
                1,
                "request",
                wrong
            )),
            Err(Error::Store(RuntimeStoreError::InvalidInput))
        );
    }
    assert_eq!(p.starts, 0);
}
#[test]
fn identical_admission_replay_never_blindly_dispatches() {
    let store = Spy::new(admission(Role::Deep, 10));
    let mut p = SpyProvider {
        store: &store,
        starts: 0,
        hung: true,
    };
    for _ in 0..2 {
        assert_eq!(
            ready(supervisor::start(
                &store,
                &mut p,
                &claim(&store.a),
                &store.a.session_id,
                1,
                "request",
                Role::Deep
            )),
            Err(Error::Provider(Blocker::DispatchUnconfirmed))
        );
    }
    assert_eq!(p.starts, 0);
}
#[test]
fn running_needs_provider_event() {
    let store = Spy::new(admission(Role::Deep, 10));
    let mut p = SpyProvider {
        store: &store,
        starts: 0,
        hung: true,
    };
    let mut pending = supervisor::PendingObservation::default();
    assert!(!ready(supervisor::step(
        &store,
        &mut p,
        &provider_admission(&store.a),
        &mut pending
    ))
    .unwrap());
    assert!(store.state.lock().unwrap().calls.is_empty());
    p.hung = false;
    assert!(ready(supervisor::step(
        &store,
        &mut p,
        &provider_admission(&store.a),
        &mut pending
    ))
    .unwrap());
    assert_eq!(store.state.lock().unwrap().calls, vec!["record"]);
}
#[test]
fn durable_fence_precedes_unsupported_interrupt() {
    let store = Spy::new(admission(Role::Deep, 10));
    let mut p = SpyProvider {
        store: &store,
        starts: 0,
        hung: true,
    };
    let (receipt, result) = ready(supervisor::cancel(
        &store,
        &mut p,
        &owner(),
        &store.a,
        "cancel",
    ))
    .unwrap();
    assert_eq!(result, Err(Blocker::Unsupported));
    assert_eq!(receipt.inflight_status, InflightStatus::Unknown);
    assert_eq!(store.state.lock().unwrap().calls, vec!["fenced"]);
}
#[test]
fn late_provider_event_cannot_bypass_store_fence() {
    let store = Spy::new(admission(Role::Deep, 10));
    store.state.lock().unwrap().refusal = Some(RuntimeStoreError::StaleLease);
    let mut p = SpyProvider {
        store: &store,
        starts: 0,
        hung: false,
    };
    let mut pending = supervisor::PendingObservation::default();
    assert_eq!(
        ready(supervisor::step(
            &store,
            &mut p,
            &provider_admission(&store.a),
            &mut pending
        )),
        Err(Error::Store(RuntimeStoreError::StaleLease))
    );
    assert!(pending.pending().is_none());
}

#[test]
fn worker_admission_is_blocked_before_consuming_any_deep_claim() {
    let store = Spy::new(admission(Role::Worker, 10));
    let mut p = SpyProvider {
        store: &store,
        starts: 0,
        hung: true,
    };
    assert_eq!(
        ready(supervisor::start(
            &store,
            &mut p,
            &claim(&store.a),
            &store.a.session_id,
            1,
            "worker",
            Role::Worker
        )),
        Err(Error::Store(RuntimeStoreError::InvalidInput))
    );
    assert_eq!(p.starts, 0);
    assert!(store.state.lock().unwrap().calls.is_empty());
    // Even a faulty store response cannot manufacture a deep role.
    assert_eq!(
        ready(supervisor::start(
            &store,
            &mut p,
            &claim(&store.a),
            &store.a.session_id,
            1,
            "deep",
            Role::Deep
        )),
        Err(Error::Store(RuntimeStoreError::InvalidInput))
    );
    assert_eq!(p.starts, 0);
}
#[test]
fn deep_binding_must_match_claim_consumer_before_admission() {
    let store = Spy::new(admission(Role::Deep, 10));
    let mut p = SpyProvider {
        store: &store,
        starts: 0,
        hung: true,
    };
    let other = admission(Role::Deep, 11).session_id;
    assert_eq!(
        ready(supervisor::start(
            &store,
            &mut p,
            &claim(&store.a),
            &other,
            1,
            "deep",
            Role::Deep
        )),
        Err(Error::Store(RuntimeStoreError::InvalidInput))
    );
    assert_eq!(p.starts, 0);
    assert!(store.state.lock().unwrap().calls.is_empty());
}
