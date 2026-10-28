//! Bounded retry of Fast's input-eligibility read across transient Store
//! errors. A busy or briefly unavailable Store must not end the window's
//! Fast companion; only a persistent or non-transient error does.
//!
//! Core fences a window's reads (`Fenced`, or `Expired`) from its own work
//! deadline on, while the local window clock can still be a fraction of a
//! millisecond short of it. Such a fence at the deadline is the window
//! closing, not a Fast failure: it gets a short grace in which the local clock
//! catches up and the caller's due check closes Fast normally. A fence that
//! outlives the grace (a real takeover) still ends Fast.
use orkestr_v2_application::runtime::RuntimeStoreError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The only failure text a caller reports when eligibility stays unreadable.
pub(super) const ELIGIBILITY_UNAVAILABLE: &str = "Fast input eligibility unavailable";
const FIRST_DELAY: Duration = Duration::from_millis(100);
const MAX_DELAY: Duration = Duration::from_secs(2);
/// Silence between two errors that separates one run of errors from the next.
const EPISODE_GAP: Duration = Duration::from_secs(10);
/// Total time one run of consecutive transient errors may last.
pub(super) const RETRY_BUDGET: Duration = Duration::from_secs(30);
/// How long a fence may precede the local window deadline before it counts
/// as a real fence. Far above the clock skew between Core and the local
/// clock; far below any window's lifetime.
pub(super) const FENCE_GRACE: Duration = Duration::from_secs(2);
const FENCE_POLL: Duration = Duration::from_millis(50);

/// What the caller does with one eligibility read.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step<T> {
    Read(T),
    /// The window is due (or retiring): no next input, not a failure.
    Closing,
    /// Transient Store error: wait this long, then read again.
    Retry(Duration),
    Failed(&'static str),
}

/// Consecutive transient errors of one reader; reset by any success.
pub(super) struct TransientRetry {
    budget: Duration,
    since: Option<Instant>,
    last: Option<Instant>,
    delay: Duration,
    /// First fence of the current run of fences while the window was not due.
    fenced_since: Option<Instant>,
}

impl TransientRetry {
    pub(super) fn new() -> Self {
        Self::with_budget(RETRY_BUDGET)
    }

    pub(super) fn with_budget(budget: Duration) -> Self {
        Self {
            budget,
            since: None,
            last: None,
            delay: FIRST_DELAY,
            fenced_since: None,
        }
    }

