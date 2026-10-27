//! Explicit isolated acceptance composition. No HTTP configuration.
mod admission;
mod beta_window;
pub(crate) use beta_window::WindowSetup;
mod bootstrap;
mod budget;
mod claude;
mod claude_continuation;
mod config;
#[cfg(all(test, unix))]
mod config_tests;
pub(crate) mod deep_slot_gates;
mod deep_slots;
pub use deep_slot_gates::{
    set_quota_file as set_parallel_deep_quota_file, QUOTA_FILE_ENV as PARALLEL_DEEP_QUOTA_FILE_ENV,
};
mod directory;
mod fast;
mod fast_bootstrap;
mod fast_continuity;
mod fast_pool;
mod fast_session;
mod group;
mod host_pressure;
pub use group::{ConfiguredExecutions, ExecutionTasks};
mod claude_fast;
mod liveness;
mod retirement;
mod session;
mod steering;
mod stopping;
mod window_roles;
mod window_task;
mod worker;
mod worker_continuation;
mod worker_retirement;
mod workspace;
use config::Config;
use orkestr_v2_application::runtime::{ProductionSupervisorConfig, ProductionTakeover};
use orkestr_v2_contracts::OwnerId;
use orkestr_v2_store_sqlite::{BoundSessionMetadata, Store};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};

/// Run budget of a window's Fast companion. Fast answers quickly; a long
/// command belongs to Deep or a Worker, and a Fast left running only holds
/// the window.
/// Static diagnostic for a refused observation: the store error variant or
/// provider blocker class only, never provider content or identifiers.
pub(crate) fn observation_refused(role: &str, error: &orkestr_runtime::supervisor::Error) {
    eprintln!("{role} observation refused by {error:?}");
}

pub(crate) const FAST_MAX_RUN_MS: u64 = 240_000;
pub(crate) use window_task::WindowTask;

