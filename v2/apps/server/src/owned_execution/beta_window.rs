//! Factory consuming a bound private window, without a token-file bootstrap.
use super::*;
use crate::{beta_config::BetaConfig, window_runtime::context::Context};
use std::{sync::Arc, time::Instant};

impl ConfiguredExecution {
    pub(crate) fn from_window(
        home: &Path,
        config: &BetaConfig,
        store: Store,
        token: String,
        grant: BoundSessionMetadata,
        context: Arc<Context>,
        resumed: bool,
    ) -> Result<Self, &'static str> {
        config.validate()?;
        let directory = if resumed {
            directory::existing_for(home, &config.conversation_id)?
        } else {
            directory::create_for(home, &config.conversation_id)?
        };
        let owner = config.owner_id.clone();
        Ok(Self {
            config: Config {
                schema_version: 1,
                mode: "isolated_acceptance".into(),
                conversation_id: config.conversation_id.clone(),
                machine_token_file: PathBuf::new(),
                launcher: config.launcher.clone(),
                launcher_sha256: config.launcher_sha256.clone(),
                workspace: config.workspace.clone(),
                workspace_authority: None,
                namespace: config.namespace.clone(),
                supervisor_key: config.supervisor_key.clone(),
                provider: config::Provider::Codex,
                role: config::ExecutionRole::Deep,
                execution_budget: budget::ExecutionBudget {
                    max_run_ms: 870_000,
                    max_idle_ms: None,
                },
                worker: None,
            },
            store,
            token,
            directory,
            control: crate::control_registry::ControlRegistry::new(
                owner.clone(),
                config.conversation_id.clone(),
            ),
            tasks: crate::worker_tasks::WorkerTaskAccess::new(
                owner.clone(),
                config.conversation_id.clone(),
            ),
            worker_reaps: crate::worker_execution::WorkerReaps::new(
                owner.clone(),
                config.conversation_id.clone(),
                config.namespace.clone(),
            ),
            owner,
            children: crate::owned_children::ChildSet::default(),
            offline_python: None,
            initial_grant: Some(grant),
            workspace_grant: None,
            window_workers: config.roles.as_ref().map(|roles| {
                crate::worker_execution::WindowWorkers::new(context.clone(), roles.workers.clone())
            }),
            window: Some(context),
        })
    }
}

impl ConfiguredExecution {
    /// No provider transport survives this wait. The original native-tree witness
    /// remains owned here until a separately authenticated owner decision.
    pub(super) async fn wait_window_acceptance(
        &self,
        run: &orkestr_v2_contracts::RunId,
        proof: orkestr_runtime::containment::ReapedBroker,
        heartbeat: &mut Instant,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        self.window
            .as_ref()
            .ok_or("window context missing")?
            .begin_retirement(&self.store, &self.token)
            .await?;
        loop {
            if *shutdown.borrow() {
                return Err("late owner wait interrupted; reconciliation required");
            }
            // Metadata-only lease maintenance: the provider tree is already reaped.
            self.maintain(heartbeat).await?;
            let status = self
                .store
                .execution_status(&self.owner, &self.config.conversation_id)
                .await
                .map_err(|_| "late owner status unavailable")?
                .ok_or("late owner status missing")?;
            if status.run_id.as_ref() != Some(run) {
                return Err("late owner run changed");
            }
            match status.phase {
                orkestr_v2_contracts::ExecutionPhase::Completed => {
                    return self.retire_terminal(run, proof).await
                }
                orkestr_v2_contracts::ExecutionPhase::AwaitingAcceptance => {}
                _ => return Err("late owner decision is not canonical acceptance"),
            }
            wait_metadata_tick(shutdown).await?;
        }
    }
}

// The metadata wait has no transport or dispatch capability.
async fn wait_metadata_tick(shutdown: &mut watch::Receiver<bool>) -> Result<(), &'static str> {
    if *shutdown.borrow() {
        return Err("late owner wait interrupted; reconciliation required");
    }
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(100)) => Ok(()),
        _ = shutdown.changed() => Err("late owner wait interrupted; reconciliation required"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_interrupts_metadata_wait_without_waiting_for_owner() {
        let (sender, mut receiver) = watch::channel(false);
        let wait = wait_metadata_tick(&mut receiver);
        let signal = async {
            tokio::task::yield_now().await;
            sender.send(true).unwrap();
        };
        let (result, ()) = tokio::join!(wait, signal);
        assert!(result.is_err());
        assert!(wait_metadata_tick(&mut receiver).await.is_err());
    }
}
