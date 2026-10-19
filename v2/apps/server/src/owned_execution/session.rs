//! Supervisor-owned session lifecycle; no browser-selected authority or transport.
use super::*;
use orkestr_runtime::{containment::ReapedBroker, execution::ReadyCodex};
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::ExecutionPhase;
use std::time::Instant;

enum SessionExit {
    Shutdown,
    Stopped {
        run: orkestr_v2_contracts::RunId,
        proof: ReapedBroker,
    },
}

impl ConfiguredExecution {
    pub(super) async fn run_codex(
        mut self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        self.current().await?;
        self.config.verify_launcher()?;
        let mut heartbeat = Instant::now();
        let mut grant = if let Some(grant) = self.initial_grant.take() {
            // A restarted server accepts HTTP first; it does not immediately
            // launch a native process merely because accepted history exists.
            if self.window.is_none() && !self.wait_eligible(&mut shutdown, &mut heartbeat).await? {
                return Ok(());
            }
            grant
        } else {
            let binding = self
                .store
                .ensure_role_bindings(&self.owner, &self.config.conversation_id)
                .await
                .map_err(|_| "execution bindings unavailable")?
                .deep;
            self.bind_workspace(&binding).await?;
            self.store
                .authorize_session_metadata(&binding)
                .await
                .map_err(|_| "execution setup authority refused")?
        };
        loop {
            let Some(ready) = self
                .prepare_session(grant, &mut shutdown, &mut heartbeat)
                .await?
            else {
                return Ok(());
            };
            match self
                .drive_session(ready, &mut shutdown, &mut heartbeat)
                .await?
            {
                SessionExit::Shutdown => return Ok(()),
                SessionExit::Stopped { run, proof } => {
                    if self.window.is_some() {
                        self.retire_terminal(&run, proof).await?;
                        return Ok(());
                    }
                    if !self.wait_eligible(&mut shutdown, &mut heartbeat).await? {
                        self.retire_terminal(&run, proof).await?;
                        return Ok(());
                    }
                    grant = self.stopped_grant(&run, proof).await?;
                }
            }
        }
    }

