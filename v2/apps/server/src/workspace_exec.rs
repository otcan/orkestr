//! A separate project command sandbox; native provider policy stays read-only.
use orkestr_runtime::{
    worker_sandbox::{WorkerCancellation, WorkerLimits, WorkerSandboxError},
    workspace_exec::WorkspaceExecSandbox,
};
use orkestr_v2_store_sqlite::{
    Store, WorkspaceExecConsumption, WorkspaceExecDelegation, WorkspaceExecOutput,
    WorkspaceExecProfile, WorkspaceExecResultPreparation, WorkspaceExecResultReservation,
};
use std::{
    path::Path,
    sync::{Arc, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

const QUEUE_DEADLINE: Duration = Duration::from_millis(200);
static GATES: OnceLock<(Arc<Semaphore>, Arc<Semaphore>)> = OnceLock::new();

pub(crate) struct WorkspaceExecDispatcher {
    store: Store,
    credential: Arc<str>,
    profile: Arc<WorkspaceExecProfile>,
    sandbox: Arc<WorkspaceExecSandbox>,
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
    ) -> Result<Self, WorkerSandboxError> {
        Ok(Self {
            store,
            credential: credential.into(),
            profile,
            sandbox: Arc::new(WorkspaceExecSandbox::configured(
                cgroup_root,
                toolchain_root,
            )?),
        })
    }

    pub(crate) fn profile(&self) -> &Arc<WorkspaceExecProfile> {
        &self.profile
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
        let cancellation = WorkerCancellation::default();
        let _cleanup = CancelOnDrop(cancellation.clone());
        let child_cancel = cancellation.clone();
        let (store, credential, sandbox, cap) = (
            self.store.clone(),
            self.credential.clone(),
            self.sandbox.clone(),
            launch.clone(),
        );
        let deadline = Instant::now() + QUEUE_DEADLINE;
        let mut job = tokio::task::spawn_blocking(move || {
            let child = store
                .with_workspace_exec_fence(&credential, &cap, |workspace| {
                    if Instant::now() >= deadline {
                        return Err("workspace command spawn deadline");
                    }
                    sandbox
                        .start(
                            cap.source(),
                            workspace,
                            command_limits(cap.expires_at_ms(), now_ms()?)?,
                            &child_cancel,
                            Box::new((permit, retained, cap.clone())),
                        )
                        .map_err(|_| "workspace command spawn refused")
                })
                .map_err(|_| "workspace command spawn fence refused")??;
            // The actual reaper owns the accounting and grant even when this
            // bounded wait refuses cleanup. Never block SQLite on that wait.
            child
                .wait(&child_cancel)
                .map_err(|_| "workspace command wait refused")
        });
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut refused = false;
        let joined = loop {
            tokio::select! {
                result = &mut job => break result,
                _ = interval.tick(), if !refused => {
                    let result = tokio::time::timeout(Duration::from_millis(50),
                        self.store.check_workspace_exec(&self.credential, &launch)).await;
                    if !matches!(result, Ok(Ok(()))) {
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
        let output = WorkspaceExecOutput {
            stdout: output.stdout,
            stderr: output.stderr,
            exit_code: output.exit_code,
            signal: output.signal,
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
}
