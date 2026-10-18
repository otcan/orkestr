//! Supervisor-owned session lifecycle; no browser-selected authority or transport.
use super::*;
use orkestr_runtime::{containment::ChildDirectories, execution::PreparingCodex};
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::ExecutionPhase;
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn run(self, mut shutdown: watch::Receiver<bool>) -> Result<(), &'static str> {
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
        let run = capability.provider().run.run_id.clone();
        let (authority, mut pump) = ready
            .attach(self.store.clone(), capability)
            .map_err(|_| "execution attachment is uncertain; automatic replay refused")?;
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            self.maintain(&mut heartbeat).await?;
            let status = self
                .store
                .execution_status(&self.owner, conversation)
                .await
                .map_err(|_| "execution status unavailable")?
                .ok_or("execution status missing")?;
            if status.run_id.as_ref() != Some(&run) {
                return Err("execution scope changed; reconciliation required");
            }
            if matches!(
                status.phase,
                ExecutionPhase::AwaitingAcceptance | ExecutionPhase::Completed
            ) {
                // Hold the same child while the owner decides and after accepted
                // completion. No old execution fence is spent while quiescent.
                // The typed next-run attachment is supplied by Runtime separately.
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
                ExecutionPhase::Failed
                    | ExecutionPhase::Blocked
                    | ExecutionPhase::Cancelled
                    | ExecutionPhase::CancelRequested
            ) {
                // Drop only this owned child. CancelRequested remains unknown;
                // killing a local helper is never reported as provider Stopped.
                break;
            }
            if *shutdown.borrow() || Instant::now() >= deadline {
                // Fence durably before local child cleanup; no success is inferred.
                self.store
                    .request_cancel(&self.owner, &run, "isolated-runtime-shutdown")
                    .await
                    .map_err(|_| "execution shutdown requires reconciliation")?;
                break;
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
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => {},
            }
        }
        let _ = authority.revoke();
        drop(pump);
        // Until Runtime's typed next attachment is composed, no second dispatch
        // can be fabricated from this completed channel or its old capability.
        Ok(())
    }
}
