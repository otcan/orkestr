//! SYNTHETIC protocol harness only. The mutex oracle has no persistence, clock,
//! namespace authorization or restart implementation. Durable acceptance is pending.
mod support;
use orkestr_runtime::{fake::FakeProvider, ports::Provider};
use orkestr_v2_application::runtime::*;
use support::*;

// Test-only I/O boundary. Production supervisor::start remains fail closed.
async fn consume_before_fake_io<S: RuntimeStore>(
    store: &S,
    reserved: &DispatchClaim,
    expected: &ProviderAdmission,
    io: impl FnOnce(&RunAdmission),
) -> Result<bool> {
    if &reserved.provider != expected
        || expected.binding.provider_kind != ProviderKind::ExplicitFixture
        || expected.run.purpose != AdmissionPurpose::Execution
        || expected.run.role != Role::Deep
    {
        return Err(RuntimeStoreError::InvalidInput);
    }
    match store.consume_provider_dispatch(reserved).await? {
        DispatchConsumption::DispatchNow => {
            io(&reserved.provider.run);
            Ok(true)
        }
        DispatchConsumption::ReconciliationRequired => Ok(false),
    }
}

fn oracle() -> Spy {
    let spy = Spy::new(admission(Role::Deep, 42));
    spy.state.lock().unwrap().dispatch_fixture_enabled = true;
    spy
}
fn candidate(spy: &Spy) -> RunAdmissionResult {
    ready(spy.admit_run(&claim(&spy.a), &spy.a.session_id, 1, "FAKE-request")).unwrap()
}
fn reservation(spy: &Spy) -> DispatchClaim {
    let c = candidate(spy);
    match ready(spy.claim_provider_dispatch(&c, "FAKE-reserve")).unwrap() {
        DispatchClaimResult::Reserved(r) => *r,
        _ => panic!("expected synthetic reservation"),
    }
}

#[test]
fn concurrent_admission_reservation_and_consumption_have_one_oracle_winner() {
    let spy = oracle();
    let candidates = std::thread::scope(|scope| {
        let a = scope.spawn(|| candidate(&spy));
        let b = scope.spawn(|| candidate(&spy));
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(
        candidates
            .iter()
            .filter(|c| c.disposition == AdmissionDisposition::FreshCandidate)
            .count(),
        1
    );
    let fresh = candidates
        .iter()
        .find(|c| c.disposition == AdmissionDisposition::FreshCandidate)
        .unwrap();
    let reservations = std::thread::scope(|scope| {
        let a = scope.spawn(|| ready(spy.claim_provider_dispatch(fresh, "FAKE-reserve")).unwrap());
        let b = scope.spawn(|| ready(spy.claim_provider_dispatch(fresh, "FAKE-reserve")).unwrap());
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(
        reservations
            .iter()
            .filter(|r| matches!(r, DispatchClaimResult::Reserved(_)))
            .count(),
        1
    );
    let r = reservations
        .iter()
        .find_map(|r| match r {
            DispatchClaimResult::Reserved(r) => Some(r.as_ref()),
            _ => None,
        })
        .unwrap();
    let results = std::thread::scope(|scope| {
        let a = scope.spawn(|| ready(spy.consume_provider_dispatch(r)).unwrap());
        let b = scope.spawn(|| ready(spy.consume_provider_dispatch(r)).unwrap());
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(
        results
            .iter()
            .filter(|r| **r == DispatchConsumption::DispatchNow)
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| **r == DispatchConsumption::ReconciliationRequired)
            .count(),
        1
    );
}

#[test]
fn delivery_unknown_precedes_fake_io_and_repeat_never_calls_io() {
    let spy = oracle();
    let r = reservation(&spy);
    let expected = provider_admission(&spy.a);
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    assert!(ready(consume_before_fake_io(&spy, &r, &expected, |run| {
        assert_eq!(
            spy.state.lock().unwrap().calls.last(),
            Some(&"delivery_unknown")
        );
        fake.start(run).unwrap();
    }))
    .unwrap());
    assert!(
        !ready(consume_before_fake_io(&spy, &r, &expected, |_| panic!(
            "redispatch"
        )))
        .unwrap()
    );
    assert_eq!(fake.poll(&spy.a).unwrap(), Some(ProviderEvent::Started));
}

#[test]
fn lost_consume_ack_and_recreated_provider_remain_unknown() {
    let spy = oracle();
    let r = reservation(&spy);
    let expected = provider_admission(&spy.a);
    spy.state.lock().unwrap().lose_consume_ack = true;
    assert_eq!(
        ready(consume_before_fake_io(&spy, &r, &expected, |_| panic!(
            "lost ack must not dispatch"
        ))),
        Err(RuntimeStoreError::Unavailable)
    );
    // Recreate only the provider; this is NOT a database reopen acceptance test.
    let mut recreated = FakeProvider::fixture_only(true).unwrap();
    assert!(!ready(consume_before_fake_io(&spy, &r, &expected, |run| {
        recreated.start(run).unwrap();
    }))
    .unwrap());
    assert_eq!(
        recreated.poll(&spy.a),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
}

#[test]
fn mismatched_role_or_fence_never_calls_fake_io() {
    let spy = oracle();
    let r = reservation(&spy);
    let expected = provider_admission(&spy.a);
    for role_mismatch in [true, false] {
        let mut wrong = r.clone();
        if role_mismatch {
            wrong.provider.run.role = Role::Worker;
        } else {
            wrong.provider.run.dispatch_fence += 1;
        }
        assert_eq!(
            ready(consume_before_fake_io(&spy, &wrong, &expected, |_| panic!(
                "mismatched authority"
            ))),
            Err(RuntimeStoreError::InvalidInput)
        );
        assert_eq!(
            ready(spy.consume_provider_dispatch(&wrong)),
            Err(RuntimeStoreError::StaleLease)
        );
    }
    assert!(!spy.state.lock().unwrap().dispatch_consumed);
}

#[test]
fn unavailable_store_never_calls_fake_io() {
    let spy = oracle();
    let r = reservation(&spy);
    spy.state.lock().unwrap().dispatch_fixture_enabled = false;
    assert_eq!(
        ready(consume_before_fake_io(
            &spy,
            &r,
            &provider_admission(&spy.a),
            |_| panic!("unavailable")
        )),
        Err(RuntimeStoreError::Unavailable)
    );
}
