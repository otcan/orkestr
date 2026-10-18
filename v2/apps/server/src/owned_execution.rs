//! Explicit, one-conversation isolated acceptance composition. No HTTP configuration.
mod admission;
mod config;
#[cfg(all(test, unix))]
mod config_tests;
pub(crate) mod control;
mod session;
mod stopping;
mod worker;
use config::Config;
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
};
use orkestr_v2_contracts::OwnerId;
use orkestr_v2_store_sqlite::Store;
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
    control: control::ControlGate,
    children: crate::owned_children::ChildSet,
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
        if status.is_some() {
            return Err(
                "queued or existing execution requires reconciliation; automatic startup refused",
            );
        }
        let directory = home.join("owned-execution");
        // A prior runtime directory is evidence to reconcile, never silently reuse.
        private_create(&directory)?;
        private_create(&directory.join("home"))?;
        private_create(&directory.join("tmp"))?;
        let bound = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: config.namespace.clone(),
                    supervisor_key: config.supervisor_key.clone(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .map_err(|_| "execution supervisor authorization refused")?;
        let control = control::ControlGate::new(owner.clone(), config.conversation_id.clone());
        Ok(Self {
            config,
            store: bound,
            owner,
            token,
            directory,
            control,
            children: crate::owned_children::ChildSet::default(),
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

fn private_create(path: &Path) -> Result<(), &'static str> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "fresh private execution directory required")
}

impl ExecutionTask {
    pub async fn shutdown(self) -> Result<(), &'static str> {
        let _ = self.shutdown.send(true);
        let mut task = self.task;
        if tokio::time::timeout(Duration::from_secs(2), &mut task)
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
