//! Optional trusted Worker scheduling. Browser input cannot construct authority.
mod configuration;
mod directory;
mod policy;
mod running;
mod session;
mod tasks;
pub use configuration::WorkerConfiguration;
use orkestr_runtime::{
    containment::Authority,
    execution::{CodexPump, PreparingCodex},
};
use orkestr_v2_application::runtime::{Binding, RunAdmission, SessionRole};
use orkestr_v2_contracts::{EventId, MessageId, RunId};
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, Store, WorkerTaskClaim};
pub use policy::WorkerPolicy;
use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Scheduling observations only; no variant claims provider interruption.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerProgress {
    WaitingForParent,
    WaitingForTask,
    Preparing,
    Running,
    AwaitingAcceptance,
    Completed,
    Unknown,
}

enum Phase {
    Pending,
    Preparing(Box<Preparing>),
    Running(Box<Running>),
    Stopping(Box<Stopping>),
    Closed(WorkerProgress),
}
struct Preparing {
    setup: PreparingCodex,
    binding: Binding,
}
struct Running {
    authority: Authority,
    pump: CodexPump,
    run: RunId,
    control: crate::control_registry::RunControl,
    controls: crate::control_dispatch::ControlReceiver,
}
struct Stopping {
    active: crate::control_dispatch::ActiveControl,
    // Retain registration through Stop drive and any pending reconciliation.
    _control: crate::control_registry::RunControl,
}

/// Held by the parent's ordinary session loop, never a detached task. The same
/// loop must poll this while its own completion is pending or awaiting acceptance.
/// Dropping the parent initiates owned cleanup. Runtime retains the Worker's
/// scratch directory and global capacity slot until the child is actually reaped.
pub struct WorkerSchedule {
    phase: Phase,
    store: Store,
    credential: String,
    configuration: WorkerConfiguration,
    // Immutable locators captured from the genuine consumed parent. These fields
    // are NOT execution authority; Core loads current parent authority on issuance.
    parent: RunAdmission,
    message: MessageId,
    source_event: EventId,
    key: String,
    deadline: Instant,
    task_claim: Option<WorkerTaskClaim>,
    queue: Option<tasks::TaskQueue>,
    slot: Option<OwnedSemaphorePermit>,
    lifetime_ms: u32,
}

impl WorkerSchedule {
    /// Called once before the Deep capability is moved into Runtime attachment.
    /// Both source IDs come from the actual consumed parent, never browser JSON.
    /// No provider is started and no dispatch capability is retained here.
    pub fn prepare(
        store: Store,
        credential: String,
        configuration: WorkerConfiguration,
        parent: &ConsumedProviderDispatch,
    ) -> Result<Self, &'static str> {
        configuration.validate()?;
        let run = &parent.provider().run;
        if run.role != SessionRole::Deep || parent.source_event_id().0.is_nil() {
            return Err("Worker scheduling requires an exact ordinary Deep input");
        }
        let queue = if configuration.policy.owner_tasks() {
            Some(tasks::TaskQueue::new(configuration.tasks.register(run)?))
        } else {
            None
        };
        let lifetime_ms = configuration.policy.lifetime_ms();
        Ok(Self {
            phase: Phase::Pending,
            store,
            credential,
            configuration,
            parent: run.clone(),
            message: parent.message_id().clone(),
            source_event: parent.source_event_id().clone(),
            key: format!("worker:{}", run.run_id),
            deadline: Instant::now() + Duration::from_secs(15),
            task_claim: None,
            queue,
            slot: None,
            lifetime_ms,
        })
    }

    /// One bounded setup or provider step, with no provider wait in a DB fence.
    /// Uncertain admission/reservation/consumption is terminal for this scheduler.
    pub async fn poll(&mut self) -> Result<WorkerProgress, &'static str> {
        if self.configuration.policy.owner_tasks() {
            let mut queue = self.queue.take().ok_or("Worker task scheduler closed")?;
            let progress = queue.poll(self).await;
            if progress.is_err() {
                self.store
                    .reconcile_worker_task_holds(&self.parent.run_id)
                    .await
                    .map_err(|_| "Worker task hold reconciliation unavailable")?;
            }
            let progress = progress?;
            self.queue = Some(queue);
            return Ok(progress);
        }
        self.poll_one().await
    }

    async fn poll_one(&mut self) -> Result<WorkerProgress, &'static str> {
        let phase = std::mem::replace(&mut self.phase, Phase::Closed(WorkerProgress::Unknown));
        match self.advance(phase).await {
            Ok((phase, progress)) => {
                self.phase = phase;
                Ok(progress)
            }
            Err(error) => {
                // advance owns the transport; its error path starts Runtime's
                // owned reaper. Retained scratch/capacity survive through wait.
                Err(error)
            }
        }
    }
}

fn capacity() -> &'static Arc<Semaphore> {
    static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
    CAPACITY.get_or_init(|| Arc::new(Semaphore::new(4)))
}
