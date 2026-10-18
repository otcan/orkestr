//! Trusted server callsite for one explicitly delegated offline Python operation.
//! No HTTP route or provider text parser issues authority through this module.
use orkestr_runtime::worker_sandbox::{
    WorkerCancellation, WorkerLimits, WorkerOutput, WorkerSandbox, WorkerSandboxError,
};
use orkestr_v2_application::runtime::{ProviderAdmission, RuntimeStoreError};
use orkestr_v2_store_sqlite::{
    ConsumedOfflinePython, OfflinePythonConsumption, OfflinePythonDelegation, OfflinePythonOutcome,
    OfflinePythonOutput, OfflinePythonReceipt, OfflinePythonResultPreparation,
    OfflinePythonResultReservation, Store,
};
use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Semaphore};
use uuid::Uuid;
mod output;

const CONCURRENT: usize = 4;
const TOTAL: usize = 12;
const QUEUE_DEADLINE: Duration = Duration::from_millis(200);
static GATES: OnceLock<(Arc<Semaphore>, Arc<Semaphore>)> = OnceLock::new();

pub struct OfflinePythonDispatcher {
    store: Store,
    credential: Arc<str>,
    sandbox: Arc<WorkerSandbox>,
    #[cfg(test)]
    spawned: Arc<std::sync::atomic::AtomicUsize>,
}
pub struct OfflinePythonControl(watch::Sender<Option<ProviderAdmission>>);
pub struct OfflinePythonSignals(watch::Receiver<Option<ProviderAdmission>>);
pub fn offline_python_controls() -> (OfflinePythonControl, OfflinePythonSignals) {
    let (tx, rx) = watch::channel(None);
    (OfflinePythonControl(tx), OfflinePythonSignals(rx))
}
impl OfflinePythonControl {
    /// Carries a Core-issued cancellation token from trusted server composition.
    /// This does not trigger cancellation itself; durable current state does.
    pub fn observe_durable_stop(&self, control: ProviderAdmission) {
        self.0.send_replace(Some(control));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueRefusal {
    Full,
    Deadline,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownReason {
    Authority(RuntimeStoreError),
    Sandbox(WorkerSandboxError),
    Join,
    SpawnDeadline,
}
pub enum OfflinePythonResult {
    /// One private native result reservation, computed from actual bounded output.
    Prepared(OfflinePythonResultReservation),
    Finished {
        receipt: OfflinePythonReceipt,
        output: Option<WorkerOutput>,
    },
    /// Immutable receipt from the durable consume. No quarantined output escapes.
    Unknown {
        receipt: OfflinePythonReceipt,
        reason: UnknownReason,
    },
    /// Queue refusal preserves the original unconsumed private grant for retry.
    NotDispatched {
        delegation: OfflinePythonDelegation,
        reason: QueueRefusal,
    },
    Refused {
        delegation_id: Uuid,
        error: RuntimeStoreError,
    },
    ReconciliationRequired {
        delegation_id: Uuid,
    },
}

struct CancelOnDrop(WorkerCancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct Execution {
    started: bool,
    result: std::result::Result<WorkerOutput, UnknownReason>,
}

impl OfflinePythonDispatcher {
    /// Fixed server-side profile. Caller supplies an already authorized Store;
    /// neither its credential nor this object is a public request DTO.
    pub fn opt_in(store: Store, credential: String) -> Result<Self, WorkerSandboxError> {
        Ok(Self {
            store,
            credential: credential.into(),
            sandbox: Arc::new(WorkerSandbox::opt_in_python_offline()?),
            #[cfg(test)]
            spawned: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        })
    }

    pub async fn run(
        &self,
        delegation: OfflinePythonDelegation,
        signals: OfflinePythonSignals,
    ) -> OfflinePythonResult {
        self.run_inner(delegation, signals, Box::new(()), false)
            .await
    }

    /// Opt-in ordinary Worker callsite. Retained ownership survives cancellation
    /// of this future until the actual blocking sandbox child has been waited.
    pub async fn run_native(
        &self,
        delegation: OfflinePythonDelegation,
        signals: OfflinePythonSignals,
        retained: Box<dyn Send + 'static>,
    ) -> OfflinePythonResult {
        self.run_inner(delegation, signals, retained, true).await
    }

    async fn run_inner(
        &self,
        delegation: OfflinePythonDelegation,
        mut signals: OfflinePythonSignals,
        retained: Box<dyn Send + 'static>,
        native_result: bool,
    ) -> OfflinePythonResult {
        let (total, active) = GATES.get_or_init(|| {
            (
                Arc::new(Semaphore::new(TOTAL)),
                Arc::new(Semaphore::new(CONCURRENT)),
            )
        });
        let Ok(_total) = total.clone().try_acquire_owned() else {
            return OfflinePythonResult::NotDispatched {
                delegation,
                reason: QueueRefusal::Full,
            };
        };
        let permit =
            match tokio::time::timeout(QUEUE_DEADLINE, active.clone().acquire_owned()).await {
                Ok(Ok(permit)) => permit,
                _ => {
                    return OfflinePythonResult::NotDispatched {
                        delegation,
                        reason: QueueRefusal::Deadline,
                    }
                }
            };
        let id = delegation.id();
        let launch = match self
            .store
            .consume_offline_python(&self.credential, delegation)
            .await
        {
            Ok(OfflinePythonConsumption::Launch(launch)) => Arc::new(launch),
            Ok(OfflinePythonConsumption::ReconciliationRequired) => {
                return OfflinePythonResult::ReconciliationRequired { delegation_id: id }
            }
            Err(error) => {
                return OfflinePythonResult::Refused {
                    delegation_id: id,
                    error,
                }
            }
        };
        let cancellation = WorkerCancellation::default();
        let _cleanup = CancelOnDrop(cancellation.clone());
        let child_cancel = cancellation.clone();
        let (store, credential, sandbox, cap) = (
            self.store.clone(),
            self.credential.clone(),
            self.sandbox.clone(),
            launch.clone(),
        );
        let spawn_deadline = Instant::now() + QUEUE_DEADLINE;
        #[cfg(test)]
        let spawned = self.spawned.clone();
        let mut work = tokio::task::spawn_blocking(move || {
            // This permit remains owned through physical cleanup even if run's
            // future is dropped. No unconstrained blocking-pool queue is created.
            let _permit = permit;
            let _retained = retained;
            if Instant::now() >= spawn_deadline {
                return Execution {
                    started: false,
                    result: Err(UnknownReason::SpawnDeadline),
                };
            }
            let child = store.with_offline_python_fence(&credential, &cap, || {
                // Database contention can outlast the scheduling budget too.
                // Refuse at the actual effect boundary, not just pool submission.
                if Instant::now() >= spawn_deadline {
                    return Err(UnknownReason::SpawnDeadline);
                }
                let child = sandbox
                    .start_python(cap.source(), WorkerLimits::default(), &child_cancel)
                    .map_err(UnknownReason::Sandbox)?;
                #[cfg(test)]
                spawned.fetch_add(1, std::sync::atomic::Ordering::Release);
                Ok::<_, UnknownReason>(child)
            });
            match child {
                Ok(Ok(child)) => Execution {
                    started: true,
                    result: child.wait(&child_cancel).map_err(UnknownReason::Sandbox),
                },
                Ok(Err(reason)) => Execution {
                    started: false,
                    result: Err(reason),
                },
                Err(error) => Execution {
                    started: false,
                    result: Err(UnknownReason::Authority(error)),
                },
            }
        });
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut refusal = None;
        let joined = loop {
            tokio::select! {
                result = &mut work => break result,
                _ = interval.tick(), if refusal.is_none() => {
                    let check = tokio::time::timeout(Duration::from_millis(50),self.store.check_offline_python(&self.credential,&launch)).await;
                    let error = match check { Ok(Ok(())) => None, Ok(Err(error)) => Some(error), Err(_) => Some(RuntimeStoreError::Unavailable) };
                    if let Some(error) = error { refusal=Some(error); cancellation.cancel(); }
                }
            }
        };
        let Ok(execution) = joined else {
            return unknown(&launch, UnknownReason::Join);
        };
        if execution.started
            && matches!(
                &execution.result,
                Err(UnknownReason::Sandbox(WorkerSandboxError::Cancelled))
            )
        {
            // The durable Stop commit may become visible to the monitor just
            // before its trusted controller publishes the corresponding token.
            if signals.0.borrow().is_none() {
                let _ = tokio::time::timeout(Duration::from_millis(50), signals.0.changed()).await;
            }
            let control = signals.0.borrow().clone();
            if let Some(control) = control {
                if let Ok(receipt) = self
                    .store
                    .acknowledge_offline_python_cancel(&self.credential, &launch, &control)
                    .await
                {
                    return OfflinePythonResult::Finished {
                        receipt,
                        output: None,
                    };
                }
            }
        }
        if let Some(error) = refusal {
            return unknown(&launch, UnknownReason::Authority(error));
        }
        match execution.result {
            Ok(output) if native_result => {
                let output = OfflinePythonOutput {
                    stdout: output.stdout,
                    stderr: output.stderr,
                    exit_code: output.exit_code,
                    signal: output.signal,
                };
                match self
                    .store
                    .prepare_offline_python_result(&self.credential, &launch, &output)
                    .await
                {
                    Ok(OfflinePythonResultPreparation::Reserved(reservation)) => {
                        OfflinePythonResult::Prepared(reservation)
                    }
                    Ok(OfflinePythonResultPreparation::ReconciliationRequired) => {
                        OfflinePythonResult::ReconciliationRequired {
                            delegation_id: launch.id(),
                        }
                    }
                    Err(error) => unknown(&launch, UnknownReason::Authority(error)),
                }
            }
            Ok(output) => {
                let outcome = if output.exit_code == Some(0) && output.signal.is_none() {
                    OfflinePythonOutcome::Completed
                } else {
                    OfflinePythonOutcome::Failed
                };
                match self
                    .store
                    .finish_offline_python(
                        &self.credential,
                        &launch,
                        outcome,
                        &output::digest(&output),
                    )
                    .await
                {
                    Ok(receipt) => OfflinePythonResult::Finished {
                        receipt,
                        output: Some(output),
                    },
                    Err(error) => unknown(&launch, UnknownReason::Authority(error)),
                }
            }
            Err(UnknownReason::Sandbox(error))
                if execution.started && error != WorkerSandboxError::Cancelled =>
            {
                match self
                    .store
                    .finish_offline_python(
                        &self.credential,
                        &launch,
                        OfflinePythonOutcome::Failed,
                        &output::failure_digest(error),
                    )
                    .await
                {
                    Ok(receipt) => OfflinePythonResult::Finished {
                        receipt,
                        output: None,
                    },
                    Err(error) => unknown(&launch, UnknownReason::Authority(error)),
                }
            }
            Err(reason) => unknown(&launch, reason),
        }
    }
}
fn unknown(launch: &ConsumedOfflinePython, reason: UnknownReason) -> OfflinePythonResult {
    OfflinePythonResult::Unknown {
        receipt: launch.receipt().clone(),
        reason,
    }
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod tests;
