//! Bounded retry of Fast's input-eligibility read across transient Store
//! errors. A busy or briefly unavailable Store must not end the window's
//! Fast companion; only a persistent or non-transient error does.
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
        if !matches!(
            error,
            RuntimeStoreError::Busy | RuntimeStoreError::Unavailable
        ) {
            return Step::Failed(ELIGIBILITY_UNAVAILABLE);
        }
        // A reader that skipped polls (no slot wanted) for longer than an
        // episode gap starts a fresh run instead of inheriting a stale one.
        if self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) > EPISODE_GAP)
        {
            self.since = None;
            self.delay = FIRST_DELAY;
        }
        self.last = Some(now);
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
            RuntimeStoreError::Fenced,
            RuntimeStoreError::Expired,
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
}
