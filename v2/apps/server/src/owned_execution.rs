//! Explicit, one-conversation isolated acceptance composition. No HTTP configuration.
mod config;
#[cfg(all(test, unix))]
mod config_tests;
use config::Config;
use orkestr_runtime::{containment::ChildDirectories, execution::PreparingCodex};
use orkestr_v2_application::runtime::{
    AdmissionDisposition, DispatchClaimResult, ProductionSupervisorConfig, ProductionTakeover,
    ProviderKind, RuntimeStore, RuntimeStoreError,
};
use orkestr_v2_contracts::{ExecutionPhase, OwnerId};
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinHandle};

/// Not serializable, clonable or constructible from a browser DTO.
pub struct ConfiguredExecution {
    config: Config,
    store: Store,
    owner: OwnerId,
    token: String,
    directory: PathBuf,
}
pub struct ExecutionTask {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
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
        Ok(Self {
            config,
            store: bound,
            owner,
            token,
            directory,
        })
    }

    pub fn start(self) -> ExecutionTask {
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(async move {
            if let Err(reason) = self.run(receiver).await {
                // Only static local diagnostics; never provider text, token or paths.
                eprintln!("owned execution paused: {reason}");
            }
        });
        ExecutionTask { shutdown, task }
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

    async fn run(self, mut shutdown: watch::Receiver<bool>) -> Result<(), &'static str> {
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
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, conversation)
            .await
            .map_err(|_| "execution ready binding unavailable")?
            .deep;
        let mut heartbeat = Instant::now();
        let claim = loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            self.current().await?;
            if heartbeat.elapsed() >= Duration::from_secs(10) {
                self.store
                    .heartbeat_supervisor()
                    .await
                    .map_err(|_| "execution supervisor heartbeat refused")?;
                heartbeat = Instant::now();
            }
            if let Some(claim) = self
                .store
                .claim_next(
                    &self.owner,
                    conversation,
                    &binding.session_id,
                    Duration::from_secs(60),
                )
                .await
                .map_err(|_| "execution inbox claim refused")?
            {
                break claim;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = shutdown.changed() => return Ok(()),
            }
        };
        self.current().await?;
        self.store
            .heartbeat_supervisor()
            .await
            .map_err(|_| "execution supervisor heartbeat refused")?;
        let key = format!("http:{}", claim.message_id);
        let admitted = self
            .store
            .admit_run(&claim, &binding.session_id, binding.generation, &key)
            .await
            .map_err(|_| "execution admission refused")?;
        if admitted.disposition != AdmissionDisposition::FreshCandidate {
            return Err("execution admission requires reconciliation");
        }
        let DispatchClaimResult::Reserved(reservation) = self
            .store
            .claim_provider_dispatch(&admitted, &key)
            .await
            .map_err(|_| "execution reservation refused")?
        else {
            return Err("execution reservation requires reconciliation");
        };
        self.current().await?;
        // Core authenticates again inside consumption and inside every transport
        // fence. This preliminary check is not the authority for provider writes.
        let ExecutionConsumption::Dispatch(capability) = self
            .store
            .consume_execution(&reservation)
            .await
            .map_err(|_| "execution consumption refused")?
        else {
            return Err("execution delivery is uncertain; automatic replay refused");
        };
        let (authority, mut pump) = ready
            .attach(self.store.clone(), capability)
            .map_err(|_| "execution attachment is uncertain; automatic replay refused")?;
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            let status = self
                .store
                .execution_status(&self.owner, conversation)
                .await
                .map_err(|_| "execution status unavailable")?
                .ok_or("execution status missing")?;
            if matches!(
                status.phase,
                ExecutionPhase::AwaitingAcceptance
                    | ExecutionPhase::Completed
                    | ExecutionPhase::Failed
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
                    .request_cancel(
                        &self.owner,
                        &admitted.provider.run.run_id,
                        "isolated-runtime-shutdown",
                    )
                    .await
                    .map_err(|_| "execution shutdown requires reconciliation")?;
                break;
            }
            self.current().await?;
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
        // One owned channel admits one turn. Completion remains AwaitingAcceptance
        // until the separate cookie-authenticated owner decision succeeds.
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
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let mut task = self.task;
        if tokio::time::timeout(Duration::from_secs(2), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
}
