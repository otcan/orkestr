//! A distinct configured supervisor and scratch tree for the Fast native role.
use super::*;
use orkestr_runtime::containment::ChildDirectories;
use orkestr_v2_application::runtime::Role;
use std::time::Instant;

pub(super) async fn bind(
    store: &Store,
    home: &Path,
    config: &Config,
    token: &str,
    mut supervisor: ProductionSupervisorConfig,
) -> Result<(Store, Option<BoundSessionMetadata>, PathBuf), &'static str> {
    let candidate = store
        .terminal_supervisor_candidate(token, &supervisor, &config.conversation_id)
        .await
        .map_err(|_| "Fast restart discovery refused")?;
    if let Some((prior_run, incarnation_id)) = candidate {
        let directory = directory::fast(home, &config.conversation_id, true)?;
        supervisor.takeover = ProductionTakeover::ExpiredPredecessor { incarnation_id };
        let (bound, grant) = store
            .reattach_terminal_supervisor(token, supervisor, &prior_run)
            .await
            .map_err(|_| "Fast exact predecessor reattachment refused")?;
        if grant.binding().role != Role::Fast {
            return Err("Fast predecessor role changed");
        }
        Ok((bound, Some(grant), directory))
    } else {
        // Existing scratch or supervisor history refuses an unproven restart.
        // A different role's status never authorizes replacing this native child.
        let directory = directory::fast(home, &config.conversation_id, false)?;
        let bound = store
            .authorize_supervisor(token, supervisor)
            .await
            .map_err(|_| "Fast supervisor authorization refused")?;
        Ok((bound, None, directory))
    }
}

impl ConfiguredExecution {
    pub(super) async fn prepare_fast(
        &self,
        grant: BoundSessionMetadata,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<crate::fast_execution::ReadyFast>, &'static str> {
        self.maintain(heartbeat).await?;
        self.config.verify_launcher()?;
        if *shutdown.borrow() || self.fast_window_due() {
            if self.window.is_some() {
                self.store
                    .retire_bounded_fast_setup(&self.token, grant.binding())
                    .await
                    .map_err(|_| "Fast unlaunched setup retirement refused")?;
            }
            return Ok(None);
        }
        let directories = ChildDirectories::new(
            &self.config.workspace,
            &self.directory.join("home"),
            &self.directory.join("tmp"),
        )
        .map_err(|_| "Fast child directories unavailable")?;
        let mut setup = if let Some(context) = &self.window {
            let store = self.store.clone();
            let launcher = self.config.launcher.clone();
            let workspace = self.config.workspace.clone();
            let resources = self.children.retain();
            let context = context.clone();
            tokio::task::spawn_blocking(move || {
                crate::fast_execution::PreparingFast::open_window_retained(
                    store,
                    grant,
                    &launcher,
                    &workspace,
                    directories,
                    resources,
                    move |child| context.bind(&child),
                )
            })
            .await
            .map_err(|_| "Fast window setup worker lost")?
        } else {
            crate::fast_execution::PreparingFast::open_retained(
                self.store.clone(),
                grant,
                &self.config.launcher,
                &self.config.workspace,
                directories,
                self.children.retain(),
            )
        }
        .map_err(|_| "Fast broker setup refused")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if *shutdown.borrow() || self.fast_window_due() {
                self.reap_fast_setup(
                    setup
                        .retire_setup()
                        .map_err(|_| "Fast pending setup retirement refused")?,
                    heartbeat,
                )
                .await?;
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
            if setup
                .poll_ready()
                .map_err(|_| "Fast broker readiness refused")?
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("Fast broker readiness timed out");
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => {},
            }
        }
        setup
            .confirm()
            .await
            .map(Some)
            .map_err(|_| "Fast readiness commit refused")
    }
}
