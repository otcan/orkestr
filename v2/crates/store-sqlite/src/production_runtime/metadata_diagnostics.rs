//! Closed fence stages. No SQL text, identifiers, credentials or raw errors.
use super::*;
use std::{io::Write, time::Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Begin,
    ValidateFreshGrant,
    ValidateResumeGrant,
    Commit,
}

#[derive(Clone, Copy)]
struct Event {
    stage: Stage,
    outcome: &'static str,
    elapsed_us: u128,
}

/// Non-authorizing closed stage observations, emitted only after caller locks are released.
pub struct MetadataFenceDiagnostics {
    events: [Option<Event>; 3],
    role: Role,
}
impl MetadataFenceDiagnostics {
    pub(super) fn new(role: Role) -> Self {
        Self {
            events: [None; 3],
            role,
        }
    }
    pub(super) fn capture<T>(
        &mut self,
        stage: Stage,
        started: Instant,
        result: Result<T>,
    ) -> Result<T> {
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
        self.events[match stage {
            Stage::Begin => 0,
            Stage::ValidateFreshGrant | Stage::ValidateResumeGrant => 1,
            Stage::Commit => 2,
        }] = Some(Event {
            stage,
            outcome,
            elapsed_us: started.elapsed().as_micros(),
        });
        result
    }

    pub fn emit(&self) {
        self.emit_to(&mut std::io::stderr().lock());
    }

    fn emit_to(&self, sink: &mut impl Write) {
        for event in self.events.iter().flatten() {
            let Event {
                stage,
                outcome,
                elapsed_us,
            } = event;
            #[cfg(test)]
            EVENTS.with(|events| events.borrow_mut().push((*stage, *outcome)));
            let _ = writeln!(
                sink,
                "owned_metadata_fence stage={stage:?} role={:?} outcome={outcome} elapsed_us={elapsed_us}", self.role
            );
        }
    }
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
        let (result, diagnostics) = f.handle.with_metadata_fence_diagnostics(&grant, || {
            calls += 1;
            Ok::<_, ()>(())
        });
        assert!(matches!(result, Err(RuntimeStoreError::Unavailable)));
        assert_eq!(calls, 0);
        diagnostics.emit_to(&mut Vec::new());
        let events = EVENTS.with(|events| events.borrow().clone());
        assert_eq!(events, vec![(Stage::Begin, "unavailable")]);
        drop(blocker);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_failing_sink_cannot_hold_database_writer_or_change_result() {
        use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
        struct BlockedSink {
            entered: Option<SyncSender<()>>,
            release: Receiver<()>,
        }
        impl Write for BlockedSink {
            fn write(&mut self, _data: &[u8]) -> std::io::Result<usize> {
                if let Some(entered) = self.entered.take() {
                    entered.send(()).unwrap();
                    self.release.recv().unwrap();
                }
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let f = super::super::tests::setup().await;
        let binding = f
            .handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap()
            .deep;
        let grant = f.handle.authorize_session_metadata(&binding).await.unwrap();
        let (result, diagnostics) = f
            .handle
            .with_metadata_fence_diagnostics(&grant, || Ok::<_, ()>(17));
        assert_eq!(result, Ok(Ok(17)));
        let (entered, waiting) = sync_channel(1);
        let (release, released) = sync_channel(1);
        let writer = std::thread::spawn(move || {
            diagnostics.emit_to(&mut BlockedSink {
                entered: Some(entered),
                release: released,
            })
        });
        waiting
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let lock = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            f.store.pool.begin_with("BEGIN IMMEDIATE"),
        )
        .await;
        release.send(()).unwrap();
        writer.join().unwrap();
        let lock = lock
            .expect("diagnostic output retained write lock")
            .unwrap();
        lock.rollback().await.unwrap();
        assert_eq!(result, Ok(Ok(17)));
    }
}
