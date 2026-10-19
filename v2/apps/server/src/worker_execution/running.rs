//! A single Worker turn shares the same issued-control handoff as Deep.
use super::*;
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::ExecutionPhase;

impl WorkerSchedule {
    pub(super) async fn running(
        &mut self,
        mut running: Box<Running>,
    ) -> Result<(Phase, WorkerProgress), &'static str> {
        let _schedule = running.control.serialize().await;
        if let Some(control) = running
            .controls
            .take()
            .map_err(|_| "Worker control handoff unavailable")?
        {
            let tool_cleanup = running.tools.take().and_then(tools::WorkerTools::cancel);
            let active = control
                .dispatch_retiring(running.authority, running.pump)
                .map_err(|_| "Worker native interruption requires reconciliation")?;
            return Ok((
                Phase::Stopping(Box::new(Stopping {
                    active,
                    _control: running.control,
                    tool_cleanup,
                })),
                WorkerProgress::Running,
            ));
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
        running.control.set_available(
            status.phase == ExecutionPhase::Running && running.pump.pending().is_none(),
        );
        if status.phase == ExecutionPhase::Completed {
            return Self::accepted(*running);
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
        if self.quiesced {
            return Err("Worker terminal cleanup refuses unfinished execution");
        }
        if status.phase == ExecutionPhase::AwaitingAcceptance {
            // Preserve a completed native turn while the owner decides, without
            // writing more execution bytes. Idle retention remains bounded.
            let now = Instant::now();
            let expired = match &running.liveness {
                Some(lease) => {
                    lease.must_stop(now)
                        || running
                            .budget
                            .as_ref()
                            .is_some_and(|budget| budget.expired(now))
                }
                None => now >= self.deadline,
            };
            if expired {
                let _ = running.authority.revoke();
                return Ok((
                    Phase::Closed(WorkerProgress::AwaitingAcceptance),
                    WorkerProgress::AwaitingAcceptance,
                ));
            }
            return Ok((Phase::Running(running), WorkerProgress::AwaitingAcceptance));
        }
        let now = Instant::now();
        let cancellation = running
            .budget
            .as_ref()
            .and_then(|budget| budget.cancellation_key(now))
            .or_else(|| {
                running
                    .liveness
                    .as_ref()
                    .filter(|lease| lease.must_stop(now))
                    .map(|_| "worker-lease-deadline")
            })
            .or_else(|| {
                (running.liveness.is_none() && now >= self.deadline)
                    .then_some("worker-runtime-deadline")
            });
        if let Some(key) = cancellation {
            let receipt = self
                .store
                .request_cancel(&self.parent.owner_id, &running.run, key)
                .await
                .map_err(|_| "Worker deadline requires reconciliation")?;
            running
                .control
                .publish(receipt)
                .map_err(|_| "Worker deadline handoff requires reconciliation")?;
            // This same parent-owned loop serializes Worker observations and
            // deadline commit/publication. No concurrent Worker pump can race it.
            return Ok((Phase::Running(running), WorkerProgress::Running));
        }
        if let Some(tools) = &mut running.tools {
            tools.poll(&mut running.pump).await?;
        }
        if running.pump.pending().is_none() {
            running
                .pump
                .flush()
                .map_err(|_| "Worker write fence refused")?;
        }
        let committed = match running.pump.step(&self.store).await {
            Ok(committed) => committed,
            Err(orkestr_runtime::supervisor::Error::Store(
                RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
            )) => false,
            Err(_) => return Err("Worker observation requires reconciliation"),
        };
        let phase = if committed {
            if let Some(budget) = &mut running.budget {
                budget.observed(Instant::now());
            }
            self.store
                .execution_run_status(
                    &self.credential,
                    &self.parent.owner_id,
                    &self.parent.conversation_id,
                    &running.run,
                )
                .await
                .map_err(|_| "Worker committed status unavailable")?
                .filter(|status| status.run_id.as_ref() == Some(&running.run))
                .ok_or("Worker committed scope changed")?
                .phase
        } else {
            status.phase
        };
        if phase == ExecutionPhase::Running
            && running
                .liveness
                .as_ref()
                .is_some_and(|lease| lease.due(Instant::now()))
            && running.pump.renewal_quiescent()
            && running
                .tools
                .as_ref()
                .is_none_or(tools::WorkerTools::renewal_quiescent)
        {
            running = self.refresh_running(running).await?;
        }
        // A Busy persistence step can retain a new observation. Refresh before
        // releasing the shared guard so HTTP cannot cancel through that gap.
        running
            .control
            .set_available(phase == ExecutionPhase::Running && running.pump.pending().is_none());
        Ok((Phase::Running(running), WorkerProgress::Running))
    }

    async fn refresh_running(&self, running: Box<Running>) -> Result<Box<Running>, &'static str> {
        let Running {
            authority,
            pump,
            run,
            control,
            controls,
            mut tools,
            mut liveness,
            budget,
        } = *running;
        let lease = liveness.as_mut().ok_or("Worker renewal issuer missing")?;
        let (next_authority, next_pump) = lease.refresh(self.store.clone(), pump).await?;
        let _ = authority.revoke();
        if let Some(tools) = &mut tools {
            tools.refresh_parent(lease.authority()).await?;
        }
        Ok(Box::new(Running {
            authority: next_authority,
            pump: next_pump,
            run,
            control,
            controls,
            tools,
            liveness,
            budget,
        }))
    }

    pub(super) async fn stopping(
        mut control: Box<Stopping>,
    ) -> Result<(Phase, WorkerProgress), &'static str> {
        use crate::control_dispatch::StopProgress;
        // Do not persist native Stopped while an offline child still exists.
        // Abort already requested its owned cleanup; HTTP Stop has committed.
        if control
            .tool_cleanup
            .as_ref()
            .is_some_and(|tool| !tool.is_reaped())
        {
            return Ok((Phase::Stopping(control), WorkerProgress::Running));
        }
        control.tool_cleanup.take();
        match control.active.tick().await {
            StopProgress::Pending | StopProgress::InterruptAcknowledged => {
                Ok((Phase::Stopping(control), WorkerProgress::Running))
            }
            StopProgress::Stopped => {
                let broker = control
                    .active
                    .retire_broker()
                    .map_err(|_| "Worker stopped broker retirement refused")?;
                Ok((
                    Phase::Retiring(Box::new(retirement::Retiring::new(
                        broker,
                        WorkerProgress::Unknown,
                    ))),
                    WorkerProgress::Running,
                ))
            }
            StopProgress::ReconciliationRequired => {
                // Retain pending/racing terminal evidence until the parent
                // releases this scheduler. Never repeat the native interrupt.
                Ok((Phase::Stopping(control), WorkerProgress::Unknown))
            }
        }
    }
}
