//! Factory consuming a bound private window, without a token-file bootstrap.
use super::*;
use crate::{beta_config::BetaConfig, window_runtime::context::Context};
use std::{sync::Arc, time::Instant};

/// Opaque authority moved from the exact window controller, never from HTTP.
pub(crate) struct WindowSetup {
    pub store: Store,
    pub token: String,
    pub metadata: BoundSessionMetadata,
    pub workspace: Option<Arc<orkestr_v2_store_sqlite::WorkspaceGrant>>,
}

impl ConfiguredExecution {
    pub(crate) async fn from_window(
        home: &Path,
        config: &BetaConfig,
        provider: orkestr_v2_application::runtime::ProviderKind,
        setup: WindowSetup,
        context: Arc<Context>,
    ) -> Result<Self, &'static str> {
        config.validate()?;
        // A Claude conversation runs only its Deep role in this window: no
        // Codex Fast companion, Worker slots or descriptor workspace profile.
        let claude = match provider {
            orkestr_v2_application::runtime::ProviderKind::Codex => None,
            orkestr_v2_application::runtime::ProviderKind::Claude => Some(
                config
                    .claude
                    .as_ref()
                    .ok_or("Claude window runtime not configured")?,
            ),
            _ => return Err("unsupported window provider"),
        };
        let WindowSetup {
            store,
            token,
            metadata: grant,
            workspace: workspace_grant,
        } = setup;
        let workspace_exec = match config.workspace_profile().filter(|_| claude.is_none()) {
            Some(profile) => {
                let workspace = workspace_grant.as_ref().ok_or("workspace grant missing")?;
                let authority = store
                    .install_workspace_exec(&token, workspace)
                    .await
                    .map_err(|_| "workspace execution installation refused")?;
                let trusted = profile.trusted_profile(
                    home,
                    std::iter::once(config.workspace.clone()).chain(
                        config
                            .roles
                            .iter()
                            .flat_map(|roles| roles.launches().map(|r| r.workspace.clone())),
                    ),
                    config.host_full_access.as_ref(),
                )?;
                // Private per-project job records beside the server's own state.
                let jobs = home.join(format!("workspace-jobs-{}", profile.project_id));
                Some(Arc::new(
                    crate::workspace_exec::WorkspaceExecDispatcher::configured(
                        store.clone(),
                        token.clone(),
                        Arc::new(authority),
                        &profile.cgroup_root,
                        &profile.toolchain_root,
                        trusted.map(|trusted| (trusted, jobs.as_path())),
                    )?
                    .with_worker_run_ms(profile.trusted.as_ref().map(|t| t.worker_run_ms())),
                ))
            }
            None if workspace_grant.is_none() => None,
            None => return Err("workspace profile scope changed"),
        };
        let directory = directory::window_deep(home, &config.conversation_id)?;
        let owner = config.owner_id.clone();
        let mut factory = Self {
            config: Config {
                schema_version: 1,
                mode: "isolated_acceptance".into(),
                conversation_id: config.conversation_id.clone(),
                machine_token_file: PathBuf::new(),
                launcher: claude.map_or(config.launcher.clone(), |c| c.launcher.clone()),
                launcher_sha256: claude.map_or(config.launcher_sha256.clone(), |c| {
                    c.launcher_sha256.clone()
                }),
                workspace: claude.map_or(config.workspace.clone(), |c| c.workspace.clone()),
                workspace_authority: None,
                namespace: config.namespace.clone(),
                supervisor_key: config.supervisor_key.clone(),
                provider: if claude.is_some() {
                    config::Provider::Claude
                } else {
                    config::Provider::Codex
                },
                role: config::ExecutionRole::Deep,
                execution_budget: budget::ExecutionBudget {
                    // The window deadline bounds the turn; while it keeps
                    // working the window may be extended to its ceiling.
                    max_run_ms: config.window_max_lifetime_ms() as u64,
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
            workspace_exec,
            initial_grant: Some(grant),
            workspace_grant,
            window_workers: config
                .roles
                .as_ref()
                .filter(|_| claude.is_none())
                .map(|roles| {
                    crate::worker_execution::WindowWorkers::new(
                        context.clone(),
                        roles.workers.clone(),
                    )
                }),
            window: Some(context),
            companion: None,
            window_activated: std::sync::atomic::AtomicBool::new(false),
            fast_factory: None,
        };
        if claude.is_none() {
            factory.attach_window_roles(home, config)?;
        } else {
            factory.attach_claude_fast(home, config)?;
        }
        Ok(factory)
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
        self.begin_role_retirement().await?;
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
