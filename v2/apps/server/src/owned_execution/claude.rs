//! Selected Claude turn through the ordinary server. Setup ACK is only
//! protocol readiness; Runtime/Core persist matching native init before Started.
use super::*;
use crate::{
    claude_execution::{LiveClaudeExecution, PreparingClaudeExecution, ReadyClaudeExecution},
    control_dispatch::{ControlReceiver, PendingControl},
    control_registry::RunControl,
    stop_execution::StopProgress,
};
use orkestr_runtime::containment::ChildDirectories;
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::ExecutionPhase;
use std::time::Instant;

impl PendingControl {
    /// Consume only the exact mailbox receipt with the already-owned lifecycle.
    fn dispatch_claude(
        self,
        live: LiveClaudeExecution,
    ) -> Result<crate::claude_execution::ClaudeStopExecution, orkestr_runtime::execution::StopFailure>
    {
        self.dispatch_provider(|receipt| live.into_stopping(receipt))
    }
}

pub(super) enum ClaudeExit {
    Accepted(
        orkestr_v2_contracts::RunId,
        orkestr_runtime::containment::ReapedBroker,
    ),
    Stopped(
        orkestr_v2_contracts::RunId,
        orkestr_runtime::containment::ReapedBroker,
    ),
    /// Execution window reached its work deadline with a proposal pending;
    /// the late owner decision already retired the window.
    WindowClosed,
}

impl ConfiguredExecution {
    pub(super) async fn drive_claude(
        &self,
        ready: ReadyClaudeExecution,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<ClaudeExit>, &'static str> {
        // Uses the same current-owner claim/admit/reserve/one-use consumption
        // path as Codex. Provider/account selectors never come from HTTP input.
        let Some(capability) = self.next(shutdown, heartbeat).await? else {
            return Ok(None);
        };
        self.drive_claude_capability(ready, capability, shutdown, heartbeat)
            .await
    }

