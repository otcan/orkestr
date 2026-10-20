//! A separate project command sandbox; native provider policy stays read-only.
//! The optional trusted profile adds host toolchains, optional network,
//! explicit credential allowlists and detached jobs, all operator-configured.
mod jobs;
mod operation;
mod render;

use jobs::{Jobs, Started};
use operation::{Control, Operation};
use orkestr_runtime::{
    worker_sandbox::{WorkerCancellation, WorkerLimits, WorkerSandboxError},
    workspace_exec::{profile::TrustedProfile, CommandKind, WorkspaceExecSandbox},
};
use orkestr_v2_store_sqlite::{
    ConsumedWorkspaceExec, Store, WorkspaceExecConsumption, WorkspaceExecDelegation,
    WorkspaceExecOutput, WorkspaceExecProfile, WorkspaceExecResultPreparation,
    WorkspaceExecResultReservation,
};
use std::{
    path::Path,
    sync::{Arc, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

const QUEUE_DEADLINE: Duration = Duration::from_millis(200);
/// Result preparation must still find the consumed delegation unexpired.
const RESULT_MARGIN_MS: i64 = 2_000;
const MAX_JOB_WAIT: Duration = Duration::from_secs(20);
static GATES: OnceLock<(Arc<Semaphore>, Arc<Semaphore>)> = OnceLock::new();

pub(crate) struct WorkspaceExecDispatcher {
    store: Store,
    credential: Arc<str>,
    profile: Arc<WorkspaceExecProfile>,
    sandbox: Arc<WorkspaceExecSandbox>,
    jobs: Option<Arc<Jobs>>,
    worker_run_ms: Option<u32>,
}

struct CancelOnDrop(WorkerCancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl WorkspaceExecDispatcher {
    pub(crate) fn configured(
        store: Store,
        credential: String,
        profile: Arc<WorkspaceExecProfile>,
        cgroup_root: &Path,
        toolchain_root: &Path,
        trusted: Option<(TrustedProfile, &Path)>,
    ) -> Result<Self, &'static str> {
        let (sandbox, jobs) = match trusted {
            Some((trusted, jobs_directory)) => {
                let jobs = (trusted.max_jobs > 0)
                    .then(|| Jobs::for_directory(jobs_directory))
                    .transpose()?;
                let sandbox =
                    WorkspaceExecSandbox::configured_trusted(cgroup_root, toolchain_root, trusted);
                (sandbox, jobs)
            }
            None => (
                WorkspaceExecSandbox::configured(cgroup_root, toolchain_root),
                None,
            ),
        };
        Ok(Self {
            store,
            credential: credential.into(),
            profile,
            sandbox: Arc::new(sandbox.map_err(|_| "workspace command sandbox unavailable")?),
            jobs,
            worker_run_ms: None,
        })
    }

    /// Trusted Worker run budget; only meaningful with the trusted profile.
    pub(crate) fn with_worker_run_ms(mut self, worker_run_ms: Option<u32>) -> Self {
        self.worker_run_ms = worker_run_ms.filter(|_| self.trusted());
        self
    }

    pub(crate) fn worker_run_ms(&self) -> Option<u32> {
        self.worker_run_ms
    }

    pub(crate) fn profile(&self) -> &Arc<WorkspaceExecProfile> {
        &self.profile
    }

    pub(crate) fn trusted(&self) -> bool {
        self.sandbox.trusted().is_some()
    }

    /// Queue/authority failures never cause a replacement grant or command retry.
    /// Retained resources survive async cancellation until physical cleanup.
    pub(crate) async fn run_native(
        &self,
        delegation: WorkspaceExecDelegation,
        retained: Box<dyn Send + 'static>,
    ) -> Result<WorkspaceExecResultReservation, &'static str> {
        let (total, active) =
            GATES.get_or_init(|| (Arc::new(Semaphore::new(12)), Arc::new(Semaphore::new(4))));
        let _total = total
            .clone()
            .try_acquire_owned()
            .map_err(|_| "workspace command queue full")?;
        let permit = tokio::time::timeout(QUEUE_DEADLINE, active.clone().acquire_owned())
            .await
            .map_err(|_| "workspace command queue expired")?
            .map_err(|_| "workspace command queue unavailable")?;
        let launch = match self
            .store
            .consume_workspace_exec(&self.credential, delegation)
            .await
            .map_err(|_| "workspace command consume refused")?
        {
            WorkspaceExecConsumption::Launch(launch) => Arc::new(launch),
            WorkspaceExecConsumption::ReconciliationRequired => {
                return Err("workspace command consume uncertain")
            }
        };
        // The restricted profile never interprets source text; the trusted one
        // reads its operation back from Core's consumed, audited source only.
        let operation = if self.trusted() {
            Operation::parse(launch.source()).ok_or("workspace job operation refused")?
        } else {
            Operation::Command(launch.source())
        };
        let output = match operation {
            Operation::Command(_) => self.command(&launch, permit, retained).await?,
            Operation::Start(command) => {
                let command = command.to_owned();
                self.start_job(&launch, command, (permit, retained)).await?
            }
            Operation::Status(id) => {
                self.control_job(&launch, id, Control::Status, (permit, retained))
                    .await?
            }
            Operation::Wait(id) => {
                self.control_job(&launch, id, Control::Wait, (permit, retained))
                    .await?
            }
            Operation::Cancel(id) => {
                self.control_job(&launch, id, Control::Cancel, (permit, retained))
                    .await?
            }
        };
        match self
            .store
            .prepare_workspace_exec_result(&self.credential, &launch, &output)
            .await
            .map_err(|_| "workspace command result refused")?
        {
            WorkspaceExecResultPreparation::Reserved(value) => Ok(value),
            WorkspaceExecResultPreparation::ReconciliationRequired => {
                Err("workspace command result uncertain")
            }
        }
    }

    async fn command(
        &self,
        launch: &Arc<ConsumedWorkspaceExec>,
        permit: tokio::sync::OwnedSemaphorePermit,
        retained: Box<dyn Send + 'static>,
    ) -> Result<WorkspaceExecOutput, &'static str> {
        let cancellation = WorkerCancellation::default();
        let _cleanup = CancelOnDrop(cancellation.clone());
        let child_cancel = cancellation.clone();
        let trusted = self.trusted();
        let maximum = self
            .sandbox
            .limits(CommandKind::Command)
            .ok_or("workspace command limits unavailable")?;
        let (store, credential, sandbox, cap) = (
            self.store.clone(),
            self.credential.clone(),
            self.sandbox.clone(),
            launch.clone(),
        );
        let deadline = Instant::now() + QUEUE_DEADLINE;
        let mut job = tokio::task::spawn_blocking(move || {
            let limits = if trusted {
                trusted_limits(cap.expires_at_ms(), now_ms()?, maximum)?
            } else {
                command_limits(cap.expires_at_ms(), now_ms()?)?
            };
            let child = store
                .with_workspace_exec_fence(&credential, &cap, |workspace| {
                    if Instant::now() >= deadline {
                        return Err("workspace command spawn deadline");
                    }
                    sandbox
                        .start(
                            cap.source(),
                            workspace,
                            limits,
                            &child_cancel,
                            Box::new((permit, retained, cap.clone())),
                        )
                        .map_err(|_| "workspace command spawn refused")
                })
                .map_err(|_| "workspace command spawn fence refused")??;
            // The actual reaper owns the accounting and grant even when this
            // bounded wait refuses cleanup. Never block SQLite on that wait.
            if !trusted {
                return child
                    .wait(&child_cancel)
                    .map_err(|_| "workspace command wait refused");
            }
            match child.wait_truncated(&child_cancel) {
                // Dropping the process already killed and reaped its cgroup.
                Err(WorkerSandboxError::Timeout) => Ok(render::timed_out(limits.timeout)),
                result => result.map_err(|_| "workspace command wait refused"),
            }
        });
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut refused = false;
        let joined = loop {
            tokio::select! {
                result = &mut job => break result,
                _ = interval.tick(), if !refused => {
                    if !self.authorized(launch).await {
                        refused = true;
                        cancellation.cancel();
                    }
                }
            }
        };
        let output = joined.map_err(|_| "workspace command join refused")??;
        if refused {
            return Err("workspace command authority changed");
        }
        Ok(WorkspaceExecOutput {
            stdout: output.stdout,
            stderr: output.stderr,
            exit_code: output.exit_code,
            signal: output.signal,
        })
    }

    async fn authorized(&self, launch: &ConsumedWorkspaceExec) -> bool {
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            self.store.check_workspace_exec(&self.credential, launch),
        )
        .await;
        matches!(result, Ok(Ok(())))
    }

    async fn start_job(
        &self,
        launch: &Arc<ConsumedWorkspaceExec>,
        command: String,
        retained: impl Send + 'static,
    ) -> Result<WorkspaceExecOutput, &'static str> {
        let jobs = self.jobs.clone().ok_or("background jobs are not enabled")?;
        let (store, credential, sandbox, cap) = (
            self.store.clone(),
            self.credential.clone(),
            self.sandbox.clone(),
            launch.clone(),
        );
        let timeout = sandbox.limits(CommandKind::Job).map(|l| l.timeout);
        let started = tokio::task::spawn_blocking(move || {
            let _retained = retained;
            store
                .with_workspace_exec_fence(&credential, &cap, |workspace| {
                    jobs.start(&sandbox, &command, workspace)
                })
                .map_err(|_| "workspace job fence refused")?
        })
        .await
        .map_err(|_| "workspace job join refused")??;
        if let (Started::Started(_), Some(jobs)) = (&started, &self.jobs) {
            jobs.monitor(
                self.store.clone(),
                self.credential.clone(),
                self.profile.clone(),
            );
        }
        Ok(render::started(&started, timeout.unwrap_or_default()))
    }

    async fn control_job(
        &self,
        launch: &Arc<ConsumedWorkspaceExec>,
        id: uuid::Uuid,
        control: Control,
        retained: impl Send + 'static,
    ) -> Result<WorkspaceExecOutput, &'static str> {
        let jobs = self.jobs.clone().ok_or("background jobs are not enabled")?;
        // Spend the one-use fence with no process: authority is current and the
        // control operation itself is what Core delivers exactly once.
        let (store, credential, cap) =
            (self.store.clone(), self.credential.clone(), launch.clone());
        tokio::task::spawn_blocking(move || {
            let _retained = retained;
            store
                .with_workspace_exec_fence(&credential, &cap, |_| Ok::<(), ()>(()))
                .map_err(|_| "workspace job fence refused")?
                .map_err(|_| "workspace job fence refused")
        })
        .await
        .map_err(|_| "workspace job join refused")??;
        match control {
            Control::Cancel => {
                let cancelled = jobs.cancel(id);
                if cancelled {
                    self.wait_finished(launch, &jobs, id, Duration::from_secs(5))
                        .await?;
                }
            }
            Control::Wait => {
                let remaining = launch.expires_at_ms() - now_ms()? - RESULT_MARGIN_MS;
                let wait = Duration::from_millis(remaining.max(0) as u64).min(MAX_JOB_WAIT);
                self.wait_finished(launch, &jobs, id, wait).await?;
            }
            Control::Status => {}
        }
        Ok(render::status(id, jobs.snapshot(id)))
    }

    async fn wait_finished(
        &self,
        launch: &ConsumedWorkspaceExec,
        jobs: &Jobs,
        id: uuid::Uuid,
        wait: Duration,
    ) -> Result<(), &'static str> {
        let until = Instant::now() + wait;
        while Instant::now() < until
            && jobs
                .snapshot(id)
                .is_some_and(|record| record.state == jobs::JobState::Running)
        {
            if !self.authorized(launch).await {
                return Err("workspace command authority changed");
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Ok(())
    }
}

