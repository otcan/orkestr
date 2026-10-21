//! Optional server policy stays owned by the exact parent session lifecycle.
use super::*;
use crate::worker_execution::{WorkerConfiguration, WorkerSchedule};
use orkestr_v2_store_sqlite::ConsumedProviderDispatch;

impl ConfiguredExecution {
    pub(super) fn prepare_worker(
        &self,
        parent: &ConsumedProviderDispatch,
    ) -> Result<Option<WorkerSchedule>, &'static str> {
        self.config
            .worker
            .as_ref()
            .map(|policy| {
                let (launcher, launcher_sha256) = policy.broker_launcher().unwrap_or((
                    self.config.launcher.as_path(),
                    self.config.launcher_sha256.as_str(),
                ));
                WorkerSchedule::prepare(
                    self.store.clone(),
                    self.token.clone(),
                    WorkerConfiguration {
                        policy: policy.clone(),
                        launcher: launcher.to_owned(),
                        launcher_sha256: launcher_sha256.to_owned(),
                        workspace: self.config.workspace.clone(),
                        directory: self.directory.clone(),
                        controls: self.control.clone(),
                        children: self.children.clone(),
                        reaps: self.worker_reaps.clone(),
                        tasks: self.tasks.clone(),
                        offline_python: self.offline_python.clone(),
                        workspace_exec: self.workspace_exec.clone(),
                        workspace_grant: self.workspace_grant.clone(),
                        window: self.window_workers.clone(),
                    },
                    parent,
                )
            })
            .transpose()
    }

    /// Best effort; a refusal leaves the current deadline in force.
    pub(super) async fn extend_window_while_working(&self) {
        if let Some(window) = &self.window {
            window.extend_while_working(&self.store, &self.token).await;
        }
    }

    pub(super) fn quiesce_worker(worker: &mut Option<WorkerSchedule>) {
        if let Some(worker) = worker {
            worker.quiesce();
        }
    }

    pub(super) async fn poll_worker(worker: &mut Option<WorkerSchedule>) {
        if let Some(schedule) = worker.as_mut() {
            if let Err(reason) = schedule.poll().await {
                // An independent Worker failure must not turn into another
                // admission or fabricate parent failure. Its durable state
                // remains available for reconciliation; dropping only its
                // schedule initiates Runtime's retained-resource cleanup.
                eprintln!("owned Worker paused: {reason}");
                *worker = None;
            }
        }
    }
}
