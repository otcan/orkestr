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
                WorkerSchedule::prepare(
                    self.store.clone(),
                    self.token.clone(),
                    WorkerConfiguration {
                        policy: policy.clone(),
                        launcher: self.config.launcher.clone(),
                        launcher_sha256: self.config.launcher_sha256.clone(),
                        workspace: self.config.workspace.clone(),
                        directory: self.directory.clone(),
                        controls: self.control.clone(),
                        children: self.children.clone(),
                    },
                    parent,
                )
            })
            .transpose()
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
