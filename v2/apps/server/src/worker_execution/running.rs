//! A single Worker turn shares the same issued-control handoff as Deep.
use super::*;
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::ExecutionPhase;

impl WorkerSchedule {
    pub(super) async fn running(
        &mut self,
        mut running: Box<Running>,
    ) -> Result<(Phase, WorkerProgress), &'static str> {
        if let Some(control) = running
            .controls
            .take()
            .map_err(|_| "Worker control handoff unavailable")?
        {
            let control = control
                .dispatch(running.authority, running.pump)
                .map_err(|_| "Worker native interruption requires reconciliation")?;
            return Ok((Phase::Stopping(Box::new(control)), WorkerProgress::Running));
        }
        let status = self
            .store
            .execution_run_status(
                &self.credential,
                &self.parent.owner_id,
                &self.parent.conversation_id,
                &running.run,
            )
            .await
            .map_err(|_| "Worker execution status unavailable")?
            .ok_or("Worker execution status missing")?;
        if status.run_id.as_ref() != Some(&running.run) {
            return Err("Worker execution scope changed");
        }
        if status.phase == ExecutionPhase::Completed {
            let _ = running.authority.revoke();
            return Ok((
                Phase::Closed(WorkerProgress::Completed),
                WorkerProgress::Completed,
            ));
        }
        if matches!(
            status.phase,
            ExecutionPhase::Cancelled
                | ExecutionPhase::CancelRequested
                | ExecutionPhase::Failed
                | ExecutionPhase::Blocked
        ) {
            // Cancellation without this exact issued receipt is unknown; no
            // alternate request key or control reconstructed from state.
            let _ = running.authority.revoke();
            return Ok((
                Phase::Closed(WorkerProgress::Unknown),
                WorkerProgress::Unknown,
            ));
        }
        if status.phase == ExecutionPhase::AwaitingAcceptance {
            // Preserve a completed native turn while the owner decides, without
            // writing more execution bytes. Idle retention remains bounded.
            if Instant::now() >= self.deadline {
                let _ = running.authority.revoke();
                return Ok((
                    Phase::Closed(WorkerProgress::AwaitingAcceptance),
                    WorkerProgress::AwaitingAcceptance,
                ));
            }
            return Ok((Phase::Running(running), WorkerProgress::AwaitingAcceptance));
        }
        if Instant::now() >= self.deadline {
            let receipt = self
                .store
                .request_cancel(
                    &self.parent.owner_id,
                    &running.run,
                    "worker-runtime-deadline",
                )
                .await
                .map_err(|_| "Worker deadline requires reconciliation")?;
            running
                .sender
                .publish(receipt)
                .map_err(|_| "Worker deadline handoff requires reconciliation")?;
            // This same parent-owned loop serializes Worker observations and
            // deadline commit/publication. No concurrent Worker pump can race it.
            return Ok((Phase::Running(running), WorkerProgress::Running));
        }
        if running.pump.pending().is_none() {
            running
                .pump
                .flush()
                .map_err(|_| "Worker write fence refused")?;
        }
        match running.pump.step(&self.store).await {
            Ok(_) => {}
            Err(orkestr_runtime::supervisor::Error::Store(
                RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
            )) => {}
            Err(_) => return Err("Worker observation requires reconciliation"),
        }
        Ok((Phase::Running(running), WorkerProgress::Running))
    }

    pub(super) async fn stopping(
        mut control: Box<crate::control_dispatch::ActiveControl>,
    ) -> (Phase, WorkerProgress) {
        use crate::control_dispatch::StopProgress;
        match control.tick().await {
            StopProgress::Pending | StopProgress::InterruptAcknowledged => {
                (Phase::Stopping(control), WorkerProgress::Running)
            }
            StopProgress::Stopped => {
                // Public runtime truth is read from Core; local lifecycle
                // completion does not imply successful task completion.
                (
                    Phase::Closed(WorkerProgress::Unknown),
                    WorkerProgress::Unknown,
                )
            }
            StopProgress::ReconciliationRequired => {
                // Retain pending/racing terminal evidence until the parent
                // releases this scheduler. Never repeat the native interrupt.
                (Phase::Stopping(control), WorkerProgress::Unknown)
            }
        }
    }
}
