//! A supervisor heartbeat Core could not take right now is not lost authority,
//! but the host may never act on a lease it can no longer prove.
//!
//! `heartbeat_supervisor` is a `BEGIN IMMEDIATE` write. While another writer
//! holds SQLite past busy_timeout (5 s), or every pooled connection is busy,
//! it returns Busy or Unavailable (`fn db()` maps every sqlx error to
//! Unavailable). Core's supervisor lease lasts 60 s and a heartbeat is due
//! every 10 s, so one refused write still leaves most of the lease.
//!
//! The window therefore keeps running and retries with backoff, against a
//! monotonic local bound on Core's lease: the Instant taken before an accepted
//! heartbeat plus the 60 s Core grants, or before a validated lease read plus
//! the remaining time Core reported. Each such bound is earlier than Core's
//! real deadline, so the latest one is too. Every store call on this path runs
//! under a timeout, and the window pauses while `LEASE_MARGIN` is still left,
//! which is longer than one bounded `maintain` (auth read, heartbeat, lease
//! read). Lost authority (any non-transient error) still pauses at once.
//!
//! Safety never rests on this bound alone: Core refuses a heartbeat on an
//! expired lease (`Expired`), a takeover fences the old context, and every run
//! lease is capped at the supervisor deadline.
//!
//! A run-lease renewal is a consuming transfer: a refused one quarantines the
//! native child. It goes ahead only when the supervisor deadline Core last
//! granted is past the run's own deadline (otherwise the renewal could not
//! extend it). While the heartbeat is deferred it first tries a heartbeat, and
//! it waits as long as both the run's lease and the supervisor bound keep the
//! margin.
use orkestr_v2_application::runtime::RuntimeStoreError;
use std::{
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

/// What Core grants an accepted heartbeat (`Store::heartbeat_supervisor`).
pub(super) const SUPERVISOR_LEASE: Duration = Duration::from_secs(60);
/// Pause, and stop holding a run-lease renewal, while this much is left. It
/// exceeds one bounded `maintain`: 5 s + 6 s + 5 s of timeouts.
pub(super) const LEASE_MARGIN: Duration = Duration::from_secs(25);
/// A heartbeat blocked on a held write lock answers after busy_timeout (5 s).
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(6);
/// Reads take no write lock; only an exhausted pool delays them.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
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
/// None when the clock cannot be read; callers then fail closed.
pub(super) fn wall_now_ms() -> Option<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
}

fn retry_delay(failures: u32) -> Duration {
    RETRY_BASE
        .saturating_mul(1u32 << failures.saturating_sub(1).min(16))
        .min(RETRY_MAX)
}

/// The outcome of one heartbeat attempt that did not pause the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Renewal {
    Granted,
    Deferred,
}

/// Shared by every execution of one window that heartbeats the same
/// supervisor context (Deep, its Fast companion, parallel Deep slots).
pub(crate) struct SupervisorLease {
    state: Mutex<State>,
    heartbeat_timeout: Duration,
    read_timeout: Duration,
}

impl Default for SupervisorLease {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            heartbeat_timeout: HEARTBEAT_TIMEOUT,
            read_timeout: READ_TIMEOUT,
        }
    }
}

#[derive(Default)]
struct State {
    /// Monotonic lower bound on Core's lease deadline; None until proven.
    expires: Option<Instant>,
    /// Latest supervisor deadline Core granted (Core clock, ms).
    granted_deadline_ms: Option<i64>,
    /// Consecutive transient refusals; zero once a heartbeat is accepted.
    failures: u32,
    retry_at: Option<Instant>,
}

impl SupervisorLease {
    #[cfg(test)]
    pub(super) fn with_timeouts(heartbeat: Duration, read: Duration) -> Self {
        Self {
            heartbeat_timeout: heartbeat,
            read_timeout: read,
            ..Self::default()
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn heartbeat_timeout(&self) -> Duration {
        self.heartbeat_timeout
    }

    pub(super) fn read_timeout(&self) -> Duration {
        self.read_timeout
    }

    fn prove(state: &mut State, expires: Instant) {
        state.expires = Some(state.expires.map_or(expires, |known| known.max(expires)));
    }

    /// Core accepted a heartbeat that started at `started` and granted
    /// `deadline_ms` (Core clock).
    pub(super) fn granted(&self, started: Instant, deadline_ms: i64) {
        let mut state = self.state();
        Self::prove(&mut state, started + SUPERVISOR_LEASE);
        state.granted_deadline_ms = Some(
            state
                .granted_deadline_ms
                .map_or(deadline_ms, |known| known.max(deadline_ms)),
        );
        state.failures = 0;
        state.retry_at = None;
    }

    /// A validated read that started at `started` found `remaining_ms` left.
    pub(super) fn observed(&self, started: Instant, remaining_ms: i64) {
        if let Ok(remaining) = u64::try_from(remaining_ms) {
            Self::prove(
                &mut self.state(),
                started + Duration::from_millis(remaining),
            );
        }
    }

    /// Lease provably left at `now`; None until a heartbeat or read proved one.
    pub(super) fn remaining(&self, now: Instant) -> Option<Duration> {
        self.state()
            .expires
            .map(|expires| expires.saturating_duration_since(now))
    }

    /// The proven lease is down to the margin.
    pub(super) fn within_margin(&self, now: Instant) -> bool {
        self.remaining(now)
            .is_some_and(|remaining| remaining <= LEASE_MARGIN)
    }

    pub(super) fn deferred(&self) -> bool {
        self.state().failures > 0
    }

    /// A deferred heartbeat waits for its backoff before trying again.
    pub(super) fn retry_pending(&self, now: Instant) -> bool {
        self.state().retry_at.is_some_and(|at| now < at)
    }

    /// Record a transient refusal at `now`. `Some(delay)` while the proven
    /// lease keeps the margin: retry after `delay`, which never runs past the
    /// margin. `None`: unproven or about to lapse, so pause.
    pub(super) fn refused(&self, now: Instant) -> Option<Duration> {
        let mut state = self.state();
        state.failures = state.failures.saturating_add(1);
        state.retry_at = None;
        let spare = state
            .expires?
            .saturating_duration_since(now)
            .checked_sub(LEASE_MARGIN)
            .filter(|spare| !spare.is_zero())?;
        let delay = retry_delay(state.failures).min(spare);
        state.retry_at = Some(now + delay);
        Some(delay)
    }

    /// A renewal extends a run lease only to the supervisor deadline, so it
    /// can succeed only once Core granted one past the run's own deadline.
    pub(super) fn can_extend(&self, run_deadline_ms: i64) -> bool {
        self.state()
            .granted_deadline_ms
            .is_some_and(|granted| granted > run_deadline_ms)
    }

    /// Hold a due run-lease renewal while the heartbeat is deferred and both
    /// the run's lease and the proven supervisor lease keep the margin. An
    /// unreadable wall clock never holds.
    pub(super) fn hold_run_renewal(
        &self,
        run_deadline_ms: i64,
        wall_now_ms: Option<i64>,
        now: Instant,
    ) -> bool {
        let state = self.state();
        let margin_ms = i64::try_from(LEASE_MARGIN.as_millis()).unwrap_or(i64::MAX);
        state.failures > 0
            && wall_now_ms.is_some_and(|wall| run_deadline_ms.saturating_sub(wall) > margin_ms)
            && state
                .expires
                .is_some_and(|expires| expires.saturating_duration_since(now) > LEASE_MARGIN)
    }
}

#[cfg(test)]
#[path = "supervisor_lease_unit_tests.rs"]
mod tests;