fn now_ms() -> Result<i64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .ok_or("workspace command clock refused")
}

fn command_limits(expires_at_ms: i64, now_ms: i64) -> Result<WorkerLimits, &'static str> {
    let remaining = expires_at_ms
        .checked_sub(now_ms)
        .filter(|remaining| *remaining > 0)
        .ok_or("workspace command expired")?;
    Ok(WorkerLimits {
        timeout: Duration::from_millis(remaining.min(30_000) as u64),
        max_output_bytes: 128 * 1024,
    })
}

/// Trusted short commands keep a margin so a timed-out command still returns
/// its bounded result inside the consumed delegation lifetime.
fn trusted_limits(
    expires_at_ms: i64,
    now_ms: i64,
    maximum: WorkerLimits,
) -> Result<WorkerLimits, &'static str> {
    let remaining = expires_at_ms
        .checked_sub(now_ms)
        .and_then(|remaining| remaining.checked_sub(RESULT_MARGIN_MS))
        .filter(|remaining| *remaining >= 1_000)
        .ok_or("workspace command expired")?;
    Ok(WorkerLimits {
        timeout: Duration::from_millis(remaining as u64).min(maximum.timeout),
        max_output_bytes: maximum.max_output_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_timeout_never_extends_consumed_lease_or_thirty_second_limit() {
        assert_eq!(
            command_limits(90_000, 10_000).unwrap().timeout,
            Duration::from_secs(30)
        );
        assert_eq!(
            command_limits(12_345, 10_000).unwrap().timeout,
            Duration::from_millis(2345)
        );
        assert_eq!(
            command_limits(12_345, 10_000).unwrap().max_output_bytes,
            128 * 1024
        );
        assert!(command_limits(10_000, 10_000).is_err());
        assert!(command_limits(9_999, 10_000).is_err());
        assert!(command_limits(i64::MAX, -1).is_err());
    }

    #[test]
    fn trusted_timeout_keeps_result_margin_and_profile_ceiling() {
        let maximum = WorkerLimits {
            timeout: Duration::from_secs(20),
            max_output_bytes: 4096,
        };
        assert_eq!(
            trusted_limits(90_000, 10_000, maximum).unwrap().timeout,
            Duration::from_secs(20)
        );
        assert_eq!(
            trusted_limits(15_000, 10_000, maximum).unwrap().timeout,
            Duration::from_secs(3)
        );
        assert_eq!(
            trusted_limits(15_000, 10_000, maximum)
                .unwrap()
                .max_output_bytes,
            4096
        );
        assert!(trusted_limits(12_999, 10_000, maximum).is_err());
        assert!(trusted_limits(i64::MAX, -1, maximum).is_err());
    }
}
