//! A supervisor heartbeat Core could not take right now is not lost authority.
//!
//! `heartbeat_supervisor` is a `BEGIN IMMEDIATE` write. While another writer
//! holds SQLite past busy_timeout (5 s), or every pooled connection is busy,
//! it returns Busy or Unavailable (`fn db()` maps every sqlx error to
//! Unavailable). Core's supervisor lease lasts 60 s and a heartbeat is due
//! every 10 s, so one refused write still leaves most of the lease.
//!
//! The window therefore keeps running and retries with backoff while Core's
//! own deadline keeps a margin. It pauses only on lost authority (any other
//! error) or when the lease would really lapse. Safety never depends on this
//! estimate: Core refuses a heartbeat on an expired lease (`Expired`), a
//! takeover fences the old context, and every run lease is capped at the
//! supervisor deadline.
//!
//! A run-lease renewal is a consuming transfer: a refused one quarantines the
//! native child. While the heartbeat is deferred, the store is known to be
//! refusing writes, so the renewal waits as long as the run's own lease keeps
//! the same margin.
use orkestr_v2_application::runtime::RuntimeStoreError;
use std::{
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

/// Stop deferring while this much lease is left. One more attempt can block
/// for busy_timeout (5 s) before it answers.
pub(super) const LEASE_MARGIN_MS: i64 = 10_000;
const RETRY_BASE: Duration = Duration::from_millis(500);
const RETRY_MAX: Duration = Duration::from_secs(4);

/// Busy and Unavailable mean "the store could not answer now". Every other
/// variant is an authority decision and stays fatal.
pub(super) fn transient(error: &RuntimeStoreError) -> bool {
    matches!(
        error,
        RuntimeStoreError::Busy | RuntimeStoreError::Unavailable
    )
}

/// Core's clock is SQLite's `julianday('now')` on this host: the wall clock.
pub(super) fn wall_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn retry_delay(failures: u32) -> Duration {
    RETRY_BASE
        .saturating_mul(1u32 << failures.saturating_sub(1).min(16))
        .min(RETRY_MAX)
}

/// Shared by every execution of one window that heartbeats the same
/// supervisor context (Deep, its Fast companion, parallel Deep slots).
#[derive(Default)]
pub(crate) struct SupervisorLease {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Latest deadline Core granted to a heartbeat of this context.
    granted_deadline_ms: Option<i64>,
    /// Consecutive transient refusals; zero once a heartbeat is accepted.
    failures: u32,
    retry_at: Option<Instant>,
}

impl SupervisorLease {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Core accepted a heartbeat and granted `deadline_ms`.
    pub(super) fn granted(&self, deadline_ms: i64) {
        let mut state = self.state();
        state.granted_deadline_ms = Some(
            state
                .granted_deadline_ms
                .map_or(deadline_ms, |known| known.max(deadline_ms)),
        );
        state.failures = 0;
        state.retry_at = None;
    }

    /// A deferred heartbeat waits for its backoff before trying again.
    pub(super) fn retry_pending(&self, now: Instant) -> bool {
        self.state().retry_at.is_some_and(|at| now < at)
    }

    /// The last deadline Core granted, measured against the wall clock. Used
    /// only when Core cannot even answer the read-only lease check.
    pub(super) fn granted_remaining_ms(&self, wall_now_ms: i64) -> Option<i64> {
        self.state()
            .granted_deadline_ms
            .map(|deadline| deadline.saturating_sub(wall_now_ms))
    }

    /// Record a transient refusal. `Some(delay)` while `remaining_ms` (Core's
    /// lease left) keeps the margin: retry after `delay`, which never runs
    /// past the margin. `None`: unknown or about to lapse, so pause.
    pub(super) fn refused(&self, remaining_ms: Option<i64>, now: Instant) -> Option<Duration> {
        let mut state = self.state();
        state.failures = state.failures.saturating_add(1);
        state.retry_at = None;
        let spare = remaining_ms?.saturating_sub(LEASE_MARGIN_MS);
        if spare <= 0 {
            return None;
        }
        let delay = retry_delay(state.failures)
            .min(Duration::from_millis(u64::try_from(spare).unwrap_or(0)));
        state.retry_at = Some(now + delay);
        Some(delay)
    }

    /// Hold a due run-lease renewal while the heartbeat is deferred and the
    /// run's own lease still keeps the margin.
    pub(super) fn hold_run_renewal(&self, run_deadline_ms: i64, wall_now_ms: i64) -> bool {
        self.state().failures > 0 && run_deadline_ms.saturating_sub(wall_now_ms) > LEASE_MARGIN_MS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn refusals_back_off_within_the_lease_and_pause_before_it_lapses() {
        let lease = SupervisorLease::default();
        let now = Instant::now();
        // 50 s left: retries grow 0.5 s, 1 s, 2 s, then stay at 4 s.
        let delays: Vec<_> = (0..5)
            .map(|_| lease.refused(Some(50_000), now).unwrap())
            .collect();
        assert_eq!(
            delays,
            [500, 1_000, 2_000, 4_000, 4_000].map(Duration::from_millis)
        );
        assert!(lease.retry_pending(now));
        assert!(!lease.retry_pending(now + Duration::from_secs(4)));
        // The delay never carries the next attempt past the margin.
        assert_eq!(
            lease.refused(Some(LEASE_MARGIN_MS + 1_500), now),
            Some(Duration::from_millis(1_500))
        );
        // At the margin, past it, or unknown: pause.
        assert_eq!(lease.refused(Some(LEASE_MARGIN_MS), now), None);
        assert_eq!(lease.refused(Some(-1), now), None);
        assert_eq!(lease.refused(None, now), None);
    }

    #[test]
    fn an_accepted_heartbeat_clears_the_deferral() {
        let lease = SupervisorLease::default();
        let now = Instant::now();
        assert!(lease.refused(Some(40_000), now).is_some());
        assert!(lease.retry_pending(now));
        lease.granted(1_000_000);
        assert!(!lease.retry_pending(now));
        // A fresh refusal starts the backoff again from its base.
        assert_eq!(
            lease.refused(Some(40_000), now),
            Some(Duration::from_millis(500))
        );
        // The latest grant wins even if a slower heartbeat reports an older one.
        lease.granted(900_000);
        assert_eq!(lease.granted_remaining_ms(940_000), Some(60_000));
        assert_eq!(SupervisorLease::default().granted_remaining_ms(0), None);
    }

    #[test]
    fn run_renewal_waits_only_while_deferred_and_with_margin() {
        let lease = SupervisorLease::default();
        let now_ms = 1_000_000;
        assert!(
            !lease.hold_run_renewal(now_ms + 40_000, now_ms),
            "a healthy store renews on schedule"
        );
        assert!(lease.refused(Some(40_000), Instant::now()).is_some());
        assert!(lease.hold_run_renewal(now_ms + 40_000, now_ms));
        assert!(
            !lease.hold_run_renewal(now_ms + LEASE_MARGIN_MS, now_ms),
            "a run lease about to lapse is renewed anyway"
        );
        lease.granted(now_ms + 60_000);
        assert!(!lease.hold_run_renewal(now_ms + 40_000, now_ms));
    }
}
