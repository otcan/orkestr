//! Explicit, one-conversation isolated acceptance composition. No HTTP configuration.
mod admission;
mod bootstrap;
mod config;
#[cfg(all(test, unix))]
mod config_tests;
mod directory;
mod retirement;
mod session;
mod stopping;
mod worker;
use config::Config;
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
};
use orkestr_v2_contracts::OwnerId;
use orkestr_v2_store_sqlite::{BoundSessionMetadata, Store};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};

/// Not serializable, clonable or constructible from a browser DTO.
pub struct ConfiguredExecution {
    config: Config,
    store: Store,
    owner: OwnerId,
    token: String,
    directory: PathBuf,
    control: crate::control_registry::ControlRegistry,
    children: crate::owned_children::ChildSet,
    initial_grant: Option<BoundSessionMetadata>,
}
pub struct ExecutionTask {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
    children: crate::owned_children::ChildSet,
}

impl ConfiguredExecution {
    /// No provider starts here. Validate local configuration and current machine
    /// session before issuing the trusted supervisor bound to the selected owner.
    pub async fn load(
        store: &Store,
        home: &Path,
        bind: SocketAddr,
        file: &Path,
    ) -> Result<Self, &'static str> {
        let config = Config::load(file, home, bind)?;
        let token = config.token(home)?;
        let owner = store
            .authenticate(&token)
            .await
            .map_err(|_| "execution authentication unavailable")?
            .ok_or("execution machine session is not current")?;
        let status = store
            .execution_status(&owner, &config.conversation_id)
            .await
            .map_err(|_| "execution conversation is unavailable to this owner")?;
        let mut supervisor = ProductionSupervisorConfig {
            provider: ProviderKind::Codex,
            namespace: config.namespace.clone(),
            supervisor_key: config.supervisor_key.clone(),
            takeover: ProductionTakeover::First,
        };
        let (bound, initial_grant, directory) = if let Some(status) = status {
            if status.phase != orkestr_v2_contracts::ExecutionPhase::Completed
                || config.worker.is_some()
            {
                return Err(
                    "existing execution requires reconciliation; automatic startup refused",
                );
            }
            // Discovery is read evidence only. Core requires the exact sealed
            // graceful-retirement record, not natural lease expiry or status.
            let (prior_run, incarnation_id) = store
                .terminal_supervisor_candidate(&token, &supervisor, &config.conversation_id)
                .await
                .map_err(|_| "execution restart discovery refused")?
                .ok_or("execution lacks graceful retirement; automatic startup refused")?;
            if status.run_id.as_ref() != Some(&prior_run) {
                return Err("execution restart predecessor changed");
            }
            let directory = directory::existing(home)?;
            supervisor.takeover = ProductionTakeover::ExpiredPredecessor { incarnation_id };
            let (bound, grant) = store
                .reattach_terminal_supervisor(&token, supervisor, &prior_run)
                .await
                .map_err(|_| "execution exact predecessor reattachment refused")?;
            (bound, Some(grant), directory)
        } else {
            let directory = directory::create(home)?;
            let bound = store
                .authorize_supervisor(&token, supervisor)
                .await
                .map_err(|_| "execution supervisor authorization refused")?;
            (bound, None, directory)
        };
        let control = crate::control_registry::ControlRegistry::new(
            owner.clone(),
            config.conversation_id.clone(),
        );
        Ok(Self {
            config,
            store: bound,
            owner,
            token,
            directory,
            control,
            children: crate::owned_children::ChildSet::default(),
            initial_grant,
        })
    }

    /// Install only this factory's bound Store and live transport availability.
    /// Neither handle is constructible through HTTP configuration.
    pub fn install_control(&self, mut state: crate::AppState) -> crate::AppState {
        state.execution_store = Some(self.store.clone());
        state.execution_control = Some(self.control.clone());
        state
    }

    pub fn start(self) -> ExecutionTask {
        let (shutdown, receiver) = watch::channel(false);
        let children = self.children.clone();
        let task = tokio::spawn(async move {
            if let Err(reason) = self.run(receiver).await {
                // Only static local diagnostics; never provider text, token or paths.
                eprintln!("owned execution paused: {reason}");
            }
        });
        ExecutionTask {
            shutdown,
            task,
            children,
        }
    }

    async fn current(&self) -> Result<(), &'static str> {
        if self
            .store
            .authenticate(&self.token)
            .await
            .map_err(|_| "execution authentication unavailable")?
            != Some(self.owner.clone())
        {
            return Err("execution machine session is no longer current");
        }
        Ok(())
    }
}

impl ExecutionTask {
    pub async fn shutdown(self) -> Result<(), &'static str> {
        let _ = self.shutdown.send(true);
        let mut task = self.task;
        if tokio::time::timeout(Duration::from_secs(8), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
        if !self.children.wait_empty(Duration::from_secs(2)).await {
            return Err("owned child reaping remains unconfirmed");
        }
        Ok(())
    }
}
