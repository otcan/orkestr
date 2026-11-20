//! Closing a managed run is idempotent at the manager (`managed_run_close`
//! marks the run closed and cancels its pending claims; repeating it changes
//! nothing). The manager serves every window's control requests one at a
//! time, so under load a single short attempt can time out without anything
//! being wrong. A closure that did not answer is retried with growing
//! deadlines before the window is paused as uncertain.
use std::{future::Future, time::Duration};

/// Per-attempt deadlines: 1 s as before, then 2 s and 4 s (7 s in total).
pub(super) const CLOSE_ATTEMPTS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

/// Run `attempt` with each deadline in turn until it succeeds. An error that
/// is not `unanswered` (a refusal or a protocol fault) ends it at once; the
/// last error is returned when every attempt failed. Only for idempotent
/// operations.
pub(super) async fn retry_idempotent<E, F, Fut>(
    deadlines: &[Duration],
    unanswered: impl Fn(&E) -> bool,
    mut attempt: F,
) -> Result<(), E>
where
    F: FnMut(Duration) -> Fut,
    Fut: Future<Output = Result<(), E>>,
{
    let mut result = Ok(());
    for (index, deadline) in deadlines.iter().enumerate() {
        result = attempt(*deadline).await;
        if !matches!(&result, Err(error) if unanswered(error)) {
            return result;
        }
        if index + 1 < deadlines.len() {
            eprintln!(
                "owned execution managed run closure deferred: attempt {} of {} unanswered",
                index + 1,
                deadlines.len()
            );
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[tokio::test]
    async fn a_closure_that_answers_late_is_retried_with_longer_deadlines() {
        let seen = RefCell::new(Vec::new());
        let result = retry_idempotent(
            &CLOSE_ATTEMPTS,
            |_: &&str| true,
            |deadline| {
                seen.borrow_mut().push(deadline);
                let attempt = seen.borrow().len();
                async move {
                    if attempt < 3 {
                        Err("unanswered")
                    } else {
                        Ok(())
                    }
                }
            },
        )
        .await;
        assert_eq!(result, Ok(()));
        assert_eq!(*seen.borrow(), CLOSE_ATTEMPTS.to_vec());
    }

    #[tokio::test]
    async fn the_first_answer_ends_the_retries() {
        let mut calls = 0;
        let result: Result<(), &str> = retry_idempotent(
            &CLOSE_ATTEMPTS,
            |_: &&str| true,
            |_| {
                calls += 1;
                async { Ok(()) }
            },
        )
        .await;
        assert_eq!(result, Ok(()));
        assert_eq!(calls, 1);
    }

    #[tokio::test]
    async fn every_attempt_failing_still_reports_the_error() {
        let mut calls = 0;
        let result = retry_idempotent(
            &CLOSE_ATTEMPTS,
            |_: &&str| true,
            |_| {
                calls += 1;
                async { Err::<(), _>("unanswered") }
            },
        )
        .await;
        assert_eq!(result, Err("unanswered"));
        assert_eq!(calls, CLOSE_ATTEMPTS.len());
    }

    #[tokio::test]
    async fn a_refusal_is_not_retried() {
        let mut calls = 0;
        let result = retry_idempotent(
            &CLOSE_ATTEMPTS,
            |error: &&str| *error == "unanswered",
            |_| {
                calls += 1;
                async { Err::<(), _>("refused") }
            },
        )
        .await;
        assert_eq!(result, Err("refused"));
        assert_eq!(calls, 1);
    }
}