    /// `warned` is shared by the whole window, so a window logs at most one
    /// WARN for its transient eligibility errors.
    pub(super) fn step<T>(
        &mut self,
        read: Result<T, RuntimeStoreError>,
        window_due: bool,
        warned: &AtomicBool,
        now: Instant,
    ) -> Step<T> {
        let error = match read {
            Ok(value) => {
                self.since = None;
                self.delay = FIRST_DELAY;
                self.fenced_since = None;
                return Step::Read(value);
            }
            Err(error) => error,
        };
        if window_due
            && matches!(
                error,
                RuntimeStoreError::Fenced
                    | RuntimeStoreError::Expired
                    | RuntimeStoreError::Busy
                    | RuntimeStoreError::Unavailable
            )
        {
            return Step::Closing;
        }
        // A reader that skipped polls (no slot wanted) for longer than an
        // episode gap starts a fresh run instead of inheriting a stale one.
        if self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) > EPISODE_GAP)
        {
            self.since = None;
            self.delay = FIRST_DELAY;
            self.fenced_since = None;
        }
        self.last = Some(now);
        if matches!(
            error,
            RuntimeStoreError::Fenced | RuntimeStoreError::Expired
        ) {
            // Core's deadline fence ahead of the local clock: read again
            // shortly; the caller's due check then closes Fast.
            let since = *self.fenced_since.get_or_insert(now);
            let elapsed = now.saturating_duration_since(since);
            if elapsed >= FENCE_GRACE {
                eprintln!(
                    "owned window Fast input eligibility {error:?} for {}ms before the window was due; Fast ends for this window",
                    elapsed.as_millis()
                );
                return Step::Failed(ELIGIBILITY_UNAVAILABLE);
            }
            return Step::Retry(FENCE_POLL.min(FENCE_GRACE - elapsed));
        }
        if !matches!(
            error,
            RuntimeStoreError::Busy | RuntimeStoreError::Unavailable
        ) {
            // Static diagnostic: the Store error kind only.
            eprintln!("owned window Fast input eligibility refused: {error:?}");
            return Step::Failed(ELIGIBILITY_UNAVAILABLE);
        }
        let since = *self.since.get_or_insert(now);
        let elapsed = now.saturating_duration_since(since);
        if elapsed >= self.budget {
            eprintln!(
                "owned window Fast input eligibility still {error:?} after {}s; Fast ends for this window",
                elapsed.as_secs()
            );
            return Step::Failed(ELIGIBILITY_UNAVAILABLE);
        }
        if !warned.swap(true, Ordering::AcqRel) {
            // Static diagnostic: the Store error kind only.
            eprintln!("WARN owned window Fast input eligibility {error:?}; retrying with backoff");
        }
        let wait = self.delay.min(self.budget - elapsed);
        self.delay = (self.delay * 2).min(MAX_DELAY);
        Step::Retry(wait)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_twice_then_a_source_reads_it_and_resets() {
        let mut retry = TransientRetry::new();
        let warned = AtomicBool::new(false);
        let start = Instant::now();
        let busy: Result<Option<u8>, _> = Err(RuntimeStoreError::Busy);
        assert_eq!(
            retry.step(busy, false, &warned, start),
            Step::Retry(Duration::from_millis(100))
        );
        assert!(warned.load(Ordering::Acquire));
        let unavailable: Result<Option<u8>, _> = Err(RuntimeStoreError::Unavailable);
        assert_eq!(
            retry.step(
                unavailable,
                false,
                &warned,
                start + Duration::from_millis(100)
            ),
            Step::Retry(Duration::from_millis(200))
        );
        assert_eq!(
            retry.step(Ok(Some(7)), false, &warned, start + Duration::from_secs(1)),
            Step::Read(Some(7))
        );
        // A later error starts a fresh episode with the first delay.
        assert_eq!(
            retry.step(
                Err::<u8, _>(RuntimeStoreError::Busy),
                false,
                &warned,
                start + Duration::from_secs(60)
            ),
            Step::Retry(Duration::from_millis(100))
        );
    }

    #[test]
    fn errors_separated_by_a_long_gap_are_separate_runs() {
        let mut retry = TransientRetry::new();
        let warned = AtomicBool::new(false);
        let start = Instant::now();
        let busy = || Err::<(), _>(RuntimeStoreError::Busy);
        assert!(matches!(
            retry.step(busy(), false, &warned, start),
            Step::Retry(_)
        ));
        assert_eq!(
            retry.step(busy(), false, &warned, start + Duration::from_secs(120)),
            Step::Retry(Duration::from_millis(100))
        );
    }

    #[test]
    fn backoff_doubles_to_two_seconds_and_gives_up_after_the_budget() {
        let mut retry = TransientRetry::new();
        let warned = AtomicBool::new(false);
        let start = Instant::now();
        let mut now = start;
        let mut waits = Vec::new();
        loop {
            match retry.step(Err::<(), _>(RuntimeStoreError::Busy), false, &warned, now) {
                Step::Retry(wait) => {
                    waits.push(wait);
                    now += wait;
                }
                Step::Failed(reason) => {
                    assert_eq!(reason, "Fast input eligibility unavailable");
                    break;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(
            &waits[..5],
            &[100, 200, 400, 800, 1600].map(Duration::from_millis)
        );
        assert!(waits[5..]
            .iter()
            .all(|wait| *wait <= Duration::from_secs(2)));
        assert_eq!(now - start, RETRY_BUDGET);
    }

    #[test]
    fn non_transient_errors_fail_at_once_and_a_due_window_closes() {
        let warned = AtomicBool::new(false);
        let now = Instant::now();
        for error in [
            RuntimeStoreError::Conflict,
            RuntimeStoreError::Unauthorized,
            RuntimeStoreError::InvalidInput,
        ] {
            assert_eq!(
                TransientRetry::new().step(Err::<(), _>(error), false, &warned, now),
                Step::Failed(ELIGIBILITY_UNAVAILABLE)
            );
        }
        assert!(!warned.load(Ordering::Acquire));
        for error in [
            RuntimeStoreError::Fenced,
            RuntimeStoreError::Expired,
            RuntimeStoreError::Busy,
        ] {
            assert_eq!(
                TransientRetry::new().step(Err::<(), _>(error), true, &warned, now),
                Step::Closing
            );
        }
        assert_eq!(
            TransientRetry::new().step(
                Err::<(), _>(RuntimeStoreError::Conflict),
                true,
                &warned,
                now
            ),
            Step::Failed(ELIGIBILITY_UNAVAILABLE)
        );
    }

    #[test]
    fn a_fence_at_cores_deadline_waits_for_the_local_clock() {
        // Core fences the read from its own work deadline on; the local
        // window clock is still a fraction of a millisecond short of it.
        for error in [RuntimeStoreError::Fenced, RuntimeStoreError::Expired] {
            let mut retry = TransientRetry::new();
            let warned = AtomicBool::new(false);
            let start = Instant::now();
            assert_eq!(
                retry.step(Err::<(), _>(error), false, &warned, start),
                Step::Retry(FENCE_POLL)
            );
            // The next read sees the window due locally: Fast closes.
            assert_eq!(
                retry.step(Err::<(), _>(error), true, &warned, start + FENCE_POLL),
                Step::Closing
            );
            // An expected deadline fence is no Store warning.
            assert!(!warned.load(Ordering::Acquire));
        }
    }

    #[test]
    fn a_fence_that_outlives_the_grace_still_ends_fast() {
        let mut retry = TransientRetry::new();
        let warned = AtomicBool::new(false);
        let start = Instant::now();
        let mut now = start;
        loop {
            match retry.step(Err::<(), _>(RuntimeStoreError::Fenced), false, &warned, now) {
                Step::Retry(wait) => {
                    assert!(wait <= FENCE_POLL);
                    now += wait;
                }
                Step::Failed(reason) => {
                    assert_eq!(reason, ELIGIBILITY_UNAVAILABLE);
                    break;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(now - start, FENCE_GRACE);
        // A success resets the grace, so a later fence starts a fresh one.
        assert_eq!(retry.step(Ok(()), false, &warned, now), Step::Read(()));
        assert_eq!(
            retry.step(Err::<(), _>(RuntimeStoreError::Fenced), false, &warned, now),
            Step::Retry(FENCE_POLL)
        );
    }
}
