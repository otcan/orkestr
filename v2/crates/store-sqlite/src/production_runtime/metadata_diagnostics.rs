//! Closed fence stages. No SQL text, identifiers, credentials or raw errors.
use super::*;
use std::{io::Write, time::Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    RuntimeMultiThread,
    RuntimeCurrentThread,
    RuntimeBuild,
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    WorkspacePreflight,
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
    events: [Option<Event>; 5],
    role: Role,
}
impl MetadataFenceDiagnostics {
    pub(super) fn new(role: Role) -> Self {
        Self {
            events: [None; 5],
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
            Stage::RuntimeMultiThread | Stage::RuntimeCurrentThread | Stage::RuntimeBuild => 0,
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            Stage::WorkspacePreflight => 1,
            Stage::Begin => 2,
            Stage::ValidateFreshGrant | Stage::ValidateResumeGrant => 3,
            Stage::Commit => 4,
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
        let mut expected = vec![(Stage::RuntimeMultiThread, "ok")];
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        expected.push((Stage::WorkspacePreflight, "ok"));
        expected.push((Stage::Begin, "unavailable"));
        assert_eq!(events, expected);
        drop(blocker);
    }

    #[tokio::test]
    async fn current_thread_refusal_is_observable_before_begin() {
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
            .with_metadata_fence_diagnostics(&grant, || -> std::result::Result<(), ()> {
                panic!("refused runtime invoked metadata action")
            });
        assert!(matches!(result, Err(RuntimeStoreError::Unavailable)));
        let mut output = Vec::new();
        diagnostics.emit_to(&mut output);
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("stage=RuntimeCurrentThread role=Deep outcome=unavailable"));
        assert!(!output.contains("stage=Begin"));
    }

    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_retained_workspace_reports_preflight_without_writer_or_action() {
        let f = super::super::tests::setup().await;
        let binding = f
            .handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap()
            .deep;
        let grant = f.handle.authorize_session_metadata(&binding).await.unwrap();
        sqlx::query("INSERT INTO workspace_projects(id,owner_id,conversation_id,generation,active,identity_json) VALUES (?,?,?,1,1,'{}')")
            .bind("synthetic-unretained-project").bind(f.owner.to_string()).bind(f.conversation.to_string())
            .execute(&f.store.pool).await.unwrap();
        let (result, diagnostics) = f
            .handle
            .with_metadata_fence_diagnostics(&grant, || -> std::result::Result<(), ()> {
                panic!("missing custody invoked metadata action")
            });
        assert!(matches!(result, Err(RuntimeStoreError::Fenced)));
        let mut output = Vec::new();
        diagnostics.emit_to(&mut output);
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("stage=WorkspacePreflight role=Deep outcome=fenced"));
        assert!(!output.contains("stage=Begin"));
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
