//! One issued metadata grant creates one owned native setup; failures never retry.
use super::*;
use orkestr_runtime::{
    containment::ChildDirectories,
    execution::{PreparingCodex, ReadyCodex},
};
use orkestr_v2_store_sqlite::BoundSessionMetadata;
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn prepare_session(
        &self,
        grant: BoundSessionMetadata,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<ReadyCodex>, &'static str> {
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
        .map_err(|_| "execution child directories unavailable")?;
        // The opaque grant selects fresh setup or exact native resume. Neither
        // caller text nor persisted status can supply a replacement identity.
        // Window execution keeps the provider's existing read-only launch.
        // Its registered project is granted only to the separate command sandbox.
        let mut launch = if self.window.is_none() {
            self.workspace_launch(&grant).await?
        } else {
            None
        };
        let mut setup = if let Some(context) = &self.window {
            let store = self.store.clone();
            let launcher = self.config.launcher.clone();
            let workspace = self.config.workspace.clone();
            let resources = self.children.retain();
            let context = context.clone();
            tokio::task::spawn_blocking(move || {
                PreparingCodex::open_window_retained(
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
            .map_err(|_| "window setup worker lost")?
        } else if let Some(launch) = launch.as_mut() {
            PreparingCodex::open_workspace_retained(
                self.store.clone(),
                grant,
                &self.token,
                launch,
                &self.config.launcher,
                directories,
                self.children.retain(),
            )
        } else {
            PreparingCodex::open_retained(
                self.store.clone(),
                grant,
                &self.config.launcher,
                &self.config.workspace,
                directories,
                self.children.retain(),
            )
        }
        .map_err(|_| "execution broker setup refused")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if *shutdown.borrow() {
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
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
                _ = shutdown.changed() => return Ok(None),
            }
        }
        let ready = setup
            .confirm()
            .await
            .map_err(|_| "execution readiness commit refused")?;
        if let Some(context) = &self.window {
            self.wait_companion_setup(shutdown, heartbeat, true).await?;
            context
                .activate_roles(
                    &self.store,
                    &self.token,
                    crate::execution_registry::ExecutionScope {
                        store: self.store.clone(),
                        control: Some(self.control.clone()),
                        tasks: self.config.worker.as_ref().map(|_| self.tasks.clone()),
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
        Ok(Some(ready))
    }
}
