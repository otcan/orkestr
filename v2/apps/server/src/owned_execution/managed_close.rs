//! Managed control requests issued when a Deep run ends (`managed_run_close`
//! and the cancellation cleanup's `query_managed`). The manager serves every
//! window's control requests one at a time, so under load one short attempt
//! can time out without anything being wrong (2026-11-20, PA: a 1 s closure
//! paused the window after a successful run).
//!
//! A request that timed out may still be executed by the manager later, so
//! repeating it would only add load to a queue that is already saturated.
//! Each request therefore gets one attempt with the whole budget. Only
//! `Unavailable` (the socket refused or dropped the connection) is retried,
//! after a short backoff, inside the same budget.
use std::{
    future::Future,
    time::{Duration, Instant},
};

/// One budget for the request, its retries included.
pub(super) const CONTROL_BUDGET: Duration = Duration::from_secs(7);
/// Waits before each retry of an `Unavailable` request.
pub(super) const UNAVAILABLE_BACKOFF: [Duration; 3] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];

/// Run `attempt` with the absolute `deadline`. An error that `retryable`
/// accepts is retried after the next `backoff` wait, while that wait still
/// ends before the deadline; anything else is returned as it is.
pub(super) async fn bounded<T, E, F, Fut>(
    deadline: Instant,
    backoff: &[Duration],
    retryable: impl Fn(&E) -> bool,
    mut attempt: F,
) -> Result<T, E>
where
    F: FnMut(Instant) -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let mut waits = backoff.iter();
    loop {
        let result = attempt(deadline).await;
        if !matches!(&result, Err(error) if retryable(error)) {
            return result;
        }
        let Some(wait) = waits.next() else {
            return result;
        };
        if Instant::now() + *wait >= deadline {
            return result;
        }
        eprintln!("owned execution managed control unavailable; retrying in {wait:?}");
        tokio::time::sleep(*wait).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const SHORT: [Duration; 3] = [
        Duration::from_millis(5),
        Duration::from_millis(10),
        Duration::from_millis(20),
    ];

    #[test]
    fn one_seven_second_budget_and_a_short_backoff() {
        assert_eq!(CONTROL_BUDGET, Duration::from_secs(7));
        assert_eq!(
            UNAVAILABLE_BACKOFF,
            [
                Duration::from_millis(500),
                Duration::from_secs(1),
                Duration::from_secs(2)
            ]
        );
    }

    #[tokio::test]
    async fn an_unanswered_request_is_never_repeated() {
        let deadline = Instant::now() + CONTROL_BUDGET;
        let seen = RefCell::new(Vec::new());
        let result: Result<(), &str> = bounded(
            deadline,
            &SHORT,
            |error: &&str| *error == "unavailable",
            |until| {
                seen.borrow_mut().push(until);
                async { Err("deadline") }
            },
        )
        .await;
        assert_eq!(result, Err("deadline"));
        assert_eq!(*seen.borrow(), vec![deadline]);
    }

    #[tokio::test]
    async fn an_unavailable_manager_is_retried_within_the_same_budget() {
        let deadline = Instant::now() + CONTROL_BUDGET;
        let seen = RefCell::new(Vec::new());
        let result = bounded(
            deadline,
            &SHORT,
            |error: &&str| *error == "unavailable",
            |until| {
                seen.borrow_mut().push(until);
                let attempt = seen.borrow().len();
                async move {
                    if attempt < 3 {
                        Err("unavailable")
                    } else {
                        Ok(attempt)
                    }
                }
            },
        )
        .await;
        assert_eq!(result, Ok(3));
        assert_eq!(*seen.borrow(), vec![deadline; 3]);
    }

    #[tokio::test]
    async fn retries_stop_when_the_backoff_is_spent() {
        let mut calls = 0;
        let result: Result<(), &str> = bounded(
            Instant::now() + CONTROL_BUDGET,
            &SHORT,
            |error: &&str| *error == "unavailable",
            |_| {
                calls += 1;
                async { Err("unavailable") }
            },
        )
        .await;
        assert_eq!(result, Err("unavailable"));
        assert_eq!(calls, SHORT.len() + 1);
    }

    #[tokio::test]
    async fn no_retry_waits_past_the_deadline() {
        let mut calls = 0;
        let result: Result<(), &str> = bounded(
            Instant::now() + Duration::from_millis(1),
            &[Duration::from_secs(1)],
            |error: &&str| *error == "unavailable",
            |_| {
                calls += 1;
                async { Err("unavailable") }
            },
        )
        .await;
        assert_eq!(result, Err("unavailable"));
        assert_eq!(calls, 1);
    }
}