    /// Exact status of this factory's role: the conversation's Deep status,
    /// or the exact Fast run's status for a Fast companion.
    async fn claude_status(
        &self,
        run: &orkestr_v2_contracts::RunId,
    ) -> Result<orkestr_v2_contracts::ExecutionStatus, &'static str> {
        if self.config.role == super::config::ExecutionRole::Fast {
            return self.fast_status(run).await;
        }
        self.store
            .execution_status(&self.owner, &self.config.conversation_id)
            .await
            .map_err(|_| "Claude status unavailable")?
            .ok_or("Claude status missing")
    }

    /// Window work for this role is due (the Fast companion also yields to
    /// its Deep owner's retirement).
    fn claude_window_due(&self) -> bool {
        if self.config.role == super::config::ExecutionRole::Fast {
            return self.fast_window_due();
        }
        self.window.as_ref().is_some_and(|window| window.work_due())
    }

    pub(super) async fn drive_claude_capability(
        &self,
        ready: ReadyClaudeExecution,
        capability: Box<orkestr_v2_store_sqlite::ConsumedProviderDispatch>,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<ClaudeExit>, &'static str> {
        let run = capability.provider().run.run_id.clone();
        // Capture before the consumed grant moves into Runtime, as for Codex.
        let mut liveness = super::liveness::RunningLease::capture(&self.store, &capability).await?;
        let mut live = ready
            .attach(capability)
            .map_err(|_| "Claude attachment uncertain; automatic replay refused")?;
        let (run_control, mut controls) = self
            .control
            .register(self.store.clone(), &run)
            .map_err(|_| "Claude control registration refused")?;
        let mut budget = self.config.execution_budget.start(Instant::now());
        loop {
            let schedule = run_control.serialize().await;
            self.maintain(heartbeat).await?;
            let status = self.claude_status(&run).await?;
            if status.run_id.as_ref() != Some(&run) {
                return Err("Claude scope changed; reconciliation required");
            }
            run_control.set_available(status.phase == ExecutionPhase::Running && live.can_stop());
            if *shutdown.borrow()
                && matches!(
                    status.phase,
                    ExecutionPhase::Starting
                        | ExecutionPhase::Running
                        | ExecutionPhase::CancelRequested
                )
            {
                run_control.disable();
                self.store
                    .request_cancel(&self.owner, &run, "isolated-runtime-shutdown")
                    .await
                    .map_err(|_| "Claude shutdown fence requires reconciliation")?;
                // Drop the owned live session into cleanup without asserting a
                // native terminal or waiting for the user Stop observer.
                return Ok(None);
            }
            match status.phase {
                ExecutionPhase::Completed => {
                    // Consume the exact completed pump before opening a new
                    // child. Neither a projection nor local exit proves reap.
                    let retiring = live
                        .retire_completed()
                        .map_err(|_| "Claude accepted-session retirement refused")?;
                    let proof = self.reaped(retiring, &run, heartbeat).await?;
                    return Ok(Some(ClaudeExit::Accepted(run, proof)));
                }
                ExecutionPhase::AwaitingAcceptance => {
                    // Preserve the proposal and child while the owner decides;
                    // never read late provider frames or claim a queued input.
                    if *shutdown.borrow() {
                        return Ok(None);
                    }
                    if self.claude_window_due() {
                        // Same as Codex: reap the transport, then wait for the
                        // owner's decision metadata-only and retire the window.
                        drop(schedule);
                        let retiring = live
                            .retire_completed()
                            .map_err(|_| "window proposal cleanup refused")?;
                        let proof = self.reaped(retiring, &run, heartbeat).await?;
                        if self.config.role == super::config::ExecutionRole::Fast {
                            self.wait_fast_acceptance(&run, proof, heartbeat, shutdown)
                                .await?;
                        } else {
                            self.wait_window_acceptance(&run, proof, heartbeat, shutdown)
                                .await?;
                        }
                        return Ok(Some(ClaudeExit::WindowClosed));
                    }
                }
                ExecutionPhase::Failed | ExecutionPhase::Blocked | ExecutionPhase::Cancelled => {
                    if status.failure.as_ref().is_some_and(|failure| {
                        failure.class == orkestr_v2_contracts::ExecutionFailureClass::Policy
                    }) {
                        // Dropping the owned pump starts real cleanup. This is
                        // a logical refusal, never a fabricated native result.
                        return Err("Claude provider policy refusal");
                    }
                    return Err("Claude execution requires reconciliation");
                }
                ExecutionPhase::CancelRequested => {
                    run_control.disable();
                    drop(schedule);
                    let proof = self
                        .stop_claude(&run_control, &mut controls, live, &run, heartbeat, shutdown)
                        .await?;
                    return Ok(Some(ClaudeExit::Stopped(run, proof)));
                }
                ExecutionPhase::Starting | ExecutionPhase::Running => {
                    if self.config.role != super::config::ExecutionRole::Fast {
                        self.extend_window_while_working().await;
                    }
                    let cancellation = if self.claude_window_due() {
                        Some("execution-window-work-deadline")
                    } else {
                        budget.cancellation_key(Instant::now())
                    };
                    if let Some(key) = cancellation {
                        // Budget expiry uses the same issued control as
                        // owner Stop; no status-derived receipt is constructed.
                        let receipt = self
                            .store
                            .request_cancel(&self.owner, &run, key)
                            .await
                            .map_err(|_| "Claude shutdown fence requires reconciliation")?;
                        run_control.disable();
                        run_control
                            .publish(receipt)
                            .map_err(|_| "Claude shutdown control handoff refused")?;
                        drop(schedule);
                        let proof = self
                            .stop_claude(
                                &run_control,
                                &mut controls,
                                live,
                                &run,
                                heartbeat,
                                shutdown,
                            )
                            .await?;
                        return Ok(Some(ClaudeExit::Stopped(run, proof)));
                    }
                    if status.phase == ExecutionPhase::Running
                        && liveness.due(Instant::now())
                        && live.renewal_quiescent()
                    {
                        // Same scheduling lock as HTTP Stop and observation.
                        if let Err(reason) = liveness.refresh_claude(&mut live).await {
                            run_control.disable();
                            return Err(reason);
                        }
                    }
                    match live.tick().await {
                        Ok(true) => budget.observed(Instant::now()),
                        Ok(false)
                        | Err(orkestr_runtime::supervisor::Error::Store(
                            RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
                        )) => {}
                        Err(error) => {
                            super::observation_refused("Claude", &error);
                            return Err("Claude observation refused; reconciliation required");
                        }
                    }
                }
                ExecutionPhase::Queued => return Err("Claude admitted run unexpectedly queued"),
            }
            // Refresh after a step: a pending observation or committed terminal
            // must disable fresh HTTP control before releasing this run's lock.
            let current = self.claude_status(&run).await?;
            if current.run_id.as_ref() != Some(&run) {
                return Err("Claude scope changed; reconciliation required");
            }
            run_control.set_available(current.phase == ExecutionPhase::Running && live.can_stop());
            drop(schedule);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => {},
            }
        }
        // LiveClaudeExecution Drop fences and transfers the owned child to the
        // reaper. ChildSet remains retained until actual wait; no fake Stopped.
    }

    async fn stop_claude(
        &self,
        control: &RunControl,
        controls: &mut ControlReceiver,
        live: LiveClaudeExecution,
        run: &orkestr_v2_contracts::RunId,
        heartbeat: &mut Instant,
        shutdown: &watch::Receiver<bool>,
    ) -> Result<orkestr_runtime::containment::ReapedBroker, &'static str> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let pending = loop {
            if *shutdown.borrow() {
                return Err("Claude shutdown cleanup remains unconfirmed");
            }
            self.maintain(heartbeat).await?;
            if let Some(pending) = controls
                .take()
                .map_err(|_| "Claude control handoff refused")?
            {
                break pending;
            }
            if Instant::now() >= deadline {
                return Err("Claude cancellation requires reconciliation");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        let mut stopping = pending
            .dispatch_claude(live)
            .map_err(|_| "Claude interruption requires reconciliation")?;
        loop {
            if *shutdown.borrow() {
                return Err("Claude shutdown cleanup remains unconfirmed");
            }
            let schedule = control.serialize().await;
            self.maintain(heartbeat).await?;
            match stopping.tick().await {
                StopProgress::Stopped => {
                    let proof = stopping
                        .into_reaped()
                        .map_err(|_| "Claude original tree reap is unconfirmed")?;
                    if proof.scope().owner() != self.owner.to_string()
                        || proof.scope().run() != run.to_string()
                        || proof.scope().namespace() != self.config.namespace
                    {
                        return Err("Claude retirement scope mismatch");
                    }
                    if !self.children.wait_empty(Duration::from_secs(2)).await {
                        return Err("Claude retained child resources remain active");
                    }
                    return Ok(proof);
                }
                StopProgress::ReconciliationRequired => {
                    return Err("Claude Stop remains unconfirmed")
                }
                StopProgress::Pending | StopProgress::InterruptAcknowledged => {}
            }
            drop(schedule);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub(super) async fn prepare_claude(
        &self,
        grant: BoundSessionMetadata,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<ReadyClaudeExecution>, &'static str> {
        self.maintain(heartbeat).await?;
        self.config.verify_launcher()?;
        if *shutdown.borrow() {
            return Ok(None);
        }
        let directories = ChildDirectories::new(
            &self.config.workspace,
            &self.directory.join("home"),
            &self.directory.join("tmp"),
        )
        .map_err(|_| "Claude child directories unavailable")?;
        // The owner's model/effort for this conversation apply from the next
        // native launch (each Claude turn is a new process), never mid-turn.
        let launch = self
            .store
            .conversation_turn_launch(&self.owner, &self.config.conversation_id)
            .await
            .map_err(|_| "Claude turn settings unavailable")?;
        let directories = if self.config.role == super::config::ExecutionRole::Fast {
            // Fast presents the input quickly: lowest effort, default model.
            directories
                .with_claude_launch(None, Some("low"))
                .map_err(|_| "Claude turn settings invalid")?
        } else if launch.provider == orkestr_v2_contracts::ConversationProvider::Claude {
            directories
                .with_claude_launch(launch.model.as_deref(), launch.reasoning_effort.as_deref())
                .map_err(|_| "Claude turn settings invalid")?
        } else {
            directories
        };
        let mut setup = if let Some(context) = &self.window {
            let store = self.store.clone();
            let launcher = self.config.launcher.clone();
            let resources = self.children.retain();
            let context = context.clone();
            tokio::task::spawn_blocking(move || {
                PreparingClaudeExecution::open_window_retained(
                    store,
                    grant,
                    &launcher,
                    directories,
                    resources,
                    move |child| context.bind(&child),
                )
            })
            .await
            .map_err(|_| "Claude window setup worker lost")?
        } else {
            PreparingClaudeExecution::open_retained(
                self.store.clone(),
                grant,
                &self.config.launcher,
                directories,
                self.children.retain(),
            )
        }
        .map_err(|_| "Claude broker setup refused")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if *shutdown.borrow() {
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
            if setup
                .poll_ready()
                .map_err(|_| "Claude protocol initialization refused")?
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("Claude protocol initialization timed out");
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => return Ok(None),
            }
        }
        let ready = setup
            .confirm()
            .await
            .map_err(|_| "Claude protocol readiness commit refused")?;
        // Deep activates the window once, after its Fast companion (if any)
        // has a ready native; the companion waits for that activation.
        if let Some(context) = self
            .window
            .as_ref()
            .filter(|_| self.config.role == super::config::ExecutionRole::Deep)
        {
            if !self
                .window_activated
                .swap(true, std::sync::atomic::Ordering::AcqRel)
            {
                self.wait_companion_setup(shutdown, heartbeat, true).await?;
                context
                    .activate_roles(
                        &self.store,
                        &self.token,
                        crate::execution_registry::ExecutionScope {
                            store: self.store.clone(),
                            control: Some(self.control.clone()),
                            tasks: None,
                        },
                        self.companion_scope(),
                    )
                    .await?;
                if let Some(companion) = &self.companion {
                    companion.activate();
                }
                self.wait_companion_setup(shutdown, heartbeat, false)
                    .await?;
            }
        }
        Ok(Some(ready))
    }
}
