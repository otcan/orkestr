//! Spacing of the Deep loop's `managed_pending` checks.
//!
//! The Deep loop steps its provider pump about every 10 ms. Each
//! `managed_pending` check is a round trip to the Root manager, which answers
//! the control requests of every window one at a time. One check per loop step
//! from about eight Deep windows saturated it on 2026-11-10 (ORK-781): checks
//! missed their 5 s deadline and every one of those runs was cancelled.
//!
//! A managed tool call waits in Root's queue until the next check. While no
//! call arrives, the checks back off: the first is immediate, then 250 ms,
//! 500 ms and from then on 1 s apart. A call that finds an idle window
//! therefore waits at most 1 s longer than before. After a call is found, the
//! next check runs as soon as that call is handled, so a burst of calls is not
//! slowed. Ten idle seconds cost at most 13 checks instead of about a thousand.
use std::time::{Duration, Instant};

/// First idle spacing, also used again after every found request.
pub(super) const PENDING_MIN: Duration = Duration::from_millis(250);
/// Longest idle spacing: the most a call arriving at an idle window waits.
pub(super) const PENDING_MAX: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub(super) struct PendingPace {
    due: Instant,
    idle: Duration,
}

impl PendingPace {
    /// The first check is due at once.
    pub(super) fn new(now: Instant) -> Self {
        Self {
            due: now,
            idle: PENDING_MIN,
        }
    }

    pub(super) fn due(&self, now: Instant) -> bool {
        now >= self.due
    }

    /// The check found nothing: space the next one further, up to the cap.
    pub(super) fn idle(&mut self, now: Instant) {
        self.due = now.checked_add(self.idle).unwrap_or(now);
        self.idle = self.idle.saturating_mul(2).min(PENDING_MAX);
    }

    /// The check found a request: check again as soon as it is handled.
    pub(super) fn found(&mut self, now: Instant) {
        self.due = now;
        self.idle = PENDING_MIN;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOOP_STEP: Duration = Duration::from_millis(10);

    /// Checks a pace makes over `span` of idle Deep loop steps.
    fn idle_checks(span: Duration) -> Vec<Duration> {
        let start = Instant::now();
        let mut pace = PendingPace::new(start);
        let mut checks = Vec::new();
        let mut now = start;
        while now < start + span {
            if pace.due(now) {
                checks.push(now - start);
                pace.idle(now);
            }
            now += LOOP_STEP;
        }
        checks
    }

    #[test]
    fn idle_checks_back_off_from_250_ms_to_1_s() {
        let checks = idle_checks(Duration::from_millis(4_800));
        let ms: Vec<u128> = checks.iter().map(Duration::as_millis).collect();
        assert_eq!(ms, [0, 250, 750, 1_750, 2_750, 3_750, 4_750]);
    }

    #[test]
    fn ten_idle_seconds_cost_a_dozen_checks_instead_of_a_thousand() {
        // Before ORK-781 every 10 ms loop step was a check: 1000 in 10 s per
        // Deep window, all served one at a time by the shared Root manager.
        let checks = idle_checks(Duration::from_secs(10));
        assert!(checks.len() <= 13, "{} checks in 10 s", checks.len());
        // Eight Deep windows together: about one manager request per second each.
        assert!(8 * checks.len() <= 104);
    }

    #[test]
    fn a_call_arriving_at_an_idle_window_waits_at_most_one_second() {
        let start = Instant::now();
        let mut pace = PendingPace::new(start);
        let mut now = start;
        let mut last_check = start;
        // Thirty idle seconds: no gap between checks exceeds the cap (plus one
        // loop step of granularity).
        while now < start + Duration::from_secs(30) {
            if pace.due(now) {
                assert!(now - last_check <= PENDING_MAX + LOOP_STEP);
                last_check = now;
                pace.idle(now);
            }
            now += LOOP_STEP;
        }
    }

    #[test]
    fn a_found_request_rechecks_at_once_and_restarts_the_backoff() {
        let start = Instant::now();
        let mut pace = PendingPace::new(start);
        for step in 0..5 {
            let now = start + Duration::from_secs(step * 2);
            assert!(pace.due(now));
            pace.idle(now);
        }
        let found = start + Duration::from_secs(10);
        assert!(pace.due(found));
        pace.found(found);
        // The handled call's successor is picked up on the very next step.
        assert!(pace.due(found));
        pace.idle(found);
        assert!(!pace.due(found + PENDING_MIN - LOOP_STEP));
        assert!(pace.due(found + PENDING_MIN));
    }
}
