//! Keep observing the owned child while a read-only authority check is pending.
use orkestr_v2_application::runtime::RuntimeStoreError;
use std::{future::Future, time::Duration};
use tokio::task::{JoinError, JoinHandle};

pub(super) enum Observation<T> {
    Completed(Result<T, JoinError>),
    Authority(Result<(), RuntimeStoreError>),
}

pub(super) async fn observe<T>(
    work: &mut JoinHandle<T>,
    check: impl Future<Output = Result<(), RuntimeStoreError>>,
) -> Observation<T> {
    tokio::select! {
        // Completion includes the owned child's physical wait. Result
        // preparation and every native write still check fresh authority;
        // an unfinished monitor cannot authorize the completed output.
        biased;
        result = work => Observation::Completed(result),
        checked = tokio::time::timeout(Duration::from_millis(50), check) => {
            Observation::Authority(checked.unwrap_or(Err(RuntimeStoreError::Unavailable)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{pending, poll_fn},
        task::Poll,
    };
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn completed_child_is_observed_without_waiting_for_a_stalled_monitor() {
        let (finish, finished) = oneshot::channel();
        let (reaped, observed_reap) = oneshot::channel();
        let mut work = tokio::spawn(async move {
            finished.await.unwrap();
            reaped.send(()).unwrap();
            42
        });
        let (checking, check_started) = oneshot::channel();
        let check = async move {
            checking.send(()).unwrap();
            pending::<Result<(), RuntimeStoreError>>().await
        };
        let observation = observe(&mut work, check);
        tokio::pin!(observation);
        tokio::select! {
            _ = &mut observation => panic!("neither child nor authority check completed"),
            _ = check_started => {}
        }
        finish.send(()).unwrap();
        observed_reap.await.unwrap();
        // The child has returned without another await. Poll exactly once;
        // scheduler speed and a wall-clock sleep cannot make this test pass.
        let polled = poll_fn(|cx| Poll::Ready(observation.as_mut().poll(cx))).await;
        assert!(matches!(
            polled,
            Poll::Ready(Observation::Completed(Ok(42)))
        ));
    }

    #[tokio::test]
    async fn authority_refusal_is_retained_while_the_child_is_running() {
        let mut work = tokio::spawn(pending::<()>());
        let observation = observe(&mut work, async { Err(RuntimeStoreError::Fenced) }).await;
        assert!(matches!(
            observation,
            Observation::Authority(Err(RuntimeStoreError::Fenced))
        ));
        work.abort();
        assert!(work.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn a_stalled_check_still_refuses_a_running_child_at_the_same_deadline() {
        let mut work = tokio::spawn(pending::<()>());
        let observation = observe(&mut work, pending()).await;
        assert!(matches!(
            observation,
            Observation::Authority(Err(RuntimeStoreError::Unavailable))
        ));
        assert!(!work.is_finished());
        work.abort();
        assert!(work.await.unwrap_err().is_cancelled());
    }
}
