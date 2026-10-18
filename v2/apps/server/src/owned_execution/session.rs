//! Supervisor-owned session lifecycle; no browser-selected authority or transport.
use super::*;
use orkestr_runtime::{containment::ChildDirectories, execution::PreparingCodex};
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::ExecutionPhase;
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn run(self, mut shutdown: watch::Receiver<bool>) -> Result<(), &'static str> {
        let _availability = self.control.lifetime();
        self.current().await?;
        self.config.verify_launcher()?;
        let conversation = &self.config.conversation_id;
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, conversation)
            .await
            .map_err(|_| "execution bindings unavailable")?
            .deep;
        let grant = self
            .store
            .authorize_session_metadata(&binding)
            .await
            .map_err(|_| "execution setup authority refused")?;
        let directories = ChildDirectories::new(
            &self.config.workspace,
            &self.directory.join("home"),
            &self.directory.join("tmp"),
        )
        .map_err(|_| "execution child directories unavailable")?;
        // The metadata fence rechecks current authority at the actual child spawn.
        let mut setup = PreparingCodex::open(
            self.store.clone(),
            grant,
            &self.config.launcher,
            &self.config.workspace,
            directories,
        )
        .map_err(|_| "execution broker setup refused")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            self.current().await?;
            if setup
                .poll()
                .map_err(|_| "execution broker readiness refused")?
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("execution broker readiness timed out");
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => return Ok(()),
            }
        }
        let ready = setup
            .confirm()
            .await
            .map_err(|_| "execution readiness commit refused")?;
        let mut heartbeat = Instant::now();
        let Some(capability) = self.next(&mut shutdown, &mut heartbeat).await? else {
            return Ok(());
        };
        let mut run = capability.provider().run.run_id.clone();
        let mut worker = self.prepare_worker(&capability)?;
        let (mut authority, mut pump) = ready
            .attach(self.store.clone(), capability)
            .map_err(|_| "execution attachment is uncertain; automatic replay refused")?;
        let (mut control_sender, mut controls) = self.control.register(self.store.clone(), &run)?;
        let mut deadline = Instant::now() + Duration::from_secs(45);
        loop {
            self.maintain(&mut heartbeat).await?;
            Self::poll_worker(&mut worker).await;
            let schedule = self.control.serialize().await;
            let status = self
                .store
                .execution_status(&self.owner, conversation)
                .await
                .map_err(|_| "execution status unavailable")?
                .ok_or("execution status missing")?;
            if status.run_id.as_ref() != Some(&run) {
                return Err("execution scope changed; reconciliation required");
            }
            self.control.set_available(
                &run,
                status.phase == ExecutionPhase::Running && pump.pending().is_none(),
            );
            if status.phase == ExecutionPhase::CancelRequested {
                drop(schedule);
                drop(worker.take());
                return self
                    .stop_owned(&mut controls, authority, pump, &mut heartbeat)
                    .await;
            }
            if status.phase == ExecutionPhase::Completed {
                drop(schedule);
                // The previous parent's scheduler cannot survive into a new
                // Deep grant, including while the next inbox input is awaited.
                drop(worker.take());
                // Only explicit committed owner acceptance releases the binding.
                // Inputs received during an active turn remain ordered in Core;
                // neither queued text nor browser JSON can mint a new capability.
                let Some(capability) = self.next(&mut shutdown, &mut heartbeat).await? else {
                    break;
                };
                run = capability.provider().run.run_id.clone();
                worker = self.prepare_worker(&capability)?;
                let (next_authority, next_pump) = pump
                    .attach_next(self.store.clone(), capability)
                    .map_err(|_| "execution continuation is uncertain; automatic replay refused")?;
                // The typed transfer retired the old local authority atomically.
                // Revoking a retained handle cannot signal the transferred child.
                let _ = authority.revoke();
                authority = next_authority;
                pump = next_pump;
                (control_sender, controls) = self.control.register(self.store.clone(), &run)?;
                deadline = Instant::now() + Duration::from_secs(45);
                continue;
            }
            if status.phase == ExecutionPhase::AwaitingAcceptance {
                drop(schedule);
                // Hold the same child while the owner decides. No old execution
                // fence is spent and no subsequent inbox item is claimed early.
                if *shutdown.borrow() {
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
            if *shutdown.borrow() || Instant::now() >= deadline {
                // Fence durably before local child cleanup; no success is inferred.
                let receipt = self
                    .store
                    .request_cancel(&self.owner, &run, "isolated-runtime-shutdown")
                    .await
                    .map_err(|_| "execution shutdown requires reconciliation")?;
                self.control.disable();
                control_sender
                    .publish(receipt)
                    .map_err(|_| "execution shutdown handoff requires reconciliation")?;
                drop(schedule);
                drop(worker.take());
                return self
                    .stop_owned(&mut controls, authority, pump, &mut heartbeat)
                    .await;
            }
            if pump.pending().is_none() {
                pump.flush().map_err(|_| "execution write fence refused")?;
            }
            match pump.step(&self.store).await {
                Ok(_) => {}
                Err(orkestr_runtime::supervisor::Error::Store(
                    RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
                )) => {}
                Err(_) => return Err("execution observation refused; reconciliation required"),
            }
            drop(schedule);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => {},
            }
        }
        let _ = authority.revoke();
        drop(pump);
        Ok(())
    }
}