    async fn stopped_grant(
        &self,
        run: &orkestr_v2_contracts::RunId,
        proof: ReapedBroker,
    ) -> Result<BoundSessionMetadata, &'static str> {
        if self.config.worker.is_some() {
            return self.worker_stopped_grant(run, proof).await;
        }
        self.current().await?;
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, &self.config.conversation_id)
            .await
            .map_err(|_| "execution bindings unavailable")?
            .deep;
        self.store
            .authorize_stopped_session_metadata(&self.token, run, &binding)
            .await
            .map_err(|_| "execution stopped-session continuation refused")
    }

    async fn drive_session(
        &self,
        ready: ReadyCodex,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<SessionExit, &'static str> {
        let conversation = &self.config.conversation_id;
        let Some(capability) = self
            .next_with_liveness(shutdown, heartbeat, || {
                ready
                    .check_broker_liveness()
                    .map_err(|_| "execution ready broker exited; reconciliation required")
            })
            .await?
        else {
            return Ok(SessionExit::Shutdown);
        };
        let mut run = capability.provider().run.run_id.clone();
        let mut liveness = liveness::RunningLease::capture(&self.store, &capability).await?;
        let steering_authority = self
            .store
            .authorize_codex_steering(&capability)
            .await
            .map_err(|_| "execution steering issuer refused")?;
        let mut worker = self.prepare_worker(&capability)?;
        let (mut authority, mut pump) = ready
            .attach(self.store.clone(), capability)
            .map_err(|_| "execution attachment is uncertain; automatic replay refused")?;
        let (mut run_control, mut controls) = self
            .control
            .register(self.store.clone(), &run)
            .map_err(|_| "execution control registration refused")?;
        let mut steering = steering::RunningSteering::register(&run_control, steering_authority)?;
        let mut budget = self.config.execution_budget.start(Instant::now());
        loop {
            self.maintain(heartbeat).await?;
            // Parent Stop serializes against both its own pump and a bounded
            // Worker step. Lock order is always Deep then Worker.
            let schedule = run_control.serialize().await;
            let status = self
                .store
                .execution_status(&self.owner, conversation)
                .await
                .map_err(|_| "execution status unavailable")?
                .ok_or("execution status missing")?;
            if status.run_id.as_ref() != Some(&run) {
                return Err("execution scope changed; reconciliation required");
            }
            run_control
                .set_available(status.phase == ExecutionPhase::Running && pump.pending().is_none());
            if status.phase == ExecutionPhase::CancelRequested {
                steering.retire();
                run_control.disable();
                drop(schedule);
                Self::quiesce_worker(&mut worker);
                let proof = self
                    .stop_owned(&mut controls, authority, pump, &run, heartbeat)
                    .await?;
                self.drain_worker(&mut worker, heartbeat).await?;
                return Ok(SessionExit::Stopped { run, proof });
            }
            if status.phase == ExecutionPhase::Completed {
                steering.retire();
                drop(schedule);
                // The previous parent's scheduler cannot survive into a new
                // Deep grant, including while the next inbox input is awaited.
                self.drain_worker(&mut worker, heartbeat).await?;
                if self.window.as_ref().is_some_and(|window| window.work_due()) {
                    let retiring = pump
                        .retire_broker()
                        .map_err(|_| "window accepted retirement refused")?;
                    drop(authority);
                    let proof = self.reaped(retiring, &run, heartbeat).await?;
                    self.retire_terminal(&run, proof).await?;
                    return Ok(SessionExit::Shutdown);
                }
                // Only explicit committed owner acceptance releases the binding.
                // Inputs received during an active turn remain ordered in Core;
                // neither queued text nor browser JSON can mint a new capability.
                let Some(capability) = self
                    .next_with_liveness(shutdown, heartbeat, || {
                        pump.check_broker_liveness().map_err(|_| {
                            "execution accepted broker exited; reconciliation required"
                        })
                    })
                    .await?
                else {
                    // Owner acceptance is durable, but replacement still needs
                    // this exact native tree's cleanup witness before retirement.
                    let retiring = pump
                        .retire_broker()
                        .map_err(|_| "execution accepted-session retirement refused")?;
                    drop(authority);
                    let proof = self.reaped(retiring, &run, heartbeat).await?;
                    self.retire_terminal(&run, proof).await?;
                    return Ok(SessionExit::Shutdown);
                };
                run = capability.provider().run.run_id.clone();
                liveness = liveness::RunningLease::capture(&self.store, &capability).await?;
                let steering_authority = self
                    .store
                    .authorize_codex_steering(&capability)
                    .await
                    .map_err(|_| "execution steering issuer refused")?;
                worker = self.prepare_worker(&capability)?;
                let (next_authority, next_pump) = pump
                    .attach_next(self.store.clone(), capability)
                    .map_err(|_| "execution continuation is uncertain; automatic replay refused")?;
                // The typed transfer retired the old local authority atomically.
                // Revoking a retained handle cannot signal the transferred child.
                let _ = authority.revoke();
                authority = next_authority;
                pump = next_pump;
                (run_control, controls) = self
                    .control
                    .register(self.store.clone(), &run)
                    .map_err(|_| "execution control registration refused")?;
                steering = steering::RunningSteering::register(&run_control, steering_authority)?;
                budget = self.config.execution_budget.start(Instant::now());
                continue;
            }
            if status.phase == ExecutionPhase::AwaitingAcceptance {
                steering.retire();
                pump.check_broker_liveness()
                    .map_err(|_| "execution proposal broker exited; reconciliation required")?;
                // The proposal has fenced descendants. Keep driving their bounded
                // terminal cleanup while owner acceptance remains pending.
                Self::poll_worker(&mut worker).await;
                drop(schedule);
                if self.window.as_ref().is_some_and(|window| window.work_due()) {
                    let retiring = pump
                        .retire_broker()
                        .map_err(|_| "window proposal cleanup refused")?;
                    drop(authority);
                    let proof = self.reaped(retiring, &run, heartbeat).await?;
                    self.wait_window_acceptance(&run, proof, heartbeat, shutdown)
                        .await?;
                    return Ok(SessionExit::Shutdown);
                }
                // Hold the same child while the owner decides. No old execution
                // fence is spent and no subsequent inbox item is claimed early.
                if *shutdown.borrow() {
                    // Owner acceptance can commit after the phase sampled above
                    // and before shutdown is observed. Keep the original pump
                    // until a post-shutdown read decides whether it must retire.
                    let current = self
                        .store
                        .execution_status(&self.owner, conversation)
                        .await
                        .map_err(|_| "execution shutdown status unavailable")?
                        .ok_or("execution shutdown status missing")?;
                    if current.run_id.as_ref() != Some(&run) {
                        return Err("execution shutdown scope changed");
                    }
                    if current.phase == ExecutionPhase::Completed {
                        continue;
                    }
                    break;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                    _ = shutdown.changed() => {},
                }
                continue;
            }
            if matches!(
                status.phase,
                ExecutionPhase::Failed | ExecutionPhase::Blocked | ExecutionPhase::Cancelled
            ) {
                // Drop only this owned child. CancelRequested remains unknown;
                // killing a local helper is never reported as provider Stopped.
                break;
            }
            let cancellation = if self.window.as_ref().is_some_and(|window| window.work_due()) {
                Some("execution-window-work-deadline")
            } else if *shutdown.borrow() {
                Some("isolated-runtime-shutdown")
            } else {
                budget.cancellation_key(Instant::now())
            };
            if let Some(key) = cancellation {
                steering.retire();
                // Fence durably before local child cleanup; no success is inferred.
                let receipt = self
                    .store
                    .request_cancel(&self.owner, &run, key)
                    .await
                    .map_err(|_| "execution shutdown requires reconciliation")?;
                run_control.disable();
                run_control
                    .publish(receipt)
                    .map_err(|_| "execution shutdown handoff requires reconciliation")?;
                drop(schedule);
                Self::quiesce_worker(&mut worker);
                let proof = self
                    .stop_owned(&mut controls, authority, pump, &run, heartbeat)
                    .await?;
                self.drain_worker(&mut worker, heartbeat).await?;
                return Ok(SessionExit::Stopped { run, proof });
            }
            Self::poll_worker(&mut worker).await;
            if pump.pending().is_none() {
                pump.flush().map_err(|_| "execution write fence refused")?;
            }
            let committed = match pump.step(&self.store).await {
                Ok(committed) => committed,
                Err(orkestr_runtime::supervisor::Error::Store(
                    RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
                )) => false,
                Err(_) => return Err("execution observation refused; reconciliation required"),
            };
            let phase = if committed {
                budget.observed(Instant::now());
                // A committed proposal/terminal event may change phase during
                // this step. Publish availability from that result before HTTP
                // acquires the same lock, not from the pre-step Running sample.
                let current = self
                    .store
                    .execution_status(&self.owner, conversation)
                    .await
                    .map_err(|_| "execution status unavailable")?
                    .ok_or("execution status missing")?;
                if current.run_id.as_ref() != Some(&run) {
                    return Err("execution scope changed; reconciliation required");
                }
                current.phase
            } else {
                status.phase
            };
            steering
                .tick(&self.store, &mut pump, phase == ExecutionPhase::Running)
                .await?;
            if phase == ExecutionPhase::Running
                && liveness.due(Instant::now())
                && pump.renewal_quiescent()
            {
                // Same scheduling lock as HTTP Stop and provider observation.
                // Core rechecks auth/state inside the sealed transition. The
                // transfer preserves this exact child, turn and event cursor.
                // Keep selection available while HTTP waits on this lock;
                // explicitly disable it before releasing a failed transfer.
                let (next_authority, next_pump) = match steering
                    .renew(self.store.clone(), pump, &mut liveness)
                    .await
                {
                    Ok(refreshed) => refreshed,
                    Err(reason) => {
                        run_control.disable();
                        return Err(reason);
                    }
                };
                let _ = authority.revoke();
                authority = next_authority;
                pump = next_pump;
            }
            // A persistence retry may retain an observation during this step.
            // Refuse new control handoff until that exact evidence is committed.
            run_control.set_available(phase == ExecutionPhase::Running && pump.pending().is_none());
            drop(schedule);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => {},
            }
        }
        self.drain_worker(&mut worker, heartbeat).await?;
        let _ = authority.revoke();
        drop(pump);
        Ok(SessionExit::Shutdown)
    }
}
