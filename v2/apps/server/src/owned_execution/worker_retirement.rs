//! Per-turn quiescence and final proof collection are distinct operations.
use super::*;
use crate::worker_execution::{WorkerReapProofs, WorkerSchedule};
use orkestr_runtime::containment::ReapedBroker;
use std::time::Instant;

/// Retains original typed evidence across the separate current-auth Core call.
pub(super) struct FactoryReapProofs {
    _parent: Option<ReapedBroker>,
    _workers: Option<WorkerReapProofs>,
}

impl ConfiguredExecution {
    /// Freeze this parent turn's scheduling, then drive terminal cleanup only.
    /// Always consumes the schedule: cancellation/timeout drops owned handles
    /// and poisons any missing witness, while Runtime retains physical cleanup.
    /// A refusal must not suppress the parent's own already-issued Stop drive.
    pub(super) async fn drain_worker(
        &self,
        worker: &mut Option<WorkerSchedule>,
        heartbeat: &mut Instant,
    ) -> Result<(), &'static str> {
        let Some(mut worker) = worker.take() else {
            return Ok(());
        };
        worker.quiesce();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                self.maintain(heartbeat).await?;
                if worker.drain().await? {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "execution Worker terminal cleanup timed out")?
    }

    /// Final context retirement only; never invoke between parent continuations.
    /// No disabled policy, empty ChildSet or durable state can erase obligations.
    pub(super) fn finish_worker_reaps(
        &self,
        parent: ReapedBroker,
    ) -> Result<FactoryReapProofs, &'static str> {
        if self.config.worker.is_some() {
            Ok(FactoryReapProofs {
                _parent: None,
                _workers: Some(self.worker_reaps.finish(parent)?),
            })
        } else {
            Ok(FactoryReapProofs {
                _parent: Some(parent),
                _workers: None,
            })
        }
    }
}
