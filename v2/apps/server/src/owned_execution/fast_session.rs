//! Same-child continuation, exact-run Stop, and bounded Fast presentation work.
use super::*;
use crate::{
    control_dispatch::ControlReceiver, fast_execution::LiveFast, stop_execution::StopProgress,
};
use orkestr_runtime::containment::ReapedBroker;
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::{ExecutionPhase, RunId};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn drive_fast(
        &self,
        mut live: Box<LiveFast>,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
        auxiliary: bool,
    ) -> Result<fast::FastExit, &'static str> {
        let mut run = live.run_id().clone();
        let (mut control, mut controls) = self
            .control
            .register(self.store.clone(), &run)
            .map_err(|_| "Fast control registration refused")?;
        let mut budget = self.config.execution_budget.start(Instant::now());
        let mut renew_at = Instant::now() + Duration::from_secs(20);
        loop {
            self.maintain(heartbeat).await?;
            let schedule = control.serialize().await;
            let status = self.fast_status(&run).await?;
            control
                .set_available(status.phase == ExecutionPhase::Running && live.pending().is_none());
            match status.phase {
                ExecutionPhase::CancelRequested => {
                    control.disable();
                    drop(schedule);
                    let proof = self
                        .stop_fast(&mut controls, *live, &run, heartbeat)
                        .await?;
                    return Ok(fast::FastExit::Stopped { run, proof });
                }
                ExecutionPhase::Completed => {
                    control.disable();
                    drop(schedule);
                    // An idle window Fast whose native dies (OOM, resource
                    // monitor) rotates to a fresh session instead of ending
                    // Fast for the rest of the window. Only the broker's own
                    // native-ended ECHILD exit proves the old tree is gone.
                    let window = self.window.is_some();
                    let ended = AtomicBool::new(false);
                    let waited = self
                        .fast_input_checked(shutdown, heartbeat, || {
                            if window && live.idle_broker_exited() {
                                ended.store(true, Ordering::Release);
                                return Err("Fast idle broker exited");
                            }
                            live.check_broker_liveness()
                        })
                        .await;
                    let input = match waited {
                        Err(_) if ended.load(Ordering::Acquire) => {
                            return self.rotate_ended_fast(live, run, heartbeat).await;
                        }
                        other => other?,
                    };
                    if window && live.idle_broker_exited() {
                        // Died after the source was selected: nothing was
                        // admitted yet, so the input stays eligible.
                        return self.rotate_ended_fast(live, run, heartbeat).await;
                    }
                    if window {
                        // Keep the accepted native child warm for the next
                        // owner input of this same window (and conversation).
                        // Core decides reuse: same window incarnation, accepted
                        // non-timer turns only, capped turn count. Otherwise
                        // reap the exact child and let the caller close
                        // normally or issue a fresh bounded Fast setup.
                        let reuse = match &input {
                            Some(input) => self.fast_reusable(input).await,
                            None => false,
                        };
                        if !reuse {
                            let retiring = live
                                .retire_accepted(&self.token)
                                .await
                                .map_err(|_| "Fast accepted-session retirement refused")?;
                            let proof = self.reaped(retiring, &run, heartbeat).await?;
                            return Ok(fast::FastExit::Accepted { run, proof });
                        }
                    }
                    let Some(input) = input else {
                        let retiring = live
                            .retire_accepted(&self.token)
                            .await
                            .map_err(|_| "Fast accepted-session retirement refused")?;
                        let proof = self.reaped(retiring, &run, heartbeat).await?;
                        self.retire_terminal(&run, proof).await?;
                        return Ok(fast::FastExit::Shutdown);
                    };
                    live =
                        fast::started(live.continue_accepted(&self.token, &input).await.map_err(
                            |_| "Fast continuation uncertain; automatic replay refused",
                        )?)?;
                    run = live.run_id().clone();
                    (control, controls) = self
                        .control
                        .register(self.store.clone(), &run)
                        .map_err(|_| "Fast continuation controls refused")?;
                    budget = self.config.execution_budget.start(Instant::now());
                    renew_at = Instant::now() + Duration::from_secs(20);
                    continue;
                }
                ExecutionPhase::AwaitingAcceptance => {
                    control.disable();
                    drop(schedule);
                    live.check_broker_liveness()?;
                    if self.window.is_some() && self.fast_window_due() {
                        if let Some(companion) = &self.companion {
                            companion.retire();
                        }
                        let retiring = live
                            .retire_for_owner_decision(&self.token)
                            .await
                            .map_err(|_| "Fast proposal cleanup refused")?;
                        let proof = self.reaped(retiring, &run, heartbeat).await?;
                        if auxiliary {
                            // The slot retires its own session with this witness.
                            self.await_fast_accepted(&run, heartbeat, shutdown).await?;
                            return Ok(fast::FastExit::Accepted { run, proof });
                        }
                        self.wait_fast_acceptance(&run, proof, heartbeat, shutdown)
                            .await?;
                        return Ok(fast::FastExit::Shutdown);
                    }
                    if *shutdown.borrow() {
                        if self.fast_status(&run).await?.phase == ExecutionPhase::Completed {
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
                ExecutionPhase::Failed | ExecutionPhase::Blocked | ExecutionPhase::Cancelled => {
                    break
                }
                ExecutionPhase::Starting | ExecutionPhase::Running => {}
                ExecutionPhase::Queued => return Err("Fast exact run cannot be an inbox queue"),
            }
            let cancellation = if self.fast_window_due() {
                Some("execution-window-work-deadline")
            } else if *shutdown.borrow() {
                Some("isolated-fast-shutdown")
            } else {
                budget.cancellation_key(Instant::now())
            };
            if let Some(key) = cancellation {
                let receipt = self
                    .store
                    .request_cancel(&self.owner, &run, key)
                    .await
                    .map_err(|_| "Fast shutdown requires reconciliation")?;
                control.disable();
                control
                    .publish(receipt)
                    .map_err(|_| "Fast shutdown handoff refused")?;
                drop(schedule);
                let proof = self
                    .stop_fast(&mut controls, *live, &run, heartbeat)
                    .await?;
                return Ok(fast::FastExit::Stopped { run, proof });
            }
            let committed = match live.tick().await {
                Ok(value) => value,
                Err(orkestr_runtime::supervisor::Error::Store(
                    RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
                )) => false,
                Err(error) => {
                    super::observation_refused("Fast", &error);
                    return Err("Fast observation refused; reconciliation required");
                }
            };
            let phase = if committed {
                budget.observed(Instant::now());
                self.fast_status(&run).await?.phase
            } else {
                status.phase
            };
            if phase == ExecutionPhase::Running
                && Instant::now() >= renew_at
                && live.renewal_quiescent()
            {
                if live.renew().await.is_err() {
                    control.disable();
                    return Err("Fast lease transfer refused; reconciliation required");
                }
                renew_at = Instant::now() + Duration::from_secs(20);
            }
            control.set_available(phase == ExecutionPhase::Running && live.pending().is_none());
            drop(schedule);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => {},
            }
        }
        live.quarantine();
        if self.window.is_some() {
            return Err("Fast window terminal remains unresolved");
        }
        Ok(fast::FastExit::Shutdown)
    }

    /// Reap the already-exited idle Fast broker on its own ECHILD evidence
    /// and hand the witness to the caller's ordinary fresh-setup rotation.
    async fn rotate_ended_fast(
        &self,
        live: Box<LiveFast>,
        run: RunId,
        heartbeat: &mut Instant,
    ) -> Result<fast::FastExit, &'static str> {
        let retiring = match live.retire_ended_accepted(&self.token).await {
            Ok(retiring) => retiring,
            Err(_) => return Err("Fast broker exited"),
        };
        let proof = self.reaped(retiring, &run, heartbeat).await?;
        eprintln!("owned window Fast idle native ended; reaped, next input starts a fresh session");
        Ok(fast::FastExit::Accepted { run, proof })
    }

    /// Advisory only: any doubt (including a busy or unavailable Store) means
    /// rotate to a fresh bounded presentation, never a failed companion.
    async fn fast_reusable(&self, input: &orkestr_v2_store_sqlite::FastAdmissionInput) -> bool {
        let Ok(bindings) = self
            .store
            .ensure_role_bindings(&self.owner, &self.config.conversation_id)
            .await
        else {
            return false;
        };
        let binding = bindings.fast;
        if binding.session_id != input.fast_binding_id
            || binding.generation != input.expected_binding_generation
            || binding.conversation_id != self.config.conversation_id
        {
            return false;
        }
        self.store
            .bounded_fast_reusable(&self.token, &binding, &input.source_event_id)
            .await
            .unwrap_or(false)
    }

    pub(super) async fn fast_status(
        &self,
        run: &RunId,
    ) -> Result<orkestr_v2_contracts::ExecutionStatus, &'static str> {
        let status = self
            .store
            .execution_run_status(&self.token, &self.owner, &self.config.conversation_id, run)
            .await
            .map_err(|_| "Fast exact status unavailable")?
            .ok_or("Fast run is missing")?;
        if status.run_id.as_ref() != Some(run)
            || status.conversation_id != self.config.conversation_id
            || !status.is_valid()
        {
            return Err("Fast execution scope changed");
        }
        Ok(status)
    }

    async fn stop_fast(
        &self,
        controls: &mut ControlReceiver,
        live: LiveFast,
        run: &RunId,
        heartbeat: &mut Instant,
    ) -> Result<ReapedBroker, &'static str> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let pending = loop {
            self.maintain(heartbeat).await?;
            if let Some(pending) = controls
                .take()
                .map_err(|_| "Fast control handoff refused")?
            {
                break pending;
            }
            if Instant::now() >= deadline {
                return Err("Fast cancellation requires reconciliation");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        let mut active = live
            .stopping(pending)
            .map_err(|_| "Fast interruption requires reconciliation")?;
        loop {
            self.maintain(heartbeat).await?;
            match active.tick().await {
                StopProgress::Stopped => {
                    let retiring = active
                        .retire_broker()
                        .map_err(|_| "Fast Stop retirement refused")?;
                    return self.reaped(retiring, run, heartbeat).await;
                }
                StopProgress::ReconciliationRequired => {
                    return Err("Fast Stop remains unconfirmed")
                }
                StopProgress::Pending | StopProgress::InterruptAcknowledged => {}
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
