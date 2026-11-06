//! Closed fence stages. No SQL text, identifiers, credentials or raw errors.
use super::*;
use std::{io::Write, time::Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Begin,
    Validate,
    Commit,
}

pub(super) fn report<T>(stage: Stage, started: Instant, result: Result<T>) -> Result<T> {
    // RuntimeStoreError is a closed fieldless enum. Database errors have already
    // been normalized; this deliberately does not claim to identify SQLITE_BUSY.
    let outcome = match &result {
        Ok(_) => "ok",
        Err(RuntimeStoreError::InvalidInput) => "invalid_input",
        Err(RuntimeStoreError::NotFound) => "not_found",
        Err(RuntimeStoreError::Unauthorized) => "unauthorized",
        Err(RuntimeStoreError::Busy) => "busy",
        Err(RuntimeStoreError::StaleLease) => "stale_lease",
        Err(RuntimeStoreError::Fenced) => "fenced",
        Err(RuntimeStoreError::Conflict) => "conflict",
        Err(RuntimeStoreError::Expired) => "expired",
        Err(RuntimeStoreError::Unavailable) => "unavailable",
    };
    #[cfg(test)]
    EVENTS.with(|events| events.borrow_mut().push((stage, outcome)));
    let _ = writeln!(
        std::io::stderr().lock(),
        "owned_metadata_fence stage={stage:?} outcome={outcome} elapsed_us={}",
        started.elapsed().as_micros()
    );
    result
}

#[cfg(test)]
thread_local! {
    static EVENTS: std::cell::RefCell<Vec<(Stage, &'static str)>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn writer_lock_failure_is_begin_unavailable_without_metadata_action() {
        let f = super::super::tests::setup().await;
        let binding = f
            .handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap()
            .deep;
        let grant = f.handle.authorize_session_metadata(&binding).await.unwrap();
        let blocker = f.store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        EVENTS.with(|events| events.borrow_mut().clear());
        let mut calls = 0;
        let result = f.handle.with_metadata_fence(&grant, || {
            calls += 1;
            Ok::<_, ()>(())
        });
        assert!(matches!(result, Err(RuntimeStoreError::Unavailable)));
        assert_eq!(calls, 0);
        let events = EVENTS.with(|events| events.borrow().clone());
        assert_eq!(events, vec![(Stage::Begin, "unavailable")]);
        drop(blocker);
    }
}
