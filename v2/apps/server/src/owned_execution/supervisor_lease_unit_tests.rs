use super::*;

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

#[test]
fn only_busy_and_unavailable_are_transient() {
    for error in [RuntimeStoreError::Busy, RuntimeStoreError::Unavailable] {
        assert!(
            transient(&error),
            "{error:?} is a store that cannot answer now"
        );
    }
    for error in [
        RuntimeStoreError::InvalidInput,
        RuntimeStoreError::NotFound,
        RuntimeStoreError::Unauthorized,
        RuntimeStoreError::StaleLease,
        RuntimeStoreError::Fenced,
        RuntimeStoreError::Conflict,
        RuntimeStoreError::Expired,
    ] {
        assert!(
            !transient(&error),
            "{error:?} is lost authority and stays fatal"
        );
    }
}

#[test]
fn an_unproven_lease_never_defers() {
    let lease = SupervisorLease::default();
    let now = Instant::now();
    assert_eq!(lease.remaining(now), None);
    assert!(!lease.within_margin(now));
    assert_eq!(lease.refused(now), None, "no proof of lease: fail closed");
}

#[test]
fn refusals_back_off_on_the_monotonic_bound_and_pause_at_the_margin() {
    let lease = SupervisorLease::default();
    let start = Instant::now();
    lease.granted(start, 1_060_000);
    // 50 s proven: retries grow 0.5 s, 1 s, 2 s, then stay at 4 s.
    let at = start + secs(10);
    let delays: Vec<_> = (0..5).map(|_| lease.refused(at).unwrap()).collect();
    assert_eq!(
        delays,
        [500, 1_000, 2_000, 4_000, 4_000].map(Duration::from_millis)
    );
    assert!(lease.retry_pending(at));
    assert!(!lease.retry_pending(at + secs(4)));
    // The delay never carries the next attempt past the margin.
    let late = start + SUPERVISOR_LEASE - LEASE_MARGIN - Duration::from_millis(1_500);
    assert_eq!(lease.refused(late), Some(Duration::from_millis(1_500)));
    // At the margin or past it: pause.
    assert!(lease.within_margin(start + SUPERVISOR_LEASE - LEASE_MARGIN));
    assert_eq!(lease.refused(start + SUPERVISOR_LEASE - LEASE_MARGIN), None);
    assert_eq!(lease.refused(start + SUPERVISOR_LEASE + secs(1)), None);
}

#[test]
fn margin_exceeds_one_bounded_maintain_and_leaves_room_to_retry() {
    // An auth read, a heartbeat and a lease read, each under its timeout.
    assert!(READ_TIMEOUT + HEARTBEAT_TIMEOUT + READ_TIMEOUT < LEASE_MARGIN);
    // A heartbeat is due every 10 s; the first refusal must still defer.
    assert!(SUPERVISOR_LEASE.saturating_sub(LEASE_MARGIN) > secs(10) + HEARTBEAT_TIMEOUT);
}

#[test]
fn the_latest_proof_wins_and_a_grant_clears_the_deferral() {
    let lease = SupervisorLease::default();
    let start = Instant::now();
    lease.granted(start, 1_060_000);
    assert!(lease.refused(start + secs(10)).is_some());
    assert!(lease.deferred());
    // A validated read proves more lease (another heartbeater renewed it).
    lease.observed(start + secs(12), 55_000);
    assert_eq!(lease.remaining(start + secs(12)), Some(secs(55)));
    // An older or shorter proof never shortens the bound.
    lease.observed(start + secs(12), 10_000);
    lease.observed(start + secs(12), -5);
    assert_eq!(lease.remaining(start + secs(12)), Some(secs(55)));
    lease.granted(start + secs(13), 1_073_000);
    assert!(!lease.deferred());
    assert!(!lease.retry_pending(start + secs(13)));
    // A fresh refusal starts the backoff again from its base.
    assert_eq!(
        lease.refused(start + secs(14)),
        Some(Duration::from_millis(500))
    );
}

#[test]
fn a_renewal_needs_a_granted_supervisor_deadline_past_the_runs() {
    let lease = SupervisorLease::default();
    assert!(!lease.can_extend(1_000_000), "nothing granted yet");
    lease.granted(Instant::now(), 1_060_000);
    assert!(lease.can_extend(1_059_999));
    assert!(
        !lease.can_extend(1_060_000),
        "capped at the supervisor deadline"
    );
    // A slower heartbeat reporting an older deadline never lowers it.
    lease.granted(Instant::now(), 1_050_000);
    assert!(lease.can_extend(1_059_999));
}

#[test]
fn run_renewal_waits_only_while_deferred_with_margin_on_both_leases() {
    let lease = SupervisorLease::default();
    let start = Instant::now();
    let wall = 1_000_000;
    lease.granted(start, wall + 60_000);
    let run = wall + 40_000;
    assert!(
        !lease.hold_run_renewal(run, Some(wall), start),
        "a healthy store renews on schedule"
    );
    assert!(lease.refused(start + secs(1)).is_some());
    assert!(lease.hold_run_renewal(run, Some(wall), start + secs(1)));
    let margin_ms = LEASE_MARGIN.as_millis() as i64;
    assert!(
        !lease.hold_run_renewal(wall + margin_ms, Some(wall), start + secs(1)),
        "a run lease down to the margin is renewed anyway"
    );
    assert!(
        !lease.hold_run_renewal(run, Some(wall), start + SUPERVISOR_LEASE - LEASE_MARGIN),
        "a supervisor bound down to the margin releases it too"
    );
    assert!(
        !lease.hold_run_renewal(run, None, start + secs(1)),
        "an unreadable wall clock never holds"
    );
    lease.granted(start + secs(2), wall + 62_000);
    assert!(!lease.hold_run_renewal(run, Some(wall), start + secs(2)));
}