/// Not serializable, clonable or constructible from a browser DTO.
pub struct ConfiguredExecution {
    config: Config,
    store: Store,
    owner: OwnerId,
    token: String,
    directory: PathBuf,
    control: crate::control_registry::ControlRegistry,
    tasks: crate::worker_tasks::WorkerTaskAccess,
    children: crate::owned_children::ChildSet,
    worker_reaps: crate::worker_execution::WorkerReaps,
    offline_python: Option<std::sync::Arc<crate::offline_python::OfflinePythonDispatcher>>,
    workspace_exec: Option<std::sync::Arc<crate::workspace_exec::WorkspaceExecDispatcher>>,
    initial_grant: Option<BoundSessionMetadata>,
    workspace_grant: Option<std::sync::Arc<orkestr_v2_store_sqlite::WorkspaceGrant>>,
    window: Option<std::sync::Arc<crate::window_runtime::context::Context>>,
    window_workers: Option<crate::worker_execution::WindowWorkers>,
    companion: Option<std::sync::Arc<window_roles::Companion>>,
    /// Claude windows activate on their first native setup only.
    window_activated: std::sync::atomic::AtomicBool,
    fast_factory: Option<Box<ConfiguredExecution>>,
    /// Read-only parallel Deep slots of this window (docs/v2/parallel-deep.md):
    /// shared by the writer (which waits for them before window close) and
    /// the slot pool.
    deep_slots: Option<std::sync::Arc<deep_slots::DeepSlots>>,
    parallel_factory: Option<Box<ConfiguredExecution>>,
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
        Self::from_config(store, home, config, false).await
    }

    async fn from_config(
        store: &Store,
        home: &Path,
        config: Config,
        scoped_directory: bool,
    ) -> Result<Self, &'static str> {
        let installation = config
            .workspace_authority
            .as_ref()
            .map(|policy| policy.installation(&config.workspace, home))
            .transpose()?;
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
            provider: config.provider.kind(),
            namespace: config.namespace.clone(),
            supervisor_key: config.supervisor_key.clone(),
            takeover: ProductionTakeover::First,
        };
        let (bound, initial_grant, directory) = if config.role == config::ExecutionRole::Fast {
            fast_bootstrap::bind(store, home, &config, &token, supervisor).await?
        } else if let Some(status) = status {
            if !matches!(
                status.phase,
                orkestr_v2_contracts::ExecutionPhase::Completed
                    | orkestr_v2_contracts::ExecutionPhase::Cancelled
            ) {
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
            let directory = if scoped_directory {
                directory::existing_for(home, &config.conversation_id)?
            } else {
                directory::existing(home)?
            };
            supervisor.takeover = ProductionTakeover::ExpiredPredecessor { incarnation_id };
            let (bound, grant) = store
                .reattach_terminal_supervisor(&token, supervisor, &prior_run)
                .await
                .map_err(|_| "execution exact predecessor reattachment refused")?;
            (bound, Some(grant), directory)
        } else {
            let directory = if scoped_directory {
                directory::create_for(home, &config.conversation_id)?
            } else {
                directory::create(home)?
            };
            let bound = store
                .authorize_supervisor(&token, supervisor)
                .await
                .map_err(|_| "execution supervisor authorization refused")?;
            (bound, None, directory)
        };
        let workspace_grant = match (&config.workspace_authority, installation) {
            (Some(policy), Some(installation)) => Some(std::sync::Arc::new(
                policy
                    .register(&bound, &token, &config.conversation_id, installation)
                    .await?,
            )),
            _ => None,
        };
        if let (Some(workspace), Some(metadata)) = (&workspace_grant, &initial_grant) {
            bound
                .bind_workspace_session(&token, workspace, metadata.binding())
                .await
                .map_err(|_| "workspace restart binding refused")?;
        }
        let offline_python = config
            .worker
            .as_ref()
            .filter(|policy| policy.offline_python_enabled())
            .map(|_| {
                crate::offline_python::OfflinePythonDispatcher::opt_in(bound.clone(), token.clone())
                    .map(std::sync::Arc::new)
            })
            .transpose()
            .map_err(|_| "offline Worker sandbox is unavailable")?;
        let control = crate::control_registry::ControlRegistry::new(
            owner.clone(),
            config.conversation_id.clone(),
        );
        let tasks = crate::worker_tasks::WorkerTaskAccess::new(
            owner.clone(),
            config.conversation_id.clone(),
        );
        let worker_reaps = crate::worker_execution::WorkerReaps::new(
            owner.clone(),
            config.conversation_id.clone(),
            config.namespace.clone(),
        );
        Ok(Self {
            config,
            store: bound,
            owner,
            token,
            directory,
            control,
            tasks,
            children: crate::owned_children::ChildSet::default(),
            offline_python,
            workspace_exec: None,
            worker_reaps,
            initial_grant,
            workspace_grant,
            window: None,
            window_workers: None,
            companion: None,
            window_activated: std::sync::atomic::AtomicBool::new(false),
            fast_factory: None,
            deep_slots: None,
            parallel_factory: None,
        })
    }

    /// Install only this factory's bound Store and live transport availability.
    /// Neither handle is constructible through HTTP configuration.
    pub fn install_control(&self, state: crate::AppState) -> Result<crate::AppState, &'static str> {
        if self.config.role == config::ExecutionRole::Fast {
            return state.with_fast_execution_scope(
                self.owner.clone(),
                self.config.conversation_id.clone(),
                crate::execution_registry::ExecutionScope {
                    store: self.store.clone(),
                    control: Some(self.control.clone()),
                    tasks: None,
                },
            );
        }
        state.with_execution_scope(
            self.owner.clone(),
            self.config.conversation_id.clone(),
            crate::execution_registry::ExecutionScope {
                store: self.store.clone(),
                control: Some(self.control.clone()),
                tasks: Some(self.tasks.clone()),
            },
        )
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

    async fn run(self, shutdown: watch::Receiver<bool>) -> Result<(), &'static str> {
        if self.config.role == config::ExecutionRole::Fast {
            return match self.config.provider {
                config::Provider::Codex => self.run_fast(shutdown).await,
                config::Provider::Claude => self.run_claude_fast(shutdown).await,
            };
        }
        match self.config.provider {
            config::Provider::Codex => self.run_codex(shutdown).await,
            config::Provider::Claude => self.run_claude(shutdown).await,
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
